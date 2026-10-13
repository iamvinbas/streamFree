// Release check for macOS/Windows: the native app (system WebView) hosts a
// 40-second smoke recording while a Chrome guest joins over WebRTC, goes on
// stage and receives the program, and a second guest with no direct path
// joins through the relay.
//
//   cargo build && (cd tests/e2e && npm run test:native)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const tmp = mkdtempSync(join(tmpdir(), 'streamfree-native-'));
const child = spawn('../../target/debug/streamfree', ['--smoke-test', '40', '--port', '8960', '--data-dir', `${tmp}/data`, '--recordings-dir', `${tmp}/rec`], { stdio: ['ignore', 'pipe', 'pipe'] });
let err = ''; child.stderr.on('data', (d) => (err += d));
process.on('exit', () => writeFileSync(`${tmp}/app-stderr.log`, err));
let out = ''; child.stdout.on('data', (d) => (out += d));
const exited = new Promise((r) => child.on('exit', r));
for (let i = 0; i < 100 && !out.includes('Invite link:'); i++) await new Promise((r) => setTimeout(r, 100));
const invite = out.match(/Invite link:\s+(\S+)/)[1];
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const g = await (await b.newContext({ permissions: ['camera', 'microphone'], locale: 'en-US' })).newPage();
const errors = []; g.on('pageerror', (e) => errors.push(e.message));
await g.goto(invite);
await g.fill('input[aria-label="Your name"]', 'Chrome guest');
await g.click('button[type=submit]');
await g.waitForFunction(() => window.streamFreeGuest.pc?.connectionState === 'connected', null, { timeout: 20000 });
await g.waitForFunction(() => { const v = document.querySelector('#program'); return v && v.videoWidth > 0 && v.srcObject?.getAudioTracks().length === 1; }, null, { timeout: 20000 });
await g.waitForFunction(() => window.streamFreeGuest.onStage === true, null, { timeout: 10000 });
const frames = await g.evaluate(async () => {
  const v = document.querySelector('#program');
  const q0 = v.getVideoPlaybackQuality().totalVideoFrames;
  await new Promise((r) => setTimeout(r, 3000));
  return v.getVideoPlaybackQuality().totalVideoFrames - q0;
});
const toasts = await g.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent));
console.log('guest connected + on stage; program frames received in 3 s:', frames, '| errors:', JSON.stringify(errors), '| toasts:', JSON.stringify(toasts));
if (frames < 20 || errors.length) { console.log('FAIL'); process.exitCode = 1; }

// A guest whose network allows no direct connection: the WebView host must
// switch it to the relay, decode its video (it confirms with relay-ok) and
// send it the program.
const rctx = await b.newContext({ permissions: ['camera', 'microphone'], locale: 'en-US' });
await rctx.addInitScript(() => {
  const Orig = window.RTCPeerConnection;
  window.RTCPeerConnection = function (config = {}) { return new Orig({ ...config, iceTransportPolicy: 'relay' }); };
  window.RTCPeerConnection.prototype = Orig.prototype;
});
const r = await rctx.newPage();
const rErrors = []; r.on('pageerror', (e) => rErrors.push(e.message));
await r.goto(invite);
await r.fill('input[aria-label="Your name"]', 'Relay guest');
await r.click('button[type=submit]');
let relay = null;
try {
  await r.waitForFunction(() => { const s = window.streamFreeGuest.relay; return s && s.videoFrames > 20 && s.hostReceiving; }, null, { timeout: 25000 });
} catch {
  // reported below
}
relay = await r.evaluate(() => window.streamFreeGuest.relay);
console.log('relay guest:', JSON.stringify(relay), '| errors:', JSON.stringify(rErrors));
if (!relay || relay.videoFrames < 20 || !relay.hostReceiving || rErrors.length) { console.log('FAIL (relay)'); process.exitCode = 1; }
await exited;
console.log(out.split('\n').filter((l) => l.includes('smoke')).join('\n'));
const code = await exited.then((c) => c);
if (err.includes('smoke test:')) console.log(err.split('\n').filter((l) => l.includes('smoke')).join('\n'));
console.log(`recording in ${tmp}/rec`);
await b.close();
