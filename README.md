# Digital Window

Turn a Raspberry Pi and any TV or monitor into a "window" that plays a playlist of **YouTube videos** and **NASA space imagery** in order, on a loop. Everything streams; nothing is downloaded.

- **Admin page**, from your phone or laptop: paste a YouTube video or playlist link, search NASA's image and video library, add feeds (Astronomy Picture of the Day, live Earth photos, NASA live streams), add web pages and camera feeds, and drag to reorder.
- **Player**: runs fullscreen on the Pi. Your edits show up within a second.

---

## Install on a Raspberry Pi

**You need:** a Raspberry Pi 4 or 5, a microSD card (16 GB or more), a TV or monitor on HDMI, and an internet connection (Wi-Fi or Ethernet).

Pick one option:

| | Best for |
|---|---|
| [**A. Set it up while flashing the SD card**](#a-set-it-up-while-flashing-the-sd-card) | A new SD card. No keyboard, mouse or SSH needed. |
| [**B. One command on a Pi that's already running**](#b-one-command-on-a-pi-thats-already-running) | A Pi that already has Raspberry Pi OS with the desktop. |
| [**C. Offline bundle**](#c-offline-bundle) | Installing without the Pi cloning from GitHub. |

### A. Set it up while flashing the SD card

Needs **Raspberry Pi Imager 2.0 or newer** and **Raspberry Pi OS (64-bit) with desktop, Trixie (Nov 2025) or newer**. Those versions use *cloud-init* for first-boot setup.

1. **Flash the card.** In [Raspberry Pi Imager](https://www.raspberrypi.com/software/), choose your Pi model and **Raspberry Pi OS (64-bit)**, which is the version with the desktop. In the customisation step, set a **username and password**, your **Wi-Fi** (plus its country) and, optionally, **SSH**. Write the card.
2. **Add the installer.** When Imager finishes, take the card out and put it back in. Open the drive called **`bootfs`** and open the file **`user-data`** in a plain text editor (Notepad, TextEdit in plain-text mode, VS Code…).
3. **Paste** the contents of [`firstboot/user-data-snippet.yaml`](firstboot/user-data-snippet.yaml) at the **end** of `user-data`:
   - Leave the first line, `#cloud-config`, and everything Imager wrote.
   - If `user-data` already has a `runcmd:` or `power_state:` section, add the new lines to that section instead of creating a second one.
   - Optionally, put your free [NASA API key](https://api.nasa.gov) on the `NASA_KEY="DEMO_KEY"` line, keeping the quotes.
   - Save, then eject the card safely.
4. **Boot the Pi** with the card, the screen and the network connected. The first boot takes **5–10 minutes**. It waits for the network, installs everything, then reboots into the fullscreen player.
5. **Open the admin page** from another device on the same network: `http://<hostname>.local:3000/admin`, using the hostname you set in Imager, or `http://<pi-ip>:3000/admin`.

If the player doesn't appear, the install log is at `/var/log/digital-window-install.log` on the Pi (see [Troubleshooting](#troubleshooting)).

### B. One command on a Pi that's already running

Works on 64-bit Raspberry Pi OS **with the desktop**, Bookworm or newer. Open a terminal on the Pi, or SSH in, as your normal user (not root), and run the command below. It asks for your password once, for the steps that need `sudo`:

```bash
curl -fsSL https://raw.githubusercontent.com/meownoirsoft/lumi/main/install.sh | bash
sudo reboot
```

It asks for a NASA API key; press Enter to use the rate-limited demo key. After the reboot the player starts fullscreen. The command prints the admin address.

### C. Offline bundle

On any computer with Node 22.13+ and git:

```bash
git clone https://github.com/meownoirsoft/lumi.git && cd lumi
npm install && npm run pack                   # → dist/digital-window-<version>.tar.gz
scp dist/digital-window-*.tar.gz <user>@<pi-ip>:~
ssh <user>@<pi-ip> 'tar xzf digital-window-*.tar.gz && ./digital-window/install.sh && sudo reboot'
```

The bundle already contains its dependencies. The Pi still needs internet access to install Node.js (if it doesn't have it) and to stream content.

### What the installer does

1. Installs Node.js 22 LTS if the Pi doesn't already have 22.13 or newer.
2. Downloads the app to `~/digital-window` and writes `.env` with your NASA key and port.
3. Creates a `digital-window` system service that starts on boot and restarts if it crashes.
4. Adds the fullscreen Chromium player to the desktop's autostart (labwc, Wayfire or X11).
5. Turns off screen blanking and sets the Pi to boot to the desktop logged in. Set `SKIP_AUTOLOGIN=1` to leave boot settings alone.
6. Installs `kiosk/chromium-policy.json` as the root-owned managed policy file `/etc/chromium/policies/managed/digital-window.json`.

### Chromium policies and profile

The policy file keeps promotions, sign-in/sync, permission prompts, and other
browser nags off the player. These machine-wide policies also affect Chromium
outside the kiosk. Camera/microphone capture is blocked, but video playback and
speaker audio remain allowed. After restarting Chromium, check `chrome://policy`
for policy values and status.

The kiosk uses a private profile at `~/.config/digital-window-chromium`
(or `$XDG_CONFIG_HOME/digital-window-chromium` when set), with owner-only access.
Chromium creates it on first launch; updates retain it without copying cookies
or preferences from your normal browser. Profile setup and policies belong in
the repo, but runtime cookies, history, and credentials stay outside Git.

### Updating and removing

- **Update:** run the option B command again. It keeps your playlist (`data/`) and `.env`.
- **Server only, no fullscreen player** (for example a headless Pi that another screen points at): add `--no-kiosk`, as in `... | bash -s -- --no-kiosk`.
- **Remove:** `~/digital-window/install.sh --uninstall`, then delete `~/digital-window` if you don't want the files or playlist.

Uninstall removes the managed policy file but keeps the kiosk profile.
`--no-kiosk` leaves any previously installed policies unchanged.

### Troubleshooting

| Problem | Try |
|---|---|
| Install log says "sudo needs a password and there's no terminal" | Your SD card has an older copy of the first-boot snippet. Run the option B command in a terminal on the Pi (it asks for your password), or re-flash using the current [`firstboot/user-data-snippet.yaml`](firstboot/user-data-snippet.yaml). |
| Option A: nothing happened after 10+ minutes | SSH in (or plug in a keyboard) and run `cat /var/log/digital-window-install.log`. The most common cause is no network: check the Wi-Fi name, password and country in Imager. |
| Can't open the admin page | `systemctl status digital-window` and `journalctl -u digital-window -n 50` on the Pi. Make sure your phone or laptop is on the same network. |
| Desktop shows but no player | Check the autostart entry: `grep digital ~/.config/labwc/autostart`. You can start the player by hand with `~/digital-window/kiosk/chromium-kiosk.sh`. |
| A web page shows blank or "refused to connect" on the Pi | Update (re-run the option B command) and reboot, so the kiosk has the extension that lets it show such pages. If it's still blank, the site may need a login or block the Pi; try the camera's direct image or video address instead. |
| A video is skipped with ⚠ in the admin page | The owner disabled embedding, or the video is private, removed or region-blocked. This can't be worked around; pick another video. |
| APOD or EPIC fails sometimes | NASA rate-limits `DEMO_KEY`. Put your own key in `~/digital-window/.env` (`NASA_API_KEY=…`), then `sudo systemctl restart digital-window`. |
| "An app wants to access camera devices" dialog on the TV | Choose **Deny**. The app never uses a camera. Re-run the install command (option B) and reboot; the update turns off Chromium's camera access so the dialog doesn't come back. |
| Chromium pop-ups over the player ("Fix those tabs", what's new, sign in, translate…) | Re-run the install command (option B) and reboot. The kiosk browser uses its own clean profile, and promotions and nags are turned off. |
| Video is choppy | Update (re-run the option B command) and reboot to get H.264 video. If it's still choppy, set `KIOSK_RESOLUTION=3840x2160@30Hz` (or `1920x1080`) in `~/digital-window/.env` and reboot, and use Ethernet if Wi-Fi is weak. |
| Mouse pointer visible on the player | Update and reboot. The kiosk moves the pointer into the bottom-right corner, which makes Chromium hide it. This needs `wlrctl`, which is available on Raspberry Pi OS Trixie. On Bookworm, nudge the mouse once (or unplug it) and the pointer disappears. |
| TV doesn't turn off or on with the screen schedule | Turn on HDMI-CEC in the TV's settings, and use the HDMI port next to the Pi's power socket. If it still doesn't respond, set `KIOSK_SCREEN_POWER=dpms` (or `none`) in `~/digital-window/.env` and reboot. See [Screen schedule](#screen-schedule). |
| Screen goes black after a while | Run `sudo raspi-config` → Display Options → Screen Blanking → No. |

---

## What it plays

| Type | Plays for |
|---|---|
| YouTube video | its full length |
| YouTube playlist | every video in it, first to last, then on to your next item |
| YouTube live / NASA live preset | *Live stream duration* setting (default 30 min) |
| NASA image, APOD still | *Still image duration* (default 30 s), with a slow Ken Burns pan |
| NASA video, APOD video | its full length |
| EPIC | slideshow of the latest day's Earth images over *EPIC duration* (default 60 s; at least 2 s per image) |
| Web page, camera image, live camera stream | *Web page duration* (default 5 min) |
| Web video file | its full length |

Each item in the list has a **Play [auto] s** box: leave it on *auto* for the defaults above, or enter seconds to cut it short (or, for stills and live streams, to show it longer). YouTube and NASA videos also have a **Start** box (`90`, `1:30` or `1m30s`); a `?t=` in a pasted YouTube link fills it in.

APOD (Astronomy Picture of the Day) is re-checked each time it comes round, so it changes daily. The "NASA — whatever is live now" preset plays whatever is currently live on NASA's YouTube channel and is skipped when nothing is. To add other channels, edit `presets.json` (any `UC…` channel ID).

### Web pages and camera feeds

The **Web & cameras** tab takes any web address, or a whole HTML page pasted in. The Pi checks the link once and picks how to show it (or choose under *Show as*):

| Link | Shown as |
|---|---|
| A web page | the page, fullscreen. It can't be clicked, and it can't take the player away to another page. |
| A snapshot image (`.jpg`, `.png`, a camera's `snapshot.cgi`…) | the image. Set **Reload every** (say `5`) for a camera that updates its snapshot. |
| An MJPEG stream (`video.mjpg`, `mjpg/video.cgi`…) | live video; no reload needed |
| A video file or HLS stream (`.mp4`, `.webm`, `.m3u8`) | video, muted |

Tips for camera feeds:

- **Use the feed, not the page around it.** Many "live cam" sites wrap the picture in menus, ads and cookie banners. Right-click the picture and copy the image or video address, or find the `.m3u8` in the browser's developer tools (Network tab, filter `m3u8`). Feeds that are YouTube live streams are best added on the YouTube tab.
- **Cameras on your own network** work with just their address, for example `192.168.1.50/video.mjpg` (it assumes `http://` for IP addresses and `.local` names). A camera that needs a password usually accepts it in the link: `http://user:pass@192.168.1.50/snapshot.jpg`. Anyone who can open the admin page can see links in the playlist.
- **Sites that refuse to be shown inside another page** (they send `X-Frame-Options` or a CSP `frame-ancestors`) still show on the Pi: the kiosk loads a small extension ([`kiosk/frame-extension`](kiosk/frame-extension)) that lifts that restriction for embedded pages, and lets the player read HLS streams whose servers don't allow other sites (CORS). It only affects the kiosk's own browser profile. In an ordinary browser, *Open player* may show such a page blank; the admin page flags these.
- **Sound:** videos and streams are muted, but a web page that plays sound by itself will be heard.
- Pasted HTML runs in a sandbox with no access to the app, so it can't change the playlist.

### 4K and smooth video on a Pi

- **The screen stays at your TV's resolution, for example 4K.** NASA stills and APOD pictures are shown at full sharpness.
- **YouTube plays as H.264.** The kiosk loads a small built-in extension ([`kiosk/h264-extension`](kiosk/h264-extension)) that makes YouTube send H.264 instead of VP9 or AV1. A Pi 5 has no hardware decoder for those formats, and decoding 4K VP9 or AV1 on its CPU is what makes video choppy. YouTube's H.264 goes up to **1080p**, which is scaled up to the 4K screen. True 4K YouTube needs a device with hardware VP9/AV1 decoding.
- **Still choppy?** Set `KIOSK_RESOLUTION` in `~/digital-window/.env` and reboot. `3840x2160@30Hz` is 4K with half the redraw work; `1920x1080` is the smoothest.
- **More powerful hardware** (for example a mini PC that can decode VP9/AV1): set `KIOSK_H264=0` to let YouTube send 4K.

### Screen schedule

In the admin page's **Screen** panel, tick *Turn the screen on and off on a schedule* and set on and off times for each day (for example weekdays 08:00–18:00, weekends off). Times use the Pi's clock and time zone, which the panel shows. An off time earlier than the on time runs past midnight.

**Turn off now / Turn on now** overrides the schedule until its next change: leave early and switch off, and it comes back on at the next scheduled on time.

While the screen is off, the player stops and shows black, so nothing streams. On the Pi the kiosk also puts the display itself to sleep, chosen by `KIOSK_SCREEN_POWER` in `~/digital-window/.env`:

| Value | What happens |
|---|---|
| `both` (default) | HDMI-CEC tells the TV to go to standby (and wakes it and switches to the Pi's input later), and the Pi stops sending a picture |
| `cec` | HDMI-CEC only. Use this if the TV wakes up or complains about "no signal" when the picture stops |
| `dpms` | Stop the picture only. Right for computer monitors, which sleep without a signal |
| `none` | Leave the display on; the player just shows black |

CEC needs to be turned on in the TV's settings (it's often called Anynet+, Bravia Sync, SimpLink or similar). Re-run the installer after updating so the Pi has `cec-ctl` and `wlopm`, then reboot. To check it, run `~/digital-window/kiosk/screen-power.sh off` (and `on`) in a terminal on the Pi's desktop; what the schedule did is in `journalctl -t digital-window-screen`.

Tips:
- The player reloads itself once a day to keep a long-running browser healthy.
- On a computer, press → in the player to skip and `r` to reload.

## Why YouTube works here when Anthias/Yodeck often fail

YouTube now refuses embeds that arrive without a proper origin or `Referer`. Players that load the iframe from `file://` or from a bare webview see "Video unavailable" or "Error 153". This app:

- serves the player over real `http://`, with `referrerpolicy="strict-origin-when-cross-origin"`
- drives the official **IFrame Player API**, so it knows when a video ends (and advances at that moment) or errors
- skips anything it can't play (embedding disabled, removed, stalled, offline). The reason appears as a ⚠ on that item in the admin page.

Embedding-disabled videos are also caught when you add them, through YouTube's oEmbed check.

## Run it on any computer

```bash
git clone https://github.com/meownoirsoft/lumi.git && cd lumi
npm install
cp .env.example .env      # optional: add a free NASA_API_KEY from https://api.nasa.gov
npm start                 # admin: http://localhost:3000/admin  · player: http://localhost:3000/player
```

Requires Node 22.13+. Data is stored in `data/window.db`, using Node's built-in SQLite, so there's nothing native to compile.

## Security note

There's no login. Anyone on your network who can reach port 3000 can edit the playlist. Keep it on a trusted home or office network, or put it behind a reverse proxy with authentication.

## Development

```bash
npm run dev     # restarts on file changes
npm test        # parser, web-link + database tests
npm run pack    # build a release bundle in dist/
```
