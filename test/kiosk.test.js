import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../kiosk/chromium-kiosk.sh', import.meta.url));

test('Chromium policy retains verified kiosk settings and existing safeguards', () => {
  const policy = JSON.parse(readFileSync(new URL('../kiosk/chromium-policy.json', import.meta.url), 'utf8'));
  assert.deepEqual(policy, {
    VideoCaptureAllowed: false,
    AudioCaptureAllowed: false,
    DefaultGeolocationSetting: 2,
    DefaultNotificationsSetting: 2,
    PromotionsEnabled: false,
    BrowserSignin: 0,
    SyncDisabled: true,
    DefaultBrowserSettingEnabled: false,
    TranslateEnabled: false,
    PasswordManagerEnabled: false,
    MetricsReportingEnabled: false,
    TabOrganizerSettings: 2,
  });
});

for (const customConfig of [false, true]) {
  test(`kiosk isolates its profile (${customConfig ? 'custom XDG_CONFIG_HOME' : 'default location'})`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'digital-window-kiosk-test-'));
    try {
      const bin = join(dir, 'bin');
      const home = join(dir, 'home');
      const config = customConfig ? join(dir, 'custom config') : join(home, '.config');
      const profile = join(config, 'digital-window-chromium');
      mkdirSync(bin);
      mkdirSync(join(profile, 'Default'), { recursive: true });
      const prefs = join(profile, 'Default', 'Preferences');
      writeFileSync(prefs, '{"exited_cleanly":false,"exit_type":"Crashed"}');
      const regular = join(home, '.config', 'chromium', 'Default', 'Preferences');
      mkdirSync(join(home, '.config', 'chromium', 'Default'), { recursive: true });
      writeFileSync(regular, '{"exited_cleanly":false,"exit_type":"Crashed"}');
      for (const [name, body] of Object.entries({
        curl: 'exit 0',
        unclutter: 'exit 0',
        'chromium-browser': 'printf "%s\\n" "$@" > "$KIOSK_TEST_ARGS"',
      })) {
        writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      }
      const argsFile = join(dir, 'args');
      const env = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, KIOSK_TEST_ARGS: argsFile };
      delete env.XDG_CONFIG_HOME;
      if (customConfig) env.XDG_CONFIG_HOME = config;
      const result = spawnSync('bash', [launcher, 'http://localhost:4321/player'], { env, encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      const args = readFileSync(argsFile, 'utf8').trim().split('\n');
      assert.ok(args.includes(`--user-data-dir=${profile}`));
      assert.ok(args.includes('--kiosk'));
      assert.ok(args.includes('http://localhost:4321/player'));
      assert.ok(args.includes('--autoplay-policy=no-user-gesture-required'));
      assert.ok(args.includes('--disable-features=Translate,WebRtcPipeWireCamera,ChromeWhatsNewUI'));
      const kioskDir = fileURLToPath(new URL('../kiosk', import.meta.url));
      assert.ok(args.includes('--remote-debugging-port=9222'));
      assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
      assert.ok(args.includes(`--load-extension=${kioskDir}/frame-extension,${kioskDir}/h264-extension`));
      assert.equal(statSync(profile).mode & 0o777, 0o700);
      assert.deepEqual(JSON.parse(readFileSync(prefs, 'utf8')), { exited_cleanly: true, exit_type: 'Normal' });
      assert.deepEqual(JSON.parse(readFileSync(regular, 'utf8')), { exited_cleanly: false, exit_type: 'Crashed' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
