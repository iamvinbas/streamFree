// Browser end-to-end tests: a real Chrome with a fake camera and microphone
// drives the studio; FFmpeg/ffprobe check what streamFree produced.
//
//   cargo build && (cd tests/e2e && npm install && npm test)
//
// Needs Google Chrome (or STREAMFREE_CHROME=/path/to/chrome) and ffmpeg.

import { chromium } from 'playwright-core';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const ROOT = resolve(import.meta.dirname, '../..');
const BIN = process.env.STREAMFREE_BIN || join(ROOT, 'target/debug/streamfree');
const SECONDS = Number(process.env.E2E_SECONDS || 6);
const work = mkdtempSync(join(tmpdir(), 'streamfree-e2e-'));
const children = [];
let failures = 0;

function freePort() {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  const port = await freePort();
  const child = spawn(BIN, [
    '--port', String(port), '--no-open',
    '--data-dir', join(work, 'data'), '--recordings-dir', join(work, 'recordings'),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(d));
  for (let i = 0; i < 100 && !out.includes('Invite link:'); i++) await sleep(100);
  const studio = out.match(/Studio:\s+(\S+)/)?.[1];
  const invite = out.match(/Invite link:\s+(\S+)/)?.[1];
  assert.ok(studio && invite, `server did not start:\n${out}`);
  const token = new URL(studio).searchParams.get('t');
  return { port, studio, invite, token, base: `http://localhost:${port}` };
}

function rtmpSink(port, file) {
  const child = spawn('nice', ['-n', '19', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-listen', '1', '-f', 'flv',
    '-i', `rtmp://127.0.0.1:${port}/live/test`, '-c', 'copy', '-f', 'flv', file], { stdio: 'ignore' });
  children.push(child);
  return new Promise((res) => child.on('exit', res));
}

function probe(file) {
  const json = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
    'stream=codec_name,width,height,nb_read_frames,start_time,duration:format=duration', '-of', 'json', file]);
  const v = JSON.parse(json);
  const video = v.streams.find((s) => s.codec_name === 'h264') || {};
  const audio = v.streams.find((s) => s.codec_name === 'aac') || {};
  const span = (s) => [Number(s.start_time || 0), Number(s.start_time || 0) + Number(s.duration || 0)];
  return {
    codecs: v.streams.map((s) => s.codec_name),
    duration: Number(v.format.duration),
    frames: Number(video.nb_read_frames || 0),
    width: video.width,
    videoSpan: span(video),
    audioSpan: span(audio),
  };
}

function decodeErrors(file) {
  // The stream is variable frame rate (one frame per compositor tick), so keep
  // timestamps as they are instead of converting to a constant frame rate.
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-fps_mode', 'passthrough', '-f', 'null', '-'], { encoding: 'utf8' });
  return r.status === 0 ? r.stderr : `exit ${r.status}: ${r.stderr}`;
}

// Smallest gap between consecutive video frames, in seconds.
function minFrameGap(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file]).toString();
  const pts = out.split('\n').filter((l) => l.trim() !== '').map((l) => Number(l.split(',')[0])).filter(Number.isFinite).sort((a, b) => a - b);
  let gap = Infinity;
  for (let i = 1; i < pts.length; i++) gap = Math.min(gap, pts[i] - pts[i - 1]);
  return gap;
}

function checkMedia(file, label) {
  const info = probe(file);
  // Frames come from a ~33 ms clock; bunched frames mean the scheduler burst.
  const gap = minFrameGap(file);
  assert.ok(gap > 0.012, `${label}: frames only ${(gap * 1000).toFixed(1)} ms apart`);
  assert.deepEqual(info.codecs, ['h264', 'aac'], `${label}: codecs`);
  assert.ok(Math.abs(info.duration - SECONDS) < 1.5, `${label}: duration ${info.duration}s, expected ~${SECONDS}s`);
  // 30 fps target; allow for start-up and a busy CI machine.
  assert.ok(info.frames >= SECONDS * 30 * 0.8, `${label}: only ${info.frames} video frames`);
  // Audio and video must cover the same time span: a constant offset here
  // means lip sync is off. (FLV files report no per-stream duration.)
  if (file.endsWith('.mp4')) {
    const [vs, ve] = info.videoSpan;
    const [as, ae] = info.audioSpan;
    assert.ok(Math.abs(vs - as) < 0.35 && Math.abs(ve - ae) < 0.35,
      `${label}: audio ${as.toFixed(2)}–${ae.toFixed(2)}s vs video ${vs.toFixed(2)}–${ve.toFixed(2)}s`);
  }
  const errors = decodeErrors(file).trim();
  assert.equal(errors, '', `${label}: decode errors: ${errors}`);
  return info;
}

async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n     ${e.stack || e}`);
  }
}

async function waitFor(page, fn, arg, timeout = 15000) {
  await page.waitForFunction(fn, arg, { timeout, polling: 100 });
}

const browser = await chromium.launch({
  channel: process.env.STREAMFREE_CHROME ? undefined : 'chrome',
  executablePath: process.env.STREAMFREE_CHROME,
  headless: !process.env.E2E_HEADED,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const server = await startServer();
const api = (method, path, body) => fetch(server.base + path, {
  method, headers: { 'x-streamfree-token': server.token, 'content-type': 'application/json' }, body: body && JSON.stringify(body),
}).then(async (r) => (r.ok ? (r.status === 204 ? null : r.json()) : Promise.reject(new Error(await r.text()))));

const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
const studio = await ctx.newPage();
const pageErrors = [];
studio.on('pageerror', (e) => pageErrors.push(e.message));
studio.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
await studio.goto(server.studio);
await waitFor(studio, () => window.streamFree?.people.get('host')?.stream?.getVideoTracks().length === 1);

await test('host starts on stage', async () => {
  assert.deepEqual(await studio.evaluate(() => window.streamFree.stage), ['host']);
});

await test('studio records an MP4 with H.264 + AAC', async () => {
  await studio.evaluate(() => window.streamFree.showBanner('Hello', 'end-to-end test'));
  await studio.evaluate(() => window.streamFree.startBroadcast('record', []));
  await waitFor(studio, () => window.streamFree.live.state === 'live');
  await sleep(SECONDS * 1000);
  await studio.evaluate(() => window.streamFree.stopBroadcast());
  await waitFor(studio, () => window.streamFree.live.state === 'idle', null, 30000);
  const files = readdirSync(join(work, 'recordings')).filter((f) => f.endsWith('.mp4'));
  assert.equal(files.length, 1, `recordings: ${files}`);
  const info = checkMedia(join(work, 'recordings', files[0]), 'recording');
  assert.equal(info.width, 1280);
});

await test('studio streams to two RTMP destinations at once', async () => {
  const ports = [await freePort(), await freePort()];
  const files = ports.map((p) => join(work, `sink-${p}.flv`));
  const exits = ports.map((p, i) => rtmpSink(p, files[i]));
  await sleep(500);
  const ids = [];
  for (const [i, port] of ports.entries()) {
    const d = await api('POST', '/api/destinations', { name: `Sink ${i + 1}`, platform: 'custom', url: `rtmp://127.0.0.1:${port}/live`, key: 'test' });
    assert.equal(d.hasKey, true);
    assert.ok(!JSON.stringify(d).includes('"key"'), 'stream key must not be returned');
    ids.push(d.id);
  }
  await studio.evaluate((ids) => window.streamFree.startBroadcast('live', ids), ids);
  await waitFor(studio, () => window.streamFree.live.status?.outputs?.every((o) => o.state === 'live'), null, 20000);
  await sleep(SECONDS * 1000);
  await studio.evaluate(() => window.streamFree.stopBroadcast());
  await waitFor(studio, () => window.streamFree.live.state === 'idle', null, 30000);
  await Promise.race([Promise.all(exits), sleep(15000)]);
  files.forEach((f, i) => checkMedia(f, `destination ${i + 1}`));
});

await test('guest joins over WebRTC, goes on stage and receives the program', async () => {
  const guestCtx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const guest = await guestCtx.newPage();
  await guest.goto(server.invite);
  await guest.fill('input[aria-label="Your name"]', 'Ada');
  await guest.click('button[type=submit]');
  await waitFor(studio, () => [...window.streamFree.people.values()].some((p) => p.kind === 'guest' && p.name === 'Ada'));
  const id = await studio.evaluate(() => [...window.streamFree.people.values()].find((p) => p.name === 'Ada').id);
  await waitFor(guest, () => window.streamFreeGuest.pc?.connectionState === 'connected', null, 20000);
  await waitFor(studio, (id) => window.streamFree.people.get(id).stream.getVideoTracks().length === 1, id);
  await studio.evaluate((id) => window.streamFree.toggleStage(id), id);
  await waitFor(guest, () => window.streamFreeGuest.onStage === true);
  // The guest receives the program video and the mix-minus audio.
  await waitFor(guest, () => {
    const v = document.querySelector('#program');
    return v && v.videoWidth > 0 && v.srcObject?.getAudioTracks().length === 1;
  }, null, 20000);
  assert.ok(await studio.evaluate((id) => window.streamFree.stage.includes(id), id));
  await guestCtx.close();
  await waitFor(studio, (id) => !window.streamFree.people.has(id), id);
});

await test('stream keeps its frame rate with another tab in front', async () => {
  // Note: Playwright keeps pages "visible" (it emulates focus), so this test
  // only proves the worker-driven pipeline runs with another tab in front.
  const other = await ctx.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  const hidden = await studio.evaluate(() => document.visibilityState);
  await studio.evaluate(() => window.streamFree.startBroadcast('record', []));
  await waitFor(studio, () => window.streamFree.live.state === 'live');
  await sleep(SECONDS * 1000);
  await studio.evaluate(() => window.streamFree.stopBroadcast());
  await waitFor(studio, () => window.streamFree.live.state === 'idle', null, 30000);
  await other.close();
  const dir = join(work, 'recordings');
  const newest = readdirSync(dir).filter((f) => f.endsWith('.mp4'))
    .sort((a, b) => statSync(join(dir, a)).mtimeMs - statSync(join(dir, b)).mtimeMs).at(-1);
  checkMedia(join(dir, newest), `recording with tab ${hidden}`);
  if (hidden !== 'hidden') console.log(`     note: the page reported "${hidden}", so Chrome's background throttling was not exercised`);
});

await test('no uncaught errors in the studio page', async () => {
  assert.deepEqual(pageErrors, []);
});

await browser.close();
for (const c of children) c.kill('SIGTERM');
if (!process.env.E2E_KEEP) rmSync(work, { recursive: true, force: true });
else console.log(`kept ${work}`);
console.log(failures ? `${failures} test(s) failed` : 'all browser tests passed');
process.exit(failures ? 1 : 0);
