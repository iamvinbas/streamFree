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

const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], locale: 'en-US' });
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
  const guestCtx = await browser.newContext({ permissions: ['camera', 'microphone'], locale: 'en-US' });
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


// ---------------------------------------------------------------- guests

const sharingStatus = () => api('GET', '/api/sharing');

async function joinGuest(url, name, extra = {}) {
  const gctx = await browser.newContext({ permissions: ['camera', 'microphone'], locale: 'en-US', ...extra });
  const page = await gctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.fill('input[aria-label="Your name"]', name);
  await page.click('button[type=submit]');
  return { ctx: gctx, page, errors };
}

const guestId = (name) => studio.evaluate((n) => [...window.streamFree.people.values()].find((p) => p.kind === 'guest' && p.name === n)?.id, name);

async function receivesProgram(page, timeout = 20000) {
  await waitFor(page, () => window.streamFreeGuest.pc?.connectionState === 'connected', null, timeout);
  await waitFor(page, () => {
    const v = document.querySelector('#program');
    return v && v.videoWidth > 0 && v.srcObject?.getAudioTracks().length === 1;
  }, null, timeout);
}

await test('three guests at once, each hearing everyone but themselves', async () => {
  const { inviteUrl } = await sharingStatus();
  const guests = [];
  for (const name of ['Ada', 'Grace', 'Linus']) guests.push(await joinGuest(inviteUrl, name));
  for (const g of guests) await receivesProgram(g.page);
  const ids = [];
  for (const name of ['Ada', 'Grace', 'Linus']) {
    await waitFor(studio, (n) => [...window.streamFree.people.values()].some((p) => p.name === n && p.stream.getAudioTracks().length === 1), name);
    ids.push(await guestId(name));
  }
  for (const id of ids) await studio.evaluate((i) => window.streamFree.toggleStage(i), id);
  const routing = await studio.evaluate(() => window.streamFree.routing());
  for (const id of ids) {
    assert.ok(!routing[id].includes(`guest:${id}`), `guest ${id} must not hear itself: ${routing[id]}`);
    for (const other of ids.filter((x) => x !== id)) assert.ok(routing[id].includes(`guest:${other}`), `${other} must hear ${id}`);
    assert.ok(routing[id].includes('program'), 'a guest on stage is in the program');
    assert.ok(routing.host.includes(`guest:${id}`), 'every guest hears the host');
  }
  assert.ok(!routing.host.includes('monitor'), 'the host does not hear their own microphone');
  for (const g of guests) {
    assert.deepEqual(g.errors, []);
    await g.ctx.close();
  }
  for (const id of ids) await waitFor(studio, (i) => !window.streamFree.people.has(i), id);
});

await test('backstage chat works both ways', async () => {
  const { inviteUrl } = await sharingStatus();
  const g = await joinGuest(inviteUrl, 'Chatty');
  await receivesProgram(g.page);
  await studio.evaluate(() => window.streamFree.sendChat('hello from the host'));
  await waitFor(g.page, () => document.querySelector('#guest-chat')?.textContent.includes('hello from the host'));
  await g.page.fill('input[aria-label="Message the host"]', 'hi host');
  await g.page.press('input[aria-label="Message the host"]', 'Enter');
  await waitFor(studio, () => window.streamFree.backstageChat.some((m) => m.author === 'Chatty' && m.text === 'hi host'));
  await g.ctx.close();
});

await test('the host can remove a guest; a guest can leave and come back', async () => {
  const { inviteUrl } = await sharingStatus();
  const g = await joinGuest(inviteUrl, 'Kicked');
  await receivesProgram(g.page);
  const id = await guestId('Kicked');
  await studio.evaluate((i) => window.streamFree.kick(i), id);
  await waitFor(g.page, () => document.body.textContent.includes('removed you from the studio'));
  await waitFor(studio, (i) => !window.streamFree.people.has(i), id);
  // Leave, then rejoin from the same page.
  await g.page.click('text=Join again');
  await g.page.fill('input[aria-label="Your name"]', 'Returning');
  await g.page.click('button[type=submit]');
  await receivesProgram(g.page);
  await waitFor(studio, () => [...window.streamFree.people.values()].some((p) => p.name === 'Returning'));
  await g.page.click('button[aria-label="Leave"]');
  await waitFor(g.page, () => document.body.textContent.includes('You left the studio'));
  await waitFor(studio, () => ![...window.streamFree.people.values()].some((p) => p.name === 'Returning'));
  await g.ctx.close();
});

// A guest on a network that allows no direct connection (strict NATs,
// firewalls, many mobile networks): only relay candidates are allowed and no
// TURN server is configured, so WebRTC cannot connect and the host must
// switch the guest to the streamFree relay.
async function joinRelayOnlyGuest(url, name) {
  const gctx = await browser.newContext({ permissions: ['camera', 'microphone'], locale: 'en-US' });
  await gctx.addInitScript(() => {
    const Orig = window.RTCPeerConnection;
    window.RTCPeerConnection = function (config = {}) {
      return new Orig({ ...config, iceTransportPolicy: 'relay' });
    };
    window.RTCPeerConnection.prototype = Orig.prototype;
  });
  const page = await gctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.fill('input[aria-label="Your name"]', name);
  await page.click('button[type=submit]');
  return { ctx: gctx, page, errors };
}

// The guest gets the program and its mix-minus, and the host decodes the
// guest's video (it confirms with relay-ok).
async function receivesRelay(page, timeout = 30000) {
  await waitFor(page, () => {
    const r = window.streamFreeGuest.relay;
    return r && r.videoFrames > 20 && r.audioPackets > 20 && r.hostReceiving;
  }, null, timeout);
}

function newestRecording() {
  const dir = join(work, 'recordings');
  const newest = readdirSync(dir).filter((f) => f.endsWith('.mp4'))
    .sort((a, b) => statSync(join(dir, a)).mtimeMs - statSync(join(dir, b)).mtimeMs).at(-1);
  return join(dir, newest);
}

await test('a guest with no direct path joins through the relay', async () => {
  const { inviteUrl } = await sharingStatus();
  const g = await joinRelayOnlyGuest(inviteUrl, 'Faraway');
  await receivesRelay(g.page);
  const id = await guestId('Faraway');
  await waitFor(studio, (i) => {
    const s = window.streamFree.relayStats()[i];
    return s && s.transport === 'relay' && s.videoFrames > 20 && s.audioPackets > 20 && s.track === 'live';
  }, id, 30000);
  // The fake microphones beep once a second: both directions carry sound.
  const peak = await studio.evaluate(async (i) => {
    let max = 0;
    const end = performance.now() + 3000;
    while (performance.now() < end) {
      max = Math.max(max, window.streamFree.relayStats()[i]?.level || 0);
      await new Promise((r) => setTimeout(r, 15));
    }
    return max;
  }, id);
  assert.ok(peak > 0.01, `host hears the relayed guest (peak ${peak})`);
  assert.ok(await g.page.evaluate(() => window.streamFreeGuest.relay.audioPeak) > 0.01, 'the relayed guest hears the studio');
  await studio.evaluate((i) => window.streamFree.toggleStage(i), id);
  await waitFor(g.page, () => window.streamFreeGuest.onStage === true);
  const routing = await studio.evaluate(() => window.streamFree.routing());
  assert.ok(routing[id].includes('program'), 'the relayed guest is in the program');
  assert.ok(!routing[id].includes(`guest:${id}`), 'the relayed guest does not hear themselves');
  assert.ok(routing.host.includes(`guest:${id}`), 'the relayed guest hears the host');
  // A recording with the relayed guest on stage is as good as any other.
  await studio.evaluate(() => window.streamFree.startBroadcast('record', []));
  await waitFor(studio, () => window.streamFree.live.state === 'live');
  await sleep(SECONDS * 1000);
  await studio.evaluate(() => window.streamFree.stopBroadcast());
  await waitFor(studio, () => window.streamFree.live.state === 'idle', null, 30000);
  checkMedia(newestRecording(), 'recording with a relayed guest');
  assert.deepEqual(g.errors, []);
  await g.ctx.close();
  await waitFor(studio, (i) => !window.streamFree.people.has(i), id);
});

await test('a guest who loses the connection comes back on stage', async () => {
  const { inviteUrl } = await sharingStatus();
  const g = await joinGuest(inviteUrl, 'Wobbly');
  await receivesProgram(g.page);
  const id = await guestId('Wobbly');
  await studio.evaluate((i) => window.streamFree.toggleStage(i), id);
  await waitFor(g.page, () => window.streamFreeGuest.onStage === true);
  await g.page.evaluate(() => window.streamFreeGuest.dropConnection());
  await waitFor(studio, (old) => {
    const p = [...window.streamFree.people.values()].find((x) => x.name === 'Wobbly');
    return p && p.id !== old && window.streamFree.stage.includes(p.id);
  }, id, 20000);
  await waitFor(g.page, () => window.streamFreeGuest.onStage === true);
  await receivesProgram(g.page);
  assert.deepEqual(g.errors, []);
  await g.ctx.close();
});

await test('"Always through streamFree" sends a guest to the relay at once', async () => {
  await studio.evaluate(() => window.streamFree.setGuestTransport('relay'));
  try {
    const { inviteUrl } = await sharingStatus();
    const t0 = Date.now();
    const g = await joinGuest(inviteUrl, 'Relayed');
    await receivesRelay(g.page, 15000);
    assert.ok(Date.now() - t0 < 9000, `the relay took ${Date.now() - t0} ms`);
    assert.equal(await g.page.evaluate(() => window.streamFreeGuest.pc), null, 'no WebRTC connection');
    const id = await guestId('Relayed');
    await waitFor(studio, (i) => {
      const s = window.streamFree.relayStats()[i];
      return s && s.transport === 'relay' && s.videoFrames > 20 && s.audioPackets > 20;
    }, id);
    assert.deepEqual(g.errors, []);
    await g.ctx.close();
  } finally {
    await studio.evaluate(() => window.streamFree.setGuestTransport('auto'));
  }
});

await test('no more than 16 guests can join', async () => {
  const { inviteUrl } = await sharingStatus();
  const invite = inviteUrl.split('/join/')[1];
  const wsUrl = `ws://localhost:${server.port}/ws/guest?invite=${invite}&name=bot`;
  const open = (url) => new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve({ ws, ok: true });
    ws.onerror = () => resolve({ ws, ok: false });
  });
  const sockets = [];
  for (let i = 0; i < 16; i++) sockets.push(await open(wsUrl));
  assert.equal(sockets.filter((s) => s.ok).length, 16, '16 guests are allowed');
  const extra = await open(wsUrl);
  assert.equal(extra.ok, false, 'the 17th guest is refused');
  for (const s of sockets) s.ws.close();
  await waitFor(studio, () => ![...window.streamFree.people.values()].some((p) => p.kind === 'guest'));
});

await test('a new invite link replaces the old one', async () => {
  const before = (await sharingStatus()).inviteUrl;
  const oldInvite = before.split('/join/')[1];
  await api('POST', '/api/invite/reset');
  const after = (await sharingStatus()).inviteUrl;
  assert.notEqual(after, before);
  assert.equal((await fetch(before)).status, 404, 'old link is gone');
  assert.equal((await fetch(after)).status, 200, 'new link works');
  const refused = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws/guest?invite=${oldInvite}&name=x`);
    ws.onopen = () => { ws.close(); resolve(false); };
    ws.onerror = () => resolve(true);
  });
  assert.ok(refused, 'old link cannot join');
});

await test('guests on the local network join over HTTPS', async () => {
  const status = await api('PUT', '/api/sharing', { mode: 'lan' });
  assert.equal(status.mode, 'lan');
  assert.ok(status.inviteUrl.startsWith('https://'), status.inviteUrl);
  const g = await joinGuest(status.inviteUrl, 'Lan', { ignoreHTTPSErrors: true });
  await receivesProgram(g.page);
  await g.ctx.close();
  const back = await api('PUT', '/api/sharing', { mode: 'local' });
  assert.equal(back.mode, 'local');
  assert.ok(back.inviteUrl.startsWith('http://localhost'), 'back to local');
});

await test('guests on the internet join through the tunnel', async () => {
  let status = await api('PUT', '/api/sharing', { mode: 'internet' });
  if (!status.cloudflared) {
    await api('PUT', '/api/sharing', { mode: 'local' });
    console.log('     note: cloudflared is not installed, so the internet link was not exercised');
    return;
  }
  for (let i = 0; i < 60 && status.tunnel.state === 'starting'; i++) {
    await sleep(1000);
    status = await sharingStatus();
  }
  assert.equal(status.tunnel.state, 'on', `tunnel: ${JSON.stringify(status.tunnel)}`);
  assert.ok(status.inviteUrl.includes('.trycloudflare.com/join/'), status.inviteUrl);
  // A fresh quick tunnel can take a few seconds to resolve in DNS.
  for (let i = 0; i < 20; i++) {
    const r = await fetch(status.inviteUrl).catch(() => null);
    if (r?.status === 200) break;
    await sleep(1500);
  }
  const g = await joinGuest(status.inviteUrl, 'Remote');
  await receivesProgram(g.page, 40000);
  await g.ctx.close();
  // And a guest with no direct path, whose media must cross the tunnel.
  const r = await joinRelayOnlyGuest(status.inviteUrl, 'Remote relay');
  await receivesRelay(r.page, 45000);
  assert.deepEqual(r.errors, []);
  await r.ctx.close();
  const back = await api('PUT', '/api/sharing', { mode: 'local' });
  assert.equal(back.tunnel.state, 'off');
});

await test('invite window shows the QR code and share options', async () => {
  await studio.evaluate(() => window.streamFree.inviteDialog());
  await waitFor(studio, () => document.querySelector('#dialog img.qr')?.naturalWidth > 0);
  const labels = await studio.$$eval('#dialog .share-row > *', (els) => els.map((e) => e.textContent));
  assert.deepEqual(labels, ['Copy invitation', 'WhatsApp', 'Telegram', 'Email']);
  await studio.keyboard.press('Escape');
});

await test('the studio speaks Italian when the system does', async () => {
  const itCtx = await browser.newContext({ permissions: ['camera', 'microphone'], locale: 'it-IT' });
  const page = await itCtx.newPage();
  await page.goto(`${server.base}/?t=${server.token}`);
  await waitFor(page, () => document.querySelector('#live-btn')?.textContent === 'Vai in diretta');
  assert.equal(await page.textContent('#record-btn'), 'Registra');
  await itCtx.close();
});

await test('every interface string has an Italian translation', async () => {
  const { IT } = await import('../../web/js/i18n.js');
  const { readFileSync } = await import('node:fs');
  const used = new Set();
  for (const f of ['studio.js', 'guest.js', 'help.js']) {
    const src = readFileSync(join(ROOT, 'web/js', f), 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) used.add(m[1].replace(/\\'/g, "'"));
  }
  const { LAYOUTS } = await import('../../web/js/layouts.js');
  for (const l of LAYOUTS) used.add(l.label);
  const missing = [...used].filter((k) => !(k in IT));
  const unused = Object.keys(IT).filter((k) => !used.has(k));
  assert.deepEqual(missing, [], 'missing Italian translations');
  assert.deepEqual(unused, [], 'unused Italian translations');
});

await test('program style options render without errors', async () => {
  await studio.evaluate(() => window.streamFree.setStyle({ font: 'serif', namePos: 'tl', bannerStyle: 'glass', bannerPos: 'center', spacing: 2.5, tickerBg: '#000000' }));
  await studio.evaluate(() => window.streamFree.showBanner('Styled', 'banner'));
  await sleep(800);
  await studio.evaluate(() => window.streamFree.setStyle({ font: 'sans', namePos: 'bl', bannerStyle: 'solid', bannerPos: 'left', spacing: 1, tickerBg: '' }));
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
