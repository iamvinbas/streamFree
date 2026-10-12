// streamFree studio: the host's control room.
//
// Media flow: camera/screen/guest tracks -> MediaStreamTrackProcessor (in the
// page on Chromium, in the worker on WebKit) ->
// compositor worker (canvas + WebCodecs) -> WebSocket -> local server ->
// RTMP destinations and MP4 recording. Audio is mixed here with Web Audio.

import { LAYOUTS, computeLayout } from './layouts.js';
import { Mixer } from './audio.js';
import {
  h, icon, makeApi, hostToken, debounce, formatDuration, formatBytes, toast, applyTheme, toggleTheme,
} from './util.js';

applyTheme();

const token = hostToken();
const api = makeApi(token);
const $ = (sel) => document.querySelector(sel);

const PLATFORMS = {
  youtube: { label: 'YouTube', url: 'rtmp://a.rtmp.youtube.com/live2', help: 'YouTube Studio → Go live → Stream → Stream key.' },
  twitch: { label: 'Twitch', url: 'rtmp://live.twitch.tv/app', help: 'Twitch Creator Dashboard → Settings → Stream → Primary stream key.' },
  facebook: { label: 'Facebook', url: 'rtmps://live-api-s.facebook.com:443/rtmp/', help: 'Facebook Live Producer → Streaming software → Stream key.' },
  linkedin: { label: 'LinkedIn', url: '', help: 'LinkedIn Live → Create event → Custom stream: paste the stream URL and key.' },
  kick: { label: 'Kick', url: '', help: 'Kick Dashboard → Settings → Stream URL and key.' },
  x: { label: 'X', url: '', help: 'X Media Studio → Producer → Sources: paste the RTMP URL and key.' },
  custom: { label: 'Custom RTMP', url: '', help: 'Any rtmp:// or rtmps:// server, e.g. your own nginx-rtmp or Owncast.' },
};

const DEFAULT_STUDIO = {
  layout: 'grid',
  theme: { primary: '#6d5efc', text: '#ffffff', style: 'pill', radius: 0.012 },
  showNames: true,
  background: { color: '#0f1117', imageId: null },
  overlayId: null,
  logo: { id: null, position: 'tr', size: 0.12 },
  banners: [],
  activeBanner: null,
  ticker: { text: '', on: false, speed: 1 },
  assets: [], // { id, name, kind: 'image' | 'video', role?: 'overlay'|'background'|'logo' }
  destSelection: {},
  title: '',
  hostName: 'Host',
  twitchChannel: '',
  settings: {
    resolution: '720p',
    fps: 30,
    videoKbps: 4500,
    audioKbps: 160,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    camId: '',
    micId: '',
    mirror: false,
    monitor: true,
    recordWhileLive: true,
  },
};

const S = structuredClone(DEFAULT_STUDIO); // persisted studio state
const people = new Map(); // id -> participant
let stageIds = ['host'];
let featured = null; // screen share or media clip shown large
let hiddenComment = null;
let currentComment = null;
let info = null;
let destinations = [];
let comments = [];
let backstageChat = [];
let chatStatus = '';
let live = { state: 'idle', mode: null, status: null };
let tab = 'brand';
let signal = null;
let worker = null;
let mixer = null;
let returnTrack = null;
let returnWriter = null;
let mediaElement = null;
let encoderReady = null; // resolves when the worker has warmed up its encoders
let markEncoderReady = () => {};

function resetEncoderReady() {
  encoderReady = new Promise((resolve) => (markEncoderReady = resolve));
}
resetEncoderReady();

// ---------------------------------------------------------------- boot

async function boot() {
  const capable = 'VideoEncoder' in window && 'AudioEncoder' in window && 'AudioWorkletNode' in window
    && 'OffscreenCanvas' in window;
  if (!capable) {
    fatal('This browser cannot run the streamFree studio. Use the streamFree app, or Chrome, Edge or Brave (version 100 or newer). Guests can join from any modern browser.');
    return;
  }
  if (!token) {
    fatal('Open the Studio link printed in the terminal where streamFree is running (it contains your private access key).');
    return;
  }
  try {
    [info, destinations] = await Promise.all([api.get('/api/info'), api.get('/api/destinations')]);
    const saved = await api.get('/api/studio');
    if (saved && typeof saved === 'object') mergeStudio(saved);
  } catch (e) {
    fatal(`Cannot reach the streamFree server: ${e.message}. Is it still running?`);
    return;
  }

  mixer = new Mixer();
  mixer.setMonitor(S.settings.monitor);
  try {
    await mixer.init();
  } catch (e) {
    fatal(`Audio could not start: ${e.message}`);
    return;
  }
  startWorker();
  setupReturnFeed();
  connectSignaling();
  bindTopbar();
  renderAll();
  document.addEventListener('click', () => mixer.resume(), { once: true });
  // ?nodevices: automated checks that must not open camera permission prompts.
  if (new URL(location.href).searchParams.has('nodevices')) {
    people.set('host', { id: 'host', kind: 'host', name: S.hostName || 'Host', stream: new MediaStream(), micOn: false, camOn: false });
    renderPeople();
    pushScene();
  } else {
    await startCamera();
  }
  for (const a of S.assets.filter((a) => a.kind === 'image')) loadImage(a.id);
  meterLoop();
  window.addEventListener('beforeunload', (e) => {
    if (live.state !== 'idle') e.preventDefault();
  });
}

function mergeStudio(saved) {
  for (const [k, v] of Object.entries(saved)) {
    if (k === 'settings' || k === 'theme' || k === 'background' || k === 'logo' || k === 'ticker') {
      S[k] = { ...DEFAULT_STUDIO[k], ...v };
    } else if (k in DEFAULT_STUDIO) {
      S[k] = v;
    }
  }
}

function fatal(message) {
  document.body.replaceChildren(h('main', { class: 'fatal' }, h('h1', {}, 'streamFree'), h('p', {}, message)));
}

const saveStudio = debounce(() => {
  api.put('/api/studio', S).catch((e) => toast(`Could not save settings: ${e.message}`, 'error'));
}, 700);

function changed({ save = true, scene = true } = {}) {
  if (save) saveStudio();
  if (scene) pushScene();
}

// ---------------------------------------------------------------- worker & scene

function outputSize() {
  return S.settings.resolution === '1080p' ? [1920, 1080] : [1280, 720];
}

function startWorker() {
  worker = new Worker('/static/js/compositor-worker.js', { type: 'module' });
  const canvas = $('#preview');
  const [w, hgt] = outputSize();
  canvas.width = w;
  canvas.height = hgt;
  const off = canvas.transferControlToOffscreen();
  worker.postMessage({ type: 'init', preview: off, width: w, height: hgt, fps: S.settings.fps }, [off]);
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => toast(`Compositor error: ${e.message}`, 'error');
  pushScene();
}

function attachVideo(id, track) {
  if (!track) {
    worker.postMessage({ type: 'remove-source', id });
    return;
  }
  if ('MediaStreamTrackProcessor' in window) {
    const processor = new MediaStreamTrackProcessor({ track });
    worker.postMessage({ type: 'source', id, readable: processor.readable }, [processor.readable]);
  } else {
    // WebKit reads tracks only inside workers: hand the worker its own copy.
    const copy = track.clone();
    worker.postMessage({ type: 'source-track', id, track: copy }, [copy]);
  }
}

// A video track for a playing <video>. WebKit has no
// HTMLMediaElement.captureStream(), so draw the element into a canvas there.
function elementVideoTrack(video) {
  if (typeof video.captureStream === 'function') return video.captureStream().getVideoTracks()[0] || null;
  const canvas = h('canvas', { width: video.videoWidth || 1280, height: video.videoHeight || 720 });
  const ctx2d = canvas.getContext('2d');
  const draw = () => {
    if (video.ended || mediaElement !== video) return;
    ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(draw);
    else requestAnimationFrame(draw);
  };
  draw();
  return canvas.captureStream(30).getVideoTracks()[0] || null;
}

function pushScene() {
  if (!worker) return;
  // Stage membership is kept for people who have not connected yet (the host
  // before their camera starts); only present people are drawn.
  const stage = stageIds.filter((id) => people.has(id));
  const shown = featured && people.has(featured) ? featured : null;
  const names = {};
  const hidden = {};
  for (const p of people.values()) {
    names[p.id] = p.name;
    if (p.camOn === false) hidden[p.id] = true;
  }
  const banner = S.banners.find((b) => b.id === S.activeBanner) || null;
  worker.postMessage({
    type: 'scene',
    scene: {
      layout: S.layout,
      stage,
      screen: shown,
      names,
      hidden,
      showNames: S.showNames,
      theme: S.theme,
      background: S.background,
      overlayId: S.overlayId,
      logo: S.logo,
      banner: banner && { title: banner.title, subtitle: banner.subtitle },
      ticker: S.ticker.on && S.ticker.text ? { text: S.ticker.text, speed: S.ticker.speed } : null,
      comment: currentComment,
      mirror: { host: S.settings.mirror },
    },
  });
  mixer?.setStage(stage, shown);
}

async function loadImage(id) {
  try {
    const img = new Image();
    img.src = api.assetUrl(id);
    await img.decode();
    const bitmap = await createImageBitmap(img);
    worker.postMessage({ type: 'image', id, bitmap }, [bitmap]);
  } catch {
    toast('An image could not be loaded; it may have been deleted.', 'error');
  }
}

function setupReturnFeed() {
  if ('MediaStreamTrackGenerator' in window) {
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    returnWriter = generator.writable.getWriter();
    returnTrack = generator;
  } else {
    const c = h('canvas', { width: 640, height: 360 });
    const cx = c.getContext('2d');
    returnWriter = { write: (frame) => { cx.drawImage(frame, 0, 0, 640, 360); frame.close(); }, desiredSize: 1 };
    returnTrack = c.captureStream(15).getVideoTracks()[0];
  }
}

function onWorkerMessage(e) {
  const m = e.data;
  switch (m.type) {
    case 'return-frame':
      if (returnWriter && (returnWriter.desiredSize ?? 1) > 0) returnWriter.write(m.frame).catch(() => {});
      else m.frame.close();
      break;
    case 'encoder-ready':
      markEncoderReady();
      break;
    case 'encoding':
      live.state = 'live';
      renderTopbar();
      break;
    case 'ingest':
      onIngest(m.msg);
      break;
    case 'stopped':
      finishBroadcast(m.result);
      break;
    case 'error':
      toast(m.error, 'error');
      if (live.state === 'starting') {
        mixer.stopCapture();
        live = { state: 'idle', mode: null, status: null };
        renderTopbar();
      }
      break;
  }
}

// ---------------------------------------------------------------- local media

async function startCamera() {
  const st = S.settings;
  const constraints = {
    video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }, ...(st.camId ? { deviceId: { exact: st.camId } } : {}) },
    audio: {
      echoCancellation: st.echoCancellation,
      noiseSuppression: st.noiseSuppression,
      autoGainControl: st.autoGainControl,
      ...(st.micId ? { deviceId: { exact: st.micId } } : {}),
    },
  };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    try {
      // The saved device may be gone; fall back to the defaults.
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: constraints.audio.deviceId ? true : constraints.audio });
    } catch {
      toast(`Camera/microphone unavailable: ${err.message}. You can still share your screen or add guests.`, 'error');
      stream = new MediaStream();
    }
  }
  const old = people.get('host');
  old?.stream?.getTracks().forEach((t) => t.stop());
  const host = {
    id: 'host',
    kind: 'host',
    name: S.hostName || 'Host',
    stream,
    micOn: old ? old.micOn : true,
    camOn: old ? old.camOn : true,
  };
  stream.getAudioTracks().forEach((t) => (t.enabled = host.micOn));
  stream.getVideoTracks().forEach((t) => (t.enabled = host.camOn));
  people.set('host', host);
  attachVideo('host', stream.getVideoTracks()[0]);
  mixer.add('host', 'host', stream);
  renderPeople();
  renderControls();
  pushScene();
}

async function shareScreen() {
  if (people.has('screen')) {
    stopSource('screen');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
    });
  } catch {
    return; // the user cancelled the picker
  }
  const track = stream.getVideoTracks()[0];
  track.contentHint = 'detail';
  track.addEventListener('ended', () => stopSource('screen'));
  people.set('screen', { id: 'screen', kind: 'screen', name: 'Screen', stream, camOn: true, micOn: true });
  attachVideo('screen', track);
  mixer.add('screen', 'screen', stream);
  featured = 'screen';
  if (!['pip', 'present', 'cinema', 'solo'].includes(S.layout)) S.layout = 'present';
  renderAll();
  changed();
}

function stopSource(id) {
  const p = people.get(id);
  if (!p) return;
  p.stream?.getTracks().forEach((t) => t.stop());
  attachVideo(id, null);
  mixer.remove(id);
  people.delete(id);
  if (featured === id) featured = null;
  if (id === 'media' && mediaElement) {
    mediaElement.pause();
    mediaElement.removeAttribute('src');
    mediaElement.load();
    mediaElement = null;
  }
  renderAll();
  pushScene();
}

async function playMedia(asset) {
  stopSource('media');
  const video = h('video', { src: api.assetUrl(asset.id), playsInline: true, preload: 'auto' });
  mediaElement = video;
  await mixer.resume();
  try {
    await video.play();
  } catch (e) {
    toast(`Cannot play ${asset.name}: ${e.message}`, 'error');
    return;
  }
  const track = elementVideoTrack(video);
  const stream = new MediaStream(track ? [track] : []);
  people.set('media', { id: 'media', kind: 'media', name: asset.name, stream, camOn: true, micOn: true });
  if (track) attachVideo('media', track);
  mixer.add('media', 'media', video);
  featured = 'media';
  video.addEventListener('ended', () => {
    if (mediaElement === video) stopSource('media');
  });
  renderAll();
  pushScene();
}

// ---------------------------------------------------------------- guests (WebRTC)

function connectSignaling() {
  signal = new WebSocket(api.wsUrl('/ws/host'));
  signal.onmessage = (e) => onSignal(JSON.parse(e.data));
  signal.onclose = () => setTimeout(connectSignaling, 2000);
}

function send(msg) {
  if (signal?.readyState === WebSocket.OPEN) signal.send(JSON.stringify(msg));
}

function onSignal(m) {
  switch (m.type) {
    case 'hello':
      for (const g of m.guests) if (!people.has(g.id)) addGuest(g.id, g.name);
      break;
    case 'guest-joined':
      addGuest(m.id, m.name);
      toast(`${m.name} joined backstage`);
      break;
    case 'guest-left':
      removeGuest(m.id);
      break;
    case 'answer': {
      const g = people.get(m.from);
      g?.pc?.setRemoteDescription({ type: 'answer', sdp: m.sdp })
        .then(() => limitReturnFeed(g.pc))
        .catch((e) => toast(`Guest connection failed: ${e.message}`, 'error'));
      break;
    }
    case 'candidate': {
      const g = people.get(m.from);
      if (g?.pc && m.candidate) g.pc.addIceCandidate(m.candidate).catch(() => {});
      break;
    }
    case 'state': {
      const g = people.get(m.from);
      if (!g) break;
      if (typeof m.micOn === 'boolean') g.micOn = m.micOn;
      if (typeof m.camOn === 'boolean') g.camOn = m.camOn;
      renderPeople();
      pushScene();
      break;
    }
    case 'chat': {
      if (m.platform) {
        // Audience chat from a streaming platform.
        comments.unshift({ id: m.id || crypto.randomUUID(), author: m.author, text: m.text, color: m.color, platform: m.platform });
        comments = comments.slice(0, 300);
        if (tab === 'comments') renderPanel();
        break;
      }
      const g = people.get(m.from);
      if (!g) break;
      backstageChat.push({ author: g.name, text: String(m.text || '').slice(0, 500), at: Date.now() });
      if (tab === 'chat') renderPanel();
      else toast(`${g.name}: ${m.text}`);
      break;
    }
    case 'chat-status':
      chatStatus = m.state === 'connected' ? `Connected to #${m.channel}` : `Reconnecting… ${m.error || ''}`;
      if (tab === 'comments') renderPanel();
      break;
  }
}

async function addGuest(id, name) {
  if (people.has(id)) return;
  const guest = { id, kind: 'guest', name, stream: new MediaStream(), micOn: true, camOn: true, muted: false, pc: null, connection: 'connecting' };
  people.set(id, guest);
  const pc = new RTCPeerConnection({ iceServers: info.iceServers || [] });
  guest.pc = pc;
  pc.addTransceiver(returnTrack, { direction: 'sendrecv' });
  pc.addTransceiver(mixer.guestTrack(id), { direction: 'sendrecv' });
  pc.onicecandidate = (e) => e.candidate && send({ to: id, type: 'candidate', candidate: e.candidate });
  pc.onconnectionstatechange = () => {
    guest.connection = pc.connectionState;
    renderPeople();
  };
  pc.ontrack = (e) => {
    guest.stream.addTrack(e.track);
    if (e.track.kind === 'video') attachVideo(id, e.track);
    else mixer.add(id, 'guest', new MediaStream([e.track]));
    renderPeople();
  };
  worker.postMessage({ type: 'return-feed', enabled: true });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ to: id, type: 'offer', sdp: offer.sdp });
  renderPeople();
}

// The return feed is a preview for guests: cap it so it never competes with
// the guest's own upload.
async function limitReturnFeed(pc) {
  const sender = pc.getSenders().find((x) => x.track?.kind === 'video');
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    params.encodings[0].maxBitrate = 800_000;
    params.encodings[0].maxFramerate = 15;
    await sender.setParameters(params);
  } catch {
    // not fatal: the browser picks its own bitrate
  }
}

function removeGuest(id) {
  const g = people.get(id);
  if (!g) return;
  g.pc?.close();
  attachVideo(id, null);
  mixer.remove(id);
  mixer.removeGuestBus(id);
  people.delete(id);
  stageIds = stageIds.filter((x) => x !== id);
  if (![...people.values()].some((p) => p.kind === 'guest')) worker.postMessage({ type: 'return-feed', enabled: false });
  renderPeople();
  pushScene();
}

function toggleStage(id) {
  if (stageIds.includes(id)) stageIds = stageIds.filter((x) => x !== id);
  else stageIds.push(id);
  const p = people.get(id);
  if (p?.kind === 'guest') send({ to: id, type: 'stage', onStage: stageIds.includes(id) });
  renderPeople();
  pushScene();
}

// ---------------------------------------------------------------- broadcast

function onIngest(msg) {
  switch (msg.type) {
    case 'status':
      live.status = msg;
      renderTopbar();
      if (tab === 'destinations') renderLiveOutputs();
      break;
    case 'error':
      toast(msg.error, 'error');
      break;
    case 'closed':
      if (live.state !== 'idle') finishBroadcast(null);
      break;
  }
}

async function startBroadcast(mode, selected) {
  if (live.state !== 'idle') return;
  const record = mode === 'record' || (mode === 'live' && S.settings.recordWhileLive);
  const ids = mode === 'live' ? selected : [];
  if (mode === 'live' && !ids.length) {
    toast('Choose at least one destination.', 'error');
    return;
  }
  live = { state: 'starting', mode, status: null };
  renderTopbar();
  await mixer.resume();
  await encoderReady;
  const audioChannel = new MessageChannel();
  const audioClock = mixer.startCapture(audioChannel.port1);
  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `${S.title || 'streamFree'} ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}-${pad(stamp.getMinutes())}`;
  worker.postMessage(
    {
      type: 'start',
      options: {
        ingestUrl: api.wsUrl('/ws/ingest'),
        record,
        destinations: ids,
        name,
        videoBitrate: S.settings.videoKbps * 1000,
        audioBitrate: S.settings.audioKbps * 1000,
        audioPort: audioChannel.port2,
        audioClock,
      },
    },
    [audioChannel.port2],
  );
}

function stopBroadcast() {
  if (live.state === 'idle' || live.state === 'stopping') return;
  live.state = 'stopping';
  renderTopbar();
  worker.postMessage({ type: 'stop' });
}

function finishBroadcast(result) {
  mixer.stopCapture();
  const mode = live.mode;
  live = { state: 'idle', mode: null, status: null };
  renderTopbar();
  if (tab === 'destinations') renderPanel();
  if (!result) {
    if (mode) toast('Broadcast ended.');
    return;
  }
  const rec = result.recording;
  const body = [
    h('h2', {}, mode === 'record' ? 'Recording saved' : 'Broadcast ended'),
    (result.outputs || []).length
      ? h('ul', { class: 'summary' }, result.outputs.map((o) => h('li', {}, `${o.name}: ${formatBytes(o.bytes)} sent${o.dropped ? `, ${o.dropped} packets dropped` : ''}${o.error ? ` — last error: ${o.error}` : ''}`)))
      : null,
    rec?.path ? h('p', {}, 'Recording: ', h('code', {}, rec.path), ` (${formatBytes(rec.bytes)})`) : null,
    rec?.error ? h('p', { class: 'error' }, `Recording error: ${rec.error}`) : null,
  ];
  openDialog(body, [
    rec?.path ? h('button', { class: 'btn', onclick: () => api.post('/api/recordings/open') }, 'Open recordings folder') : null,
    h('button', { class: 'btn primary', onclick: closeDialog }, 'Done'),
  ]);
}

// ---------------------------------------------------------------- dialogs

function openDialog(body, actions) {
  const d = $('#dialog');
  d.replaceChildren(
    h('form', { method: 'dialog', class: 'dialog-body', onsubmit: (e) => e.preventDefault() },
      h('button', { class: 'icon-btn dialog-close', type: 'button', 'aria-label': 'Close', onclick: closeDialog }, icon('close')),
      body,
      h('div', { class: 'dialog-actions' }, actions)),
  );
  if (!d.open) d.showModal();
}

function closeDialog() {
  $('#dialog').close();
}

// window.confirm() is unavailable in some native WebViews; use our dialog.
function confirmDialog(question, action) {
  return new Promise((resolve) => {
    const done = (answer) => {
      closeDialog();
      resolve(answer);
    };
    openDialog([h('h2', {}, question)], [
      h('button', { class: 'btn', type: 'button', onclick: () => done(false) }, 'Cancel'),
      h('button', { class: 'btn danger', type: 'button', onclick: () => done(true) }, action),
    ]);
    $('#dialog').addEventListener('close', () => resolve(false), { once: true });
  });
}

function goLiveDialog() {
  if (live.state !== 'idle') {
    stopBroadcast();
    return;
  }
  const enabled = destinations.filter((d) => d.enabled);
  if (!enabled.length) {
    tab = 'destinations';
    renderAll();
    toast('Add a destination (YouTube, Twitch, Facebook, any RTMP server) first.');
    return;
  }
  const checks = enabled.map((d) => {
    const input = h('input', { type: 'checkbox', checked: S.destSelection[d.id] !== false, 'data-id': d.id });
    return h('label', { class: 'check' }, input, h('span', {}, d.name), h('small', {}, PLATFORMS[d.platform]?.label || 'RTMP'));
  });
  const rec = h('input', { type: 'checkbox', checked: S.settings.recordWhileLive });
  openDialog(
    [h('h2', {}, 'Go live'), h('p', { class: 'muted' }, 'Stream to:'), h('div', { class: 'checks' }, checks), h('label', { class: 'check' }, rec, h('span', {}, 'Also record to this computer'))],
    [
      h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Cancel'),
      h('button', {
        class: 'btn primary', type: 'button', onclick: () => {
          const selected = [];
          for (const c of checks) {
            const input = c.querySelector('input');
            S.destSelection[input.dataset.id] = input.checked;
            if (input.checked) selected.push(input.dataset.id);
          }
          S.settings.recordWhileLive = rec.checked;
          changed({ scene: false });
          closeDialog();
          startBroadcast('live', selected);
        },
      }, 'Go live now'),
    ],
  );
}

async function inviteDialog() {
  // The public address (tunnel) can appear after the studio loaded.
  try {
    info = await api.get('/api/info');
  } catch {
    // keep the last known address
  }
  const url = info.inviteUrl;
  const local = !info.publicUrl && !info.lanUrl;
  openDialog(
    [
      h('h2', {}, 'Invite guests'),
      h('p', {}, 'Send this link. Guests join from their browser — nothing to install.'),
      h('div', { class: 'copy-row' }, h('input', { value: url, readOnly: true, 'aria-label': 'Invite link', onfocus: (e) => e.target.select() }),
        h('button', { class: 'btn', type: 'button', onclick: () => navigator.clipboard.writeText(url).then(() => toast('Link copied')) }, icon('copy', 16), 'Copy')),
      local
        ? h('p', { class: 'note' }, 'This link only works on this computer. Restart streamFree with ', h('code', {}, '--lan'), ' for guests on your network, or ', h('code', {}, '--tunnel'), ' (needs cloudflared) for guests anywhere.')
        : null,
      info.lanUrl && !info.publicUrl ? h('p', { class: 'note' }, 'Network link with a self-signed certificate: guests click “Advanced → Proceed” once.') : null,
    ],
    [
      h('button', {
        class: 'btn', type: 'button', onclick: async () => {
          const r = await api.post('/api/invite/reset');
          info.inviteUrl = r.inviteUrl;
          toast('New link created. The old one no longer works.');
          inviteDialog();
        },
      }, 'Create a new link'),
      h('button', { class: 'btn primary', type: 'button', onclick: closeDialog }, 'Done'),
    ],
  );
}

function mediaDialog() {
  const videos = S.assets.filter((a) => a.kind === 'video');
  const fileInput = h('input', {
    type: 'file', accept: 'video/mp4,video/webm,video/quicktime', hidden: true, onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await uploadAsset(file, 'video');
      mediaDialog();
    },
  });
  openDialog(
    [
      h('h2', {}, 'Video clips'),
      h('p', { class: 'muted' }, 'Intros, outros, trailers: play them full screen with their sound.'),
      videos.length
        ? h('ul', { class: 'asset-list' }, videos.map((a) => h('li', {},
          h('span', {}, a.name),
          h('button', { class: 'btn small', type: 'button', onclick: () => { closeDialog(); playMedia(a); } }, 'Play'),
          h('button', { class: 'btn small ghost', type: 'button', onclick: () => { removeAsset(a.id); mediaDialog(); } }, 'Delete'))))
        : h('p', { class: 'muted' }, 'No clips yet.'),
      fileInput,
    ],
    [
      people.has('media') ? h('button', { class: 'btn', type: 'button', onclick: () => { stopSource('media'); closeDialog(); } }, 'Stop playing clip') : null,
      h('button', { class: 'btn primary', type: 'button', onclick: () => fileInput.click() }, 'Upload clip'),
    ],
  );
}

async function uploadAsset(file, kind) {
  try {
    toast(`Uploading ${file.name}…`);
    const r = await api.upload(file);
    const asset = { id: r.id, name: file.name, kind };
    S.assets.push(asset);
    if (kind === 'image') await loadImage(asset.id);
    changed({ scene: false });
    return asset;
  } catch (e) {
    toast(`Upload failed: ${e.message}`, 'error');
    return null;
  }
}

function removeAsset(id) {
  S.assets = S.assets.filter((a) => a.id !== id);
  if (S.overlayId === id) S.overlayId = null;
  if (S.background.imageId === id) S.background.imageId = null;
  if (S.logo.id === id) S.logo.id = null;
  worker.postMessage({ type: 'remove-image', id });
  changed();
}

// ---------------------------------------------------------------- rendering

function renderAll() {
  renderTopbar();
  renderLayouts();
  renderPeople();
  renderControls();
  renderTabs();
  renderPanel();
}

function bindTopbar() {
  const title = $('#show-title');
  title.value = S.title;
  title.addEventListener('input', () => {
    S.title = title.value;
    changed({ scene: false });
  });
  $('#theme-toggle').append(icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon'));
  $('#theme-toggle').addEventListener('click', () => {
    const t = toggleTheme();
    $('#theme-toggle').replaceChildren(icon(t === 'dark' ? 'sun' : 'moon'));
  });
  $('#record-btn').addEventListener('click', () => {
    if (live.state === 'idle') startBroadcast('record', []);
    else if (live.mode === 'record') stopBroadcast();
  });
  $('#live-btn').addEventListener('click', goLiveDialog);
}

function renderTopbar() {
  const status = $('#status');
  const recBtn = $('#record-btn');
  const liveBtn = $('#live-btn');
  const badge = $('#live-badge');
  const s = live.status;
  recBtn.disabled = live.state !== 'idle' && live.mode !== 'record';
  liveBtn.disabled = live.state !== 'idle' && live.mode !== 'live';
  recBtn.textContent = live.mode === 'record' && live.state !== 'idle' ? 'Stop recording' : 'Record';
  liveBtn.textContent = live.mode === 'live' && live.state !== 'idle' ? 'End broadcast' : 'Go live';
  recBtn.classList.toggle('danger', live.mode === 'record' && live.state !== 'idle');
  liveBtn.classList.toggle('danger', live.mode === 'live' && live.state !== 'idle');
  if (live.state === 'idle') {
    status.replaceChildren(h('span', { class: 'pill' }, 'Offline'));
    badge.hidden = true;
    return;
  }
  const label = { starting: 'Starting…', stopping: 'Finishing…', live: live.mode === 'record' ? 'REC' : 'LIVE' }[live.state];
  const parts = [h('span', { class: `pill ${live.mode === 'record' ? 'rec' : 'live'}` }, label)];
  if (s) {
    parts.push(h('span', { class: 'elapsed' }, formatDuration(s.elapsed)));
    for (const o of s.outputs || []) {
      parts.push(h('span', { class: `out ${o.state}`, title: o.error || o.state }, `${o.name} · ${o.state === 'live' ? `${o.kbps} kbps` : o.state}`));
    }
    if (s.recording?.path) parts.push(h('span', { class: 'out live' }, `● ${formatBytes(s.recording.bytes)}`));
  }
  status.replaceChildren(...parts);
  badge.hidden = live.state !== 'live';
  badge.textContent = live.mode === 'record' ? 'REC' : 'LIVE';
}

function layoutIcon(id) {
  const W = 64;
  const H = 36;
  const needsScreen = LAYOUTS.find((l) => l.id === id).needs === 'screen';
  const l = computeLayout(id, id === 'solo' ? 1 : 3, needsScreen, W, H);
  const rects = [];
  if (l.screen) rects.push(`<rect x="${l.screen.x}" y="${l.screen.y}" width="${l.screen.w}" height="${l.screen.h}" rx="1" class="scr"/>`);
  for (const r of l.cams) rects.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="1.5" class="cam"/>`);
  const span = document.createElement('span');
  span.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="64" height="36" aria-hidden="true"><rect width="${W}" height="${H}" rx="3" class="bg"/>${rects.join('')}</svg>`;
  return span;
}

function renderLayouts() {
  const bar = $('#layouts');
  bar.replaceChildren(...LAYOUTS.map((l) => h('button', {
    class: `layout-btn ${S.layout === l.id ? 'active' : ''}`,
    title: l.label,
    'aria-label': l.label,
    'aria-pressed': String(S.layout === l.id),
    onclick: () => {
      S.layout = l.id;
      renderLayouts();
      changed();
    },
  }, layoutIcon(l.id), h('small', {}, l.label))));
}

const thumbVideos = new Map(); // participant id -> <video>, reused across renders

function thumbVideo(p) {
  let video = thumbVideos.get(p.id);
  if (!video) {
    video = h('video', { autoplay: true, muted: true, playsInline: true });
    thumbVideos.set(p.id, video);
  }
  const track = p.stream?.getVideoTracks()[0];
  if (video.srcObject?.getVideoTracks()[0] !== track) {
    video.srcObject = track ? new MediaStream([track]) : null;
  }
  video.classList.toggle('mirror', p.kind === 'host' && S.settings.mirror);
  return video;
}

function personCard(p) {
  const onStage = stageIds.includes(p.id);
  const isFeatured = featured === p.id;
  const video = thumbVideo(p);
  const nameInput = h('input', {
    class: 'name', value: p.name, 'aria-label': 'Display name', onchange: (e) => {
      p.name = e.target.value.slice(0, 40) || p.name;
      if (p.kind === 'host') {
        S.hostName = p.name;
        saveStudio();
      }
      pushScene();
    },
  });
  const actions = [];
  if (p.kind === 'host' || p.kind === 'guest') {
    actions.push(h('button', { class: `btn small ${onStage ? '' : 'primary'}`, onclick: () => toggleStage(p.id) }, onStage ? 'Remove' : 'Add to stage'));
  } else {
    actions.push(h('button', {
      class: `btn small ${isFeatured ? '' : 'primary'}`, onclick: () => {
        featured = isFeatured ? null : p.id;
        renderPeople();
        pushScene();
      },
    }, isFeatured ? 'Hide' : 'Show'));
    actions.push(h('button', { class: 'btn small ghost', onclick: () => stopSource(p.id) }, 'Stop'));
  }
  if (p.kind === 'guest') {
    actions.push(h('button', {
      class: 'icon-btn', title: p.muted ? 'Unmute guest' : 'Mute guest', 'aria-label': p.muted ? 'Unmute guest' : 'Mute guest', onclick: () => {
        p.muted = !p.muted;
        mixer.setMuted(p.id, p.muted);
        renderPeople();
      },
    }, icon(p.muted ? 'micOff' : 'mic', 16)));
    actions.push(h('button', {
      class: 'icon-btn', title: 'Remove from studio', 'aria-label': 'Remove guest from studio', onclick: () => {
        confirmDialog(`Remove ${p.name} from the studio?`, 'Remove').then((ok) => ok && send({ to: p.id, type: 'kick' }));
      },
    }, icon('close', 16)));
  }
  const badges = [];
  if (onStage) badges.push(h('span', { class: 'badge on' }, 'On stage'));
  if (isFeatured) badges.push(h('span', { class: 'badge on' }, 'Showing'));
  if (p.kind === 'guest' && p.connection && p.connection !== 'connected') badges.push(h('span', { class: 'badge' }, p.connection));
  if (p.micOn === false) badges.push(h('span', { class: 'badge' }, 'mic off'));
  if (p.camOn === false) badges.push(h('span', { class: 'badge' }, 'cam off'));
  return h('div', { class: `person ${onStage || isFeatured ? 'staged' : ''}`, 'data-id': p.id },
    h('div', { class: 'thumb' }, video, h('div', { class: 'meter' }, h('i', { 'data-meter': p.id })), h('div', { class: 'badges' }, badges)),
    nameInput,
    h('div', { class: 'person-actions' }, actions));
}

function renderPeople() {
  for (const id of thumbVideos.keys()) if (!people.has(id)) thumbVideos.delete(id);
  const list = [...people.values()];
  list.sort((a, b) => ['host', 'guest', 'screen', 'media'].indexOf(a.kind) - ['host', 'guest', 'screen', 'media'].indexOf(b.kind));
  const cards = list.map(personCard);
  if (!list.some((p) => p.kind === 'guest')) {
    cards.push(h('button', { class: 'person invite-card', onclick: inviteDialog }, icon('invite', 28), h('span', {}, 'Invite a guest')));
  }
  $('#people').replaceChildren(...cards);
}

function renderControls() {
  const host = people.get('host');
  const mic = host?.micOn !== false;
  const cam = host?.camOn !== false;
  const ctl = (name, label, onclick, active = false) => h('button', { class: `ctl ${active ? 'active' : ''}`, onclick, 'aria-label': label }, icon(name), h('small', {}, label));
  $('#controls').replaceChildren(
    ctl(mic ? 'mic' : 'micOff', mic ? 'Mute' : 'Unmute', () => {
      host.micOn = !mic;
      host.stream.getAudioTracks().forEach((t) => (t.enabled = host.micOn));
      renderControls();
      renderPeople();
    }, !mic),
    ctl(cam ? 'cam' : 'camOff', cam ? 'Stop cam' : 'Start cam', () => {
      host.camOn = !cam;
      host.stream.getVideoTracks().forEach((t) => (t.enabled = host.camOn));
      renderControls();
      renderPeople();
      pushScene();
    }, !cam),
    ctl('screen', people.has('screen') ? 'Stop share' : 'Share screen', shareScreen, people.has('screen')),
    ctl('media', 'Video clips', mediaDialog, people.has('media')),
    ctl('invite', 'Invite', inviteDialog),
    ctl('gear', 'Settings', () => { tab = 'settings'; renderTabs(); renderPanel(); }),
  );
}

const TABS = [
  ['brand', 'Brand'],
  ['banners', 'Banners'],
  ['comments', 'Comments'],
  ['chat', 'Chat'],
  ['destinations', 'Destinations'],
  ['settings', 'Settings'],
];

function renderTabs() {
  $('#tabs').replaceChildren(...TABS.map(([id, label]) => h('button', {
    role: 'tab', class: `tab ${tab === id ? 'active' : ''}`, 'aria-selected': String(tab === id), onclick: () => {
      tab = id;
      renderTabs();
      renderPanel();
    },
  }, label)));
}

function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', {}, label), control, hint ? h('small', { class: 'muted' }, hint) : null);
}

function section(title, ...children) {
  return h('section', { class: 'card' }, h('h3', {}, title), children);
}

function imagePicker(role, selectedId, onPick, { allowNone = true } = {}) {
  const imgs = S.assets.filter((a) => a.kind === 'image' && (a.role === role || !a.role));
  const input = h('input', {
    type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml', hidden: true, onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const asset = await uploadAsset(file, 'image');
      if (asset) {
        asset.role = role;
        onPick(asset.id);
      }
    },
  });
  return h('div', { class: 'thumbs' },
    allowNone ? h('button', { class: `thumb-btn none ${!selectedId ? 'active' : ''}`, onclick: () => onPick(null) }, 'None') : null,
    imgs.map((a) => h('button', { class: `thumb-btn ${selectedId === a.id ? 'active' : ''}`, title: a.name, onclick: () => onPick(a.id) },
      h('img', { src: api.assetUrl(a.id), alt: a.name, loading: 'lazy' }))),
    h('button', { class: 'thumb-btn add', onclick: () => input.click(), 'aria-label': `Upload ${role}` }, '+'),
    input);
}

function renderPanel() {
  const panel = $('#panel');
  const render = {
    brand: brandPanel,
    banners: bannersPanel,
    comments: commentsPanel,
    chat: chatPanel,
    destinations: destinationsPanel,
    settings: settingsPanel,
  }[tab];
  panel.replaceChildren(...[render()].flat().filter(Boolean));
}

function brandPanel() {
  const set = (fn) => (e) => {
    fn(e.target);
    changed();
  };
  return [
    section('Colors',
      h('div', { class: 'row' },
        field('Brand color', h('input', { type: 'color', value: S.theme.primary, oninput: set((t) => (S.theme.primary = t.value)) })),
        field('Text color', h('input', { type: 'color', value: S.theme.text, oninput: set((t) => (S.theme.text = t.value)) }))),
      field('Name style', h('select', { onchange: set((t) => (S.theme.style = t.value)) },
        [['pill', 'Bubble'], ['block', 'Block'], ['minimal', 'Minimal']].map(([v, l]) => h('option', { value: v, selected: S.theme.style === v }, l)))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.showNames, onchange: set((t) => (S.showNames = t.checked)) }), h('span', {}, 'Show display names')),
      field('Rounded corners', h('input', { type: 'range', min: 0, max: 0.04, step: 0.002, value: S.theme.radius, oninput: set((t) => (S.theme.radius = Number(t.value))) }))),
    section('Logo',
      imagePicker('logo', S.logo.id, (id) => { S.logo.id = id; changed(); renderPanel(); }),
      h('div', { class: 'row' },
        field('Position', h('select', { onchange: set((t) => (S.logo.position = t.value)) },
          [['tl', 'Top left'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['br', 'Bottom right']].map(([v, l]) => h('option', { value: v, selected: S.logo.position === v }, l)))),
        field('Size', h('input', { type: 'range', min: 0.05, max: 0.3, step: 0.01, value: S.logo.size, oninput: set((t) => (S.logo.size = Number(t.value))) })))),
    section('Overlay',
      h('p', { class: 'muted' }, 'A full-screen PNG with transparency, drawn over the video (1280×720 or 1920×1080).'),
      imagePicker('overlay', S.overlayId, (id) => { S.overlayId = id; changed(); renderPanel(); })),
    section('Background',
      field('Color', h('input', { type: 'color', value: S.background.color, oninput: set((t) => (S.background.color = t.value)) })),
      imagePicker('background', S.background.imageId, (id) => { S.background.imageId = id; changed(); renderPanel(); })),
  ];
}

function bannersPanel() {
  const title = h('input', { placeholder: 'Title, e.g. Welcome to the show', maxLength: 80 });
  const subtitle = h('input', { placeholder: 'Subtitle (optional)', maxLength: 120 });
  const tickerText = h('input', { value: S.ticker.text, placeholder: 'Scrolling text', maxLength: 300, oninput: (e) => { S.ticker.text = e.target.value; changed(); } });
  return [
    section('Banners',
      h('form', {
        class: 'stack', onsubmit: (e) => {
          e.preventDefault();
          if (!title.value.trim() && !subtitle.value.trim()) return;
          S.banners.push({ id: crypto.randomUUID(), title: title.value.trim(), subtitle: subtitle.value.trim() });
          changed({ scene: false });
          renderPanel();
        },
      }, title, subtitle, h('button', { class: 'btn', type: 'submit' }, 'Add banner')),
      S.banners.length ? h('ul', { class: 'banner-list' }, S.banners.map((b) => {
        const active = S.activeBanner === b.id;
        return h('li', { class: active ? 'active' : '' },
          h('div', {}, h('strong', {}, b.title), b.subtitle ? h('small', {}, b.subtitle) : null),
          h('button', { class: `btn small ${active ? '' : 'primary'}`, onclick: () => { S.activeBanner = active ? null : b.id; changed(); renderPanel(); } }, active ? 'Hide' : 'Show'),
          h('button', { class: 'icon-btn', 'aria-label': 'Delete banner', onclick: () => { S.banners = S.banners.filter((x) => x.id !== b.id); if (active) S.activeBanner = null; changed(); renderPanel(); } }, icon('close', 16)));
      })) : h('p', { class: 'muted' }, 'Create banners before the show and put them on screen with one click.')),
    section('Ticker',
      tickerText,
      field('Speed', h('input', { type: 'range', min: 0.3, max: 3, step: 0.1, value: S.ticker.speed, oninput: (e) => { S.ticker.speed = Number(e.target.value); changed(); } })),
      h('button', { class: `btn ${S.ticker.on ? '' : 'primary'}`, onclick: () => { S.ticker.on = !S.ticker.on; changed(); renderPanel(); } }, S.ticker.on ? 'Hide ticker' : 'Show ticker')),
  ];
}

function showComment(c) {
  currentComment = c ? { author: c.author, text: c.text, platform: c.platform, color: c.color } : null;
  hiddenComment = c?.id || null;
  if (c) c.shown = true;
  pushScene();
  renderPanel();
}

function commentsPanel() {
  const channel = h('input', { placeholder: 'Twitch channel name', value: S.twitchChannel || '' });
  const author = h('input', { placeholder: 'Name', maxLength: 40 });
  const text = h('input', { placeholder: 'Comment or question', maxLength: 300 });
  return [
    section('Live chat',
      h('form', {
        class: 'row', onsubmit: async (e) => {
          e.preventDefault();
          try {
            const r = await api.post('/api/chat/twitch', { channel: channel.value });
            S.twitchChannel = r.channel;
            chatStatus = `Connecting to #${r.channel}…`;
            saveStudio();
            renderPanel();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }, channel, h('button', { class: 'btn', type: 'submit' }, 'Connect')),
      chatStatus ? h('p', { class: 'muted' }, chatStatus, ' ', h('button', { class: 'link', onclick: async () => { await api.del('/api/chat/twitch'); chatStatus = ''; renderPanel(); } }, 'Disconnect')) : h('p', { class: 'muted' }, 'Read-only Twitch chat, no login needed. Add other platforms’ questions below.')),
    section('Add a comment',
      h('form', {
        class: 'stack', onsubmit: (e) => {
          e.preventDefault();
          if (!text.value.trim()) return;
          const c = { id: crypto.randomUUID(), author: author.value.trim() || 'Viewer', text: text.value.trim(), platform: '' };
          comments.unshift(c);
          showComment(c);
        },
      }, author, text, h('button', { class: 'btn', type: 'submit' }, 'Show on screen'))),
    currentComment ? h('button', { class: 'btn danger full', onclick: () => showComment(null) }, 'Hide comment from screen') : null,
    h('ul', { class: 'comments' }, comments.map((c) => h('li', { class: `${hiddenComment === c.id ? 'active' : ''} ${c.shown ? 'shown' : ''}` },
      h('div', {}, h('strong', { style: { color: c.color || 'inherit' } }, c.author), c.platform ? h('small', {}, ` · ${c.platform}`) : null, h('p', {}, c.text)),
      h('button', { class: 'btn small', onclick: () => showComment(hiddenComment === c.id ? null : c) }, hiddenComment === c.id ? 'Hide' : 'Show')))),
  ];
}

function chatPanel() {
  const input = h('input', { placeholder: 'Message all guests', maxLength: 500 });
  return [
    section('Backstage chat',
      h('p', { class: 'muted' }, 'Private messages between you and your guests. Viewers never see these.'),
      h('ul', { class: 'chat' }, backstageChat.slice(-100).map((m) => h('li', {}, h('strong', {}, m.author), ' ', m.text))),
      h('form', {
        class: 'row', onsubmit: (e) => {
          e.preventDefault();
          const text = input.value.trim();
          if (!text) return;
          for (const p of people.values()) if (p.kind === 'guest') send({ to: p.id, type: 'chat', text, author: S.hostName || 'Host' });
          backstageChat.push({ author: 'You', text, at: Date.now() });
          renderPanel();
        },
      }, input, h('button', { class: 'btn', type: 'submit' }, 'Send'))),
  ];
}

function renderLiveOutputs() {
  const host = document.querySelector('#live-outputs');
  if (!host || !live.status) return;
  host.replaceChildren(...(live.status.outputs || []).map((o) => h('li', { class: o.state }, h('strong', {}, o.name), ` — ${o.state}${o.state === 'live' ? ` · ${o.kbps} kbps` : ''}${o.error ? ` · ${o.error}` : ''}`)));
}

function destinationForm(existing) {
  const platform = h('select', {}, Object.entries(PLATFORMS).map(([v, p]) => h('option', { value: v, selected: (existing?.platform || 'youtube') === v }, p.label)));
  const name = h('input', { placeholder: 'Name', value: existing?.name || '', maxLength: 60, required: true });
  const url = h('input', { placeholder: 'rtmp://… or rtmps://…', value: existing?.url || PLATFORMS.youtube.url, required: true });
  const key = h('input', { type: 'password', placeholder: existing?.hasKey ? `Saved key ${existing.keyHint} — leave empty to keep` : 'Stream key', autocomplete: 'off' });
  const help = h('small', { class: 'muted' }, PLATFORMS[existing?.platform || 'youtube'].help);
  platform.addEventListener('change', () => {
    const p = PLATFORMS[platform.value];
    if (p.url || !existing) url.value = p.url;
    if (!name.value || Object.values(PLATFORMS).some((x) => x.label === name.value)) name.value = p.label;
    help.textContent = p.help;
  });
  if (!existing) name.value = PLATFORMS.youtube.label;
  return h('form', {
    class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const body = { id: existing?.id, name: name.value, platform: platform.value, url: url.value, enabled: true };
        if (key.value || !existing) body.key = key.value;
        const saved = await api.post('/api/destinations', body);
        destinations = destinations.filter((d) => d.id !== saved.id).concat(saved);
        toast(`${saved.name} saved`);
        renderPanel();
      } catch (err) {
        toast(err.message, 'error');
      }
    },
  }, field('Platform', platform), field('Name', name), field('Server URL', url), field('Stream key', key), help,
  h('button', { class: 'btn primary', type: 'submit' }, existing ? 'Save changes' : 'Add destination'));
}

function destinationsPanel() {
  return [
    live.state !== 'idle' ? section('Now streaming', h('ul', { id: 'live-outputs', class: 'outputs' })) : null,
    section('Destinations',
      destinations.length ? h('ul', { class: 'dest-list' }, destinations.map((d) => h('li', {},
        h('label', { class: 'switch', title: d.enabled ? 'Enabled' : 'Disabled' },
          h('input', {
            type: 'checkbox', checked: d.enabled, onchange: async (e) => {
              const saved = await api.post('/api/destinations', { id: d.id, name: d.name, platform: d.platform, url: d.url, enabled: e.target.checked });
              Object.assign(d, saved);
            },
          }), h('span', {})),
        h('div', { class: 'grow' }, h('strong', {}, d.name), h('small', {}, `${PLATFORMS[d.platform]?.label || 'RTMP'} · ${d.hasKey ? `key ${d.keyHint || 'saved'}` : 'no key'}`)),
        h('button', { class: 'btn small ghost', onclick: () => openDialog([h('h2', {}, `Edit ${d.name}`), destinationForm(d)], []) }, 'Edit'),
        h('button', {
          class: 'icon-btn', 'aria-label': `Delete ${d.name}`, onclick: async () => {
            if (!(await confirmDialog(`Delete ${d.name}?`, 'Delete'))) return;
            await api.del(`/api/destinations/${d.id}`);
            destinations = destinations.filter((x) => x.id !== d.id);
            renderPanel();
          },
        }, icon('close', 16))))) : h('p', { class: 'muted' }, 'Stream keys stay on this computer and are never shown again after saving.')),
    section('Add a destination', destinationForm(null)),
  ];
}

function settingsPanel() {
  const st = S.settings;
  const devices = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading devices…'));
  navigator.mediaDevices.enumerateDevices().then((list) => {
    const opts = (kind, current) => [h('option', { value: '' }, 'Default'), ...list.filter((d) => d.kind === kind).map((d) => h('option', { value: d.deviceId, selected: d.deviceId === current }, d.label || kind))];
    devices.replaceChildren(
      field('Camera', h('select', { onchange: (e) => { st.camId = e.target.value; saveStudio(); startCamera(); } }, opts('videoinput', st.camId))),
      field('Microphone', h('select', { onchange: (e) => { st.micId = e.target.value; saveStudio(); startCamera(); } }, opts('audioinput', st.micId))),
    );
  });
  const idle = live.state === 'idle';
  const iceText = h('textarea', { rows: 4, spellcheck: false }, JSON.stringify(info.iceServers, null, 2));
  return [
    section('Output',
      h('div', { class: 'row' },
        field('Resolution', h('select', { disabled: !idle, onchange: (e) => { st.resolution = e.target.value; applyOutput(); } },
          [['720p', '1280×720 (HD)'], ['1080p', '1920×1080 (Full HD)']].map(([v, l]) => h('option', { value: v, selected: st.resolution === v }, l)))),
        field('Frame rate', h('select', { disabled: !idle, onchange: (e) => { st.fps = Number(e.target.value); applyOutput(); } },
          [30, 60].map((v) => h('option', { value: v, selected: st.fps === v }, `${v} fps`))))),
      h('div', { class: 'row' },
        field('Video bitrate (kbps)', h('input', { type: 'number', min: 500, max: 20000, step: 100, value: st.videoKbps, disabled: !idle, onchange: (e) => { st.videoKbps = Number(e.target.value); saveStudio(); } })),
        field('Audio bitrate (kbps)', h('select', { disabled: !idle, onchange: (e) => { st.audioKbps = Number(e.target.value); saveStudio(); } },
          [96, 128, 160, 192, 256].map((v) => h('option', { value: v, selected: st.audioKbps === v }, v))))),
      h('small', { class: 'muted' }, 'YouTube suggests 4500–9000 kbps for 1080p30 and 2500–6000 for 720p.')),
    section('Camera and microphone', devices,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.mirror, onchange: (e) => { st.mirror = e.target.checked; changed(); renderPeople(); } }), h('span', {}, 'Mirror my camera')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.echoCancellation, onchange: (e) => { st.echoCancellation = e.target.checked; saveStudio(); startCamera(); } }), h('span', {}, 'Echo cancellation')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.noiseSuppression, onchange: (e) => { st.noiseSuppression = e.target.checked; saveStudio(); startCamera(); } }), h('span', {}, 'Noise suppression')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.autoGainControl, onchange: (e) => { st.autoGainControl = e.target.checked; saveStudio(); startCamera(); } }), h('span', {}, 'Automatic gain')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.monitor, onchange: (e) => { st.monitor = e.target.checked; mixer.setMonitor(st.monitor); saveStudio(); } }), h('span', {}, 'Hear guests and clips on this computer (use headphones)'))),
    section('Guests',
      h('button', { class: 'btn', onclick: inviteDialog }, 'Invite link'),
      field('ICE servers (STUN/TURN)', iceText, 'Add a TURN server if guests behind strict firewalls cannot connect. JSON list of {urls, username, credential}.'),
      h('button', {
        class: 'btn small', onclick: async () => {
          try {
            const value = JSON.parse(iceText.value);
            if (!Array.isArray(value)) throw new Error('expected a JSON list');
            await api.put('/api/ice', value);
            info.iceServers = value;
            toast('ICE servers saved. They apply to guests who join from now on.');
          } catch (e) {
            toast(`Invalid ICE servers: ${e.message}`, 'error');
          }
        },
      }, 'Save ICE servers')),
    section('Recordings',
      h('p', {}, h('code', {}, info.recordingsDir)),
      h('button', { class: 'btn', onclick: () => api.post('/api/recordings/open').catch((e) => toast(e.message, 'error')) }, 'Open folder')),
    h('p', { class: 'muted center' }, `streamFree ${info.version} · free and open source (MIT)`),
  ];
}

function applyOutput() {
  resetEncoderReady();
  const [w, hgt] = outputSize();
  worker.postMessage({ type: 'size', width: w, height: hgt, fps: S.settings.fps });
  saveStudio();
}

function meterLoop() {
  const tickMeters = () => {
    for (const el of document.querySelectorAll('[data-meter]')) {
      const lvl = mixer.level(el.dataset.meter);
      el.style.transform = `scaleX(${Math.min(1, lvl * 1.6).toFixed(3)})`;
    }
    requestAnimationFrame(tickMeters);
  };
  requestAnimationFrame(tickMeters);
}

// Exposed for automated end-to-end tests.
window.streamFree = {
  people,
  get stage() { return stageIds; },
  toggleStage,
  startBroadcast,
  stopBroadcast,
  get live() { return live; },
  get audioState() { return mixer?.ctx.state; },
  workerStats: () => new Promise((resolve) => {
    const id = Math.random();
    const listener = (e) => {
      if (e.data.type === 'stats' && e.data.id === id) {
        worker.removeEventListener('message', listener);
        resolve(e.data);
      }
    };
    worker.addEventListener('message', listener);
    worker.postMessage({ type: 'stats', id });
  }),
  setLayout: (id) => { S.layout = id; renderLayouts(); changed(); },
  showBanner: (title, subtitle) => {
    const b = { id: crypto.randomUUID(), title, subtitle };
    S.banners.push(b);
    S.activeBanner = b.id;
    changed();
  },
};

boot();
