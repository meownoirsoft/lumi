#!/usr/bin/env bash
# Opens the player fullscreen. Launched at login by the autostart entry (see README).
URL="${1:-http://localhost:3000/player}"
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# Settings from the app's .env:
#   KIOSK_RESOLUTION  "auto" (default: keep the TV's choice, e.g. 4K), or a mode
#                     like 1920x1080 or 3840x2160@30Hz
#   KIOSK_H264        1 (default) = make YouTube send H.264; 0 = allow VP9/AV1
setting() { sed -n "s/^$1=//p" "$HERE/../.env" 2>/dev/null | tail -1; }
RES=$(setting KIOSK_RESOLUTION); RES=${RES:-auto}
H264=$(setting KIOSK_H264); H264=${H264:-1}
#   KIOSK_DEBUG_PORT  DevTools port (default 9222, localhost only) the app uses
#                     to click inside web pages and screenshot the TV
DEBUG_PORT=$(setting KIOSK_DEBUG_PORT); DEBUG_PORT=${DEBUG_PORT:-9222}

# A profile used only by the kiosk: no saved tabs, sessions or sign-in from the
# desktop browser, so Chromium has nothing to restore, sync or nag about.
PROFILE="${XDG_CONFIG_HOME:-$HOME/.config}/digital-window-chromium"
mkdir -p -m 0700 "$PROFILE" || exit 1
chmod 0700 "$PROFILE" || exit 1

# Wait for the server to come up.
until curl -fsS -o /dev/null "$URL"; do sleep 2; done

# Hide the mouse pointer. The player page sets `cursor: none`, but the browser
# only applies that once the pointer moves over the page, so after Chromium
# opens we push the pointer to the bottom-right corner. That movement makes
# Chromium hide it entirely; at worst a single pixel is left in the corner.
park_cursor() {
  if [ -n "${WAYLAND_DISPLAY:-}" ] && command -v wlrctl >/dev/null; then
    wlrctl pointer move 100000 100000
  elif [ -n "${DISPLAY:-}" ] && command -v xdotool >/dev/null; then
    xdotool mousemove 100000 100000
  fi
}
# This script execs Chromium below, so $$ becomes Chromium's PID; the loop
# stops once Chromium exits instead of grabbing the mouse forever.
kiosk_pid=$$
(
  # A few times while Chromium starts and the page loads, then every few
  # minutes so it stays hidden after the player's daily reload.
  for delay in 5 10 20 30; do
    sleep "$delay"; kill -0 "$kiosk_pid" 2>/dev/null || exit; park_cursor
  done
  while sleep 300 && kill -0 "$kiosk_pid" 2>/dev/null; do park_cursor; done
) >/dev/null 2>&1 &
command -v unclutter >/dev/null && unclutter -idle 0.5 -root &

# Put the display to sleep outside the screen schedule set in the admin page.
ORIGIN=$(printf '%s' "$URL" | sed -E 's#^([a-z]+://[^/]+).*#\1#')
# Its messages go to the system log: journalctl -t digital-window-screen
if command -v logger >/dev/null; then
  "$HERE/screen-power.sh" follow "$ORIGIN/api/screen/power" "$kiosk_pid" 2>&1 </dev/null | logger -t digital-window-screen >/dev/null 2>&1 &
else
  "$HERE/screen-power.sh" follow "$ORIGIN/api/screen/power" "$kiosk_pid" </dev/null >/dev/null 2>&1 &
fi

if [ "$RES" != auto ]; then
  if [ -n "${WAYLAND_DISPLAY:-}" ] && command -v wlr-randr >/dev/null; then
    for out in $(wlr-randr | awk '/^[^ ]/ {print $1}'); do
      wlr-randr --output "$out" --mode "$RES" 2>/dev/null || echo "kiosk: $out has no $RES mode; leaving it" >&2
    done
  elif [ -n "${DISPLAY:-}" ] && command -v xrandr >/dev/null; then
    size=${RES%@*}; rate=${RES#*@}; rate=${rate%Hz}
    for out in $(xrandr | awk '/ connected/ {print $1}'); do
      if [ "$size" = "$RES" ]; then set -- --mode "$size"; else set -- --mode "$size" --rate "$rate"; fi
      xrandr --output "$out" "$@" 2>/dev/null || echo "kiosk: $out has no $RES mode; leaving it" >&2
    done
  fi
fi

# Stop Chromium showing "restore pages?" after a power cut.
PREFS="$PROFILE/Default/Preferences"
[ -f "$PREFS" ] && sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' "$PREFS"

# --disable-features (Chromium only honours one such switch, so keep them together):
#   WebRtcPipeWireCamera  stops "An app wants to access camera devices" dialogs;
#                         Chromium asks the desktop's camera portal whenever a page
#                         lists media devices, and a display has no camera.
#   ChromeWhatsNewUI      no "What's new" tab after Chromium updates.
#   Translate             no "translate this page?" bar.
# Promotions and feature tours are also turned off by the Chromium policy the
# installer writes to /etc/chromium/policies/managed/digital-window.json.
#
# h264-extension makes YouTube send H.264 instead of VP9/AV1. The Pi 5 decodes
# all of these in software, and H.264 is by far the lightest, so video plays
# smoothly instead of dropping frames. (YouTube's H.264 tops out at 1080p, which
# Chromium scales up to a 4K screen.)
#
# frame-extension lets the player show web pages and camera sites that ask not
# to be shown inside another page (X-Frame-Options / CSP frame-ancestors), and
# lets it read HLS camera streams that don't send CORS headers. It only affects
# this kiosk profile.
EXTENSIONS="$HERE/frame-extension"
[ "$H264" = 0 ] || EXTENSIONS="$EXTENSIONS,$HERE/h264-extension"

BROWSER=$(command -v chromium-browser || command -v chromium)
exec "$BROWSER" \
  --kiosk "$URL" \
  --user-data-dir="$PROFILE" \
  --noerrdialogs --disable-infobars --no-first-run --no-default-browser-check \
  --disable-session-crashed-bubble \
  --disable-features=Translate,WebRtcPipeWireCamera,ChromeWhatsNewUI \
  --autoplay-policy=no-user-gesture-required \
  --deny-permission-prompts \
  --check-for-update-interval=31536000 \
  --password-store=basic \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port="$DEBUG_PORT" \
  --load-extension="$EXTENSIONS"
