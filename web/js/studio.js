// streamFree studio: the host's control room.
//
// Media flow: camera/screen/guest tracks -> MediaStreamTrackProcessor (in the
// page on Chromium, in the worker on WebKit) ->
// compositor worker (canvas + WebCodecs) -> WebSocket -> local server ->
// RTMP destinations and MP4 recording. Audio is mixed here with Web Audio.

import { LAYOUTS, computeLayout } from './layouts.js';
import { Mixer } from './audio.js';
import { t, setLang, getLang, detectLang } from './i18n.js';
import { PLATFORMS, platformGuide, helpTopics, cloudflaredInstall } from './help.js';
import {
  h, icon, makeApi, hostToken, debounce, formatDuration, formatBytes, toast, copyText,
} from './util.js';

const token = hostToken();
const api = makeApi(token);
const $ = (sel) => document.querySelector(sel);

export const FONTS = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", system-ui, sans-serif',
  serif: 'ui-serif, "New York", Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  condensed: '"Avenir Next Condensed", "Arial Narrow", "Roboto Condensed", sans-serif',
};

const ACCENTS = ['#6d5efc', '#2563eb', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899'];

const DEFAULT_STUDIO = {
  layout: 'grid',
  theme: {
    primary: '#6d5efc',
    text: '#ffffff',
    style: 'pill',
    radius: 0.012,
    font: 'sans',
    namePos: 'bl',
    bannerStyle: 'solid',
    bannerPos: 'left',
    tickerBg: '',
    tickerText: '',
    spacing: 1,
  },
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
  ui: {
    lang: '',
    theme: 'auto',
    accent: '#6d5efc',
    textSize: 'm',
    density: 'comfortable',
    panelSide: 'right',
  },
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
let sharing = null; // who can join, and the current invite link
let destinations = [];
let comments = [];
let backstageChat = [];
let chatStatus = '';
let live = { state: 'idle', mode: null, status: null };
let tab = 'brand';
let openDialogKind = null;
let signal = null;
let worker = null;
let mixer = null;
let returnTrack = null;
let returnWriter = null;
let mediaElement = null;
let encoderReady = null; // resolves when the worker has warmed up its encoders
let markEncoderReady = () => {};
const smoke = new URL(location.href).searchParams.has('nodevices');

function resetEncoderReady() {
  encoderReady = new Promise((resolve) => (markEncoderReady = resolve));
}
resetEncoderReady();

// ---------------------------------------------------------------- appearance

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [109, 94, 252];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Black or white text, whichever reads better on `hex`. */
function contrastText(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.4 ? '#111111' : '#ffffff';
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyAppearance() {
  const ui = S.ui;
  const root = document.documentElement;
  const theme = ui.theme === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : ui.theme;
  root.dataset.theme = theme;
  const [r, g, b] = hexToRgb(ui.accent);
  root.style.setProperty('--accent', ui.accent);
  root.style.setProperty('--accent-text', contrastText(ui.accent));
  root.style.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, 0.16)`);
  root.style.zoom = { s: '0.92', m: '1', l: '1.12' }[ui.textSize] || '1';
  root.dataset.density = ui.density;
  root.dataset.panel = ui.panelSide;
  setLang(ui.lang || detectLang());
  try {
    localStorage.setItem('streamfree-ui', JSON.stringify(ui));
  } catch {
    // only used to avoid a flash on the next start
  }
}

darkQuery.addEventListener('change', () => S.ui.theme === 'auto' && applyAppearance());

// Apply the last appearance immediately, before the server answers.
try {
  Object.assign(S.ui, JSON.parse(localStorage.getItem('streamfree-ui') || '{}'));
} catch {
  // defaults
}
applyAppearance();

// ---------------------------------------------------------------- boot

async function boot() {
  const capable = 'VideoEncoder' in window && 'AudioEncoder' in window && 'AudioWorkletNode' in window
    && 'OffscreenCanvas' in window;
  if (!capable) {
    fatal(t('This browser cannot run the streamFree studio. Use the streamFree app, or Chrome, Edge or Brave (version 100 or newer). Guests can join from any modern browser.'));
    return;
  }
  if (!token) {
    fatal(t('Open the Studio link printed in the terminal where streamFree is running (it contains your private access key).'));
    return;
  }
  try {
    [info, destinations] = await Promise.all([api.get('/api/info'), api.get('/api/destinations')]);
    sharing = info.sharing;
    const saved = await api.get('/api/studio');
    if (saved && typeof saved === 'object') mergeStudio(saved);
  } catch (e) {
    fatal(t('Cannot reach the streamFree server: {error}. Is it still running?', { error: e.message }));
    return;
  }
  applyAppearance();
  translateStatic();

  mixer = new Mixer();
  mixer.setMonitor(S.settings.monitor);
  try {
    await mixer.init();
  } catch (e) {
    fatal(t('Audio could not start: {error}', { error: e.message }));
    return;
  }
  startWorker();
  setupReturnFeed();
  connectSignaling();
  bindTopbar();
  // However a dialog closes (button, Esc, backdrop), forget what it showed.
  $('#dialog').addEventListener('close', () => (openDialogKind = null));
  renderAll();
  document.addEventListener('click', () => mixer.resume(), { once: true });
  // ?nodevices: automated checks that must not open camera permission prompts.
  if (smoke) {
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
    if (['settings', 'theme', 'background', 'logo', 'ticker', 'ui'].includes(k)) {
      S[k] = { ...DEFAULT_STUDIO[k], ...v };
    } else if (k in DEFAULT_STUDIO) {
      S[k] = v;
    }
  }
}

function fatal(message) {
  document.body.replaceChildren(h('main', { class: 'fatal' }, h('h1', {}, 'streamFree'), h('p', {}, message)));
}

/** Text in the static HTML shell. */
function translateStatic() {
  $('#show-title').placeholder = t('Untitled show');
  $('#show-title').setAttribute('aria-label', t('Show title'));
  $('#preview').setAttribute('aria-label', t('Program preview'));
  $('#layouts').setAttribute('aria-label', t('Layouts'));
  $('#controls').setAttribute('aria-label', t('Controls'));
  $('#tabs').setAttribute('aria-label', t('Studio panels'));
}

const saveStudio = debounce(() => {
  api.put('/api/studio', S).catch((e) => toast(t('Could not save settings: {error}', { error: e.message }), 'error'));
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
  worker.onerror = (e) => toast(t('Compositor error: {error}', { error: e.message }), 'error');
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
      theme: { ...S.theme, fontStack: FONTS[S.theme.font] || FONTS.sans },
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
    toast(t('An image could not be loaded; it may have been deleted.'), 'error');
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
    returnWriter = {
      desiredSize: 1,
      write: (frame) => {
        cx.drawImage(frame, 0, 0, 640, 360);
        frame.close();
        return Promise.resolve();
      },
    };
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
      toast(t('Camera/microphone unavailable: {error}. You can still share your screen or add guests.', { error: err.message }), 'error');
      stream = new MediaStream();
    }
  }
  const old = people.get('host');
  old?.stream?.getTracks().forEach((tr) => tr.stop());
  const host = {
    id: 'host',
    kind: 'host',
    name: S.hostName || 'Host',
    stream,
    micOn: old ? old.micOn : true,
    camOn: old ? old.camOn : true,
  };
  stream.getAudioTracks().forEach((tr) => (tr.enabled = host.micOn));
  stream.getVideoTracks().forEach((tr) => (tr.enabled = host.camOn));
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
  people.set('screen', { id: 'screen', kind: 'screen', name: t('Screen'), stream, camOn: true, micOn: true });
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
  p.stream?.getTracks().forEach((tr) => tr.stop());
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
    toast(t('Cannot play {name}: {error}', { name: asset.name, error: e.message }), 'error');
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
      toast(t('{name} joined backstage', { name: m.name }));
      // Automated checks bring every guest on stage.
      if (smoke) setTimeout(() => !stageIds.includes(m.id) && toggleStage(m.id), 500);
      break;
    case 'guest-left':
      removeGuest(m.id);
      break;
    case 'answer': {
      const g = people.get(m.from);
      g?.pc?.setRemoteDescription({ type: 'answer', sdp: m.sdp })
        .then(() => limitReturnFeed(g.pc))
        .catch((e) => toast(t('Guest connection failed: {error}', { error: e.message }), 'error'));
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
      chatStatus = m.state === 'connected'
        ? t('Connected to #{channel}', { channel: m.channel })
        : t('Reconnecting… {error}', { error: m.error || '' });
      if (tab === 'comments') renderPanel();
      break;
    case 'sharing':
      sharing = m;
      if (openDialogKind === 'invite' && $('#dialog').open) inviteDialog({ refresh: false });
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
    toast(t('Choose at least one destination.'), 'error');
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

function outputState(state) {
  return {
    connecting: t('connecting'),
    live: t('live'),
    reconnecting: t('reconnecting'),
    stopped: t('stopped'),
    failed: t('failed'),
  }[state] || state;
}

function finishBroadcast(result) {
  mixer.stopCapture();
  const mode = live.mode;
  live = { state: 'idle', mode: null, status: null };
  renderTopbar();
  if (tab === 'destinations') renderPanel();
  if (!result) {
    if (mode) toast(t('Broadcast ended.'));
    return;
  }
  const rec = result.recording;
  const body = [
    h('h2', {}, mode === 'record' ? t('Recording saved') : t('Broadcast ended')),
    (result.outputs || []).length
      ? h('ul', { class: 'summary' }, result.outputs.map((o) => h('li', {},
        t('{name}: {bytes} sent', { name: o.name, bytes: formatBytes(o.bytes) }),
        o.dropped ? ` · ${t('{count} packets dropped', { count: o.dropped })}` : '',
        o.error ? ` · ${t('last error: {error}', { error: o.error })}` : '')))
      : null,
    rec?.path ? h('p', {}, t('Recording:'), ' ', h('code', {}, rec.path), ` (${formatBytes(rec.bytes)})`) : null,
    rec?.error ? h('p', { class: 'error' }, t('Recording error: {error}', { error: rec.error })) : null,
  ];
  openDialog(body, [
    rec?.path ? h('button', { class: 'btn', type: 'button', onclick: () => api.post('/api/recordings/open') }, t('Open recordings folder')) : null,
    h('button', { class: 'btn primary', type: 'button', onclick: closeDialog }, t('Done')),
  ]);
}

// ---------------------------------------------------------------- dialogs

function openDialog(body, actions, kind = null) {
  const d = $('#dialog');
  openDialogKind = kind;
  d.replaceChildren(
    h('form', { method: 'dialog', class: 'dialog-body', onsubmit: (e) => e.preventDefault() },
      h('button', { class: 'icon-btn dialog-close', type: 'button', 'aria-label': t('Close'), onclick: closeDialog }, icon('close')),
      body,
      h('div', { class: 'dialog-actions' }, actions)),
  );
  if (!d.open) d.showModal();
}

function closeDialog() {
  openDialogKind = null;
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
      h('button', { class: 'btn', type: 'button', onclick: () => done(false) }, t('Cancel')),
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
    toast(t('Add a destination (YouTube, Twitch, Facebook, any RTMP server) first.'));
    return;
  }
  const checks = enabled.map((d) => {
    const input = h('input', { type: 'checkbox', checked: S.destSelection[d.id] !== false, 'data-id': d.id });
    return h('label', { class: 'check' }, input, h('span', {}, d.name), h('small', {}, PLATFORMS[d.platform]?.label || 'RTMP'));
  });
  const rec = h('input', { type: 'checkbox', checked: S.settings.recordWhileLive });
  openDialog(
    [h('h2', {}, t('Go live')), h('p', { class: 'muted' }, t('Stream to:')), h('div', { class: 'checks' }, checks), h('label', { class: 'check' }, rec, h('span', {}, t('Also record to this computer')))],
    [
      h('button', { class: 'btn', type: 'button', onclick: closeDialog }, t('Cancel')),
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
      }, t('Go live now')),
    ],
  );
}

const SHARING_MODES = [
  ['local', 'monitor', () => t('This computer'), () => t('For testing on this computer')],
  ['lan', 'wifi', () => t('Local network'), () => t('Same Wi‑Fi or office network')],
  ['internet', 'globe', () => t('Internet'), () => t('Anyone with the link, anywhere')],
];

async function setSharingMode(mode) {
  try {
    sharing = await api.put('/api/sharing', { mode });
  } catch (e) {
    toast(e.message, 'error');
  }
  inviteDialog({ refresh: false });
}

function sharingNotes() {
  if (!sharing) return null;
  if (sharing.mode === 'local') {
    return h('p', { class: 'note' }, t('This link works only on this computer. To invite someone else, choose Local network or Internet.'));
  }
  if (sharing.mode === 'lan') {
    if (sharing.lanError) return h('p', { class: 'note error' }, t('The local network link could not start: {error}', { error: sharing.lanError }));
    return h('p', { class: 'note' }, t('Guests on your network open the link and accept the security warning once (the certificate is made by streamFree on this computer).'));
  }
  const tunnel = sharing.tunnel || {};
  if (!sharing.cloudflared) {
    const how = cloudflaredInstall();
    return h('div', { class: 'note' },
      h('p', {}, t('Internet links use the free cloudflared tool, which is not installed yet.')),
      how.command
        ? h('p', {}, t('Install it with this command, then choose Internet again:'), ' ', h('code', {}, how.command))
        : h('p', {}, t('Install it from Cloudflare, then choose Internet again.')),
      h('p', {}, h('a', { href: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/', target: '_blank', rel: 'noopener' }, t('Download cloudflared'))));
  }
  if (tunnel.state === 'starting') return h('p', { class: 'note' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' ', t('Creating your internet link… this takes a few seconds.'));
  if (tunnel.state === 'error') return h('p', { class: 'note error' }, t('The internet link could not start: {error}', { error: tunnel.error || '' }));
  return h('p', { class: 'note' }, t('Anyone with this link can ask to join. You decide who goes on stage. The address changes each time streamFree restarts.'));
}

async function inviteDialog({ refresh = true } = {}) {
  if (refresh) {
    try {
      sharing = await api.get('/api/sharing');
    } catch {
      // keep the last known state
    }
  }
  const url = sharing?.inviteUrl || info.inviteUrl;
  const ready = sharing?.mode === 'local' || (sharing?.mode === 'lan' && sharing.lanUrl) || (sharing?.mode === 'internet' && sharing.tunnel?.state === 'on');
  const message = t('Join me live on {show}! Open this link in your browser: {url}', { show: S.title || 'streamFree', url });
  const enc = encodeURIComponent;
  const linkInput = h('input', { value: url, readOnly: true, 'aria-label': t('Invite link'), onfocus: (e) => e.target.select() });
  openDialog(
    [
      h('h2', {}, t('Invite guests')),
      h('p', { class: 'muted' }, t('Guests join from their browser, with nothing to install. They wait backstage until you add them to the stage.')),
      h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': t('Who can join?') },
        SHARING_MODES.map(([mode, ico, label, desc]) => h('button', {
          type: 'button',
          role: 'radio',
          'aria-checked': String(sharing?.mode === mode),
          class: sharing?.mode === mode ? 'active' : '',
          onclick: () => sharing?.mode !== mode && setSharingMode(mode),
        }, icon(ico, 18), h('strong', {}, label()), h('small', {}, desc())))),
      sharingNotes(),
      ready ? h('div', { class: 'invite-share' },
        h('img', { class: 'qr', src: `/api/invite/qr.svg?t=${enc(token)}&v=${enc(url)}`, alt: t('QR code of the invite link'), width: 132, height: 132 }),
        h('div', { class: 'stack grow' },
          h('div', { class: 'copy-row' }, linkInput,
            h('button', { class: 'btn', type: 'button', onclick: () => copyText(url, linkInput).then((ok) => toast(ok ? t('Link copied') : t('Select the link and copy it'))) }, icon('copy', 16), t('Copy'))),
          h('div', { class: 'share-row' },
            h('button', { class: 'btn small', type: 'button', onclick: () => copyText(message).then((ok) => ok && toast(t('Invitation copied'))) }, t('Copy invitation')),
            h('a', { class: 'btn small', href: `https://wa.me/?text=${enc(message)}`, target: '_blank', rel: 'noopener' }, 'WhatsApp'),
            h('a', { class: 'btn small', href: `https://t.me/share/url?url=${enc(url)}&text=${enc(t('Join me live on {show}!', { show: S.title || 'streamFree' }))}`, target: '_blank', rel: 'noopener' }, 'Telegram'),
            h('a', { class: 'btn small', href: `mailto:?subject=${enc(t('Join me live on {show}!', { show: S.title || 'streamFree' }))}&body=${enc(message)}` }, t('Email'))),
          h('small', { class: 'muted' }, t('Guests on a phone can scan the QR code.')))) : null,
    ],
    [
      h('button', {
        class: 'btn', type: 'button', onclick: async () => {
          const ok = await confirmDialog(t('Create a new link? The current link stops working.'), t('Create new link'));
          if (!ok) return;
          await api.post('/api/invite/reset');
          toast(t('New link created. The old one no longer works.'));
          inviteDialog();
        },
      }, t('New link')),
      h('button', { class: 'btn primary', type: 'button', onclick: closeDialog }, t('Done')),
    ],
    'invite',
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
      h('h2', {}, t('Video clips')),
      h('p', { class: 'muted' }, t('Intros, outros, trailers: play them full screen with their sound.')),
      videos.length
        ? h('ul', { class: 'asset-list' }, videos.map((a) => h('li', {},
          h('span', {}, a.name),
          h('button', { class: 'btn small', type: 'button', onclick: () => { closeDialog(); playMedia(a); } }, t('Play')),
          h('button', { class: 'btn small ghost', type: 'button', onclick: () => { removeAsset(a.id); mediaDialog(); } }, t('Delete')))))
        : h('p', { class: 'muted' }, t('No clips yet.')),
      fileInput,
    ],
    [
      people.has('media') ? h('button', { class: 'btn', type: 'button', onclick: () => { stopSource('media'); closeDialog(); } }, t('Stop playing clip')) : null,
      h('button', { class: 'btn primary', type: 'button', onclick: () => fileInput.click() }, t('Upload clip')),
    ],
  );
}

async function uploadAsset(file, kind) {
  try {
    toast(t('Uploading {name}…', { name: file.name }));
    const r = await api.upload(file);
    const asset = { id: r.id, name: file.name, kind };
    S.assets.push(asset);
    if (kind === 'image') await loadImage(asset.id);
    changed({ scene: false });
    return asset;
  } catch (e) {
    toast(t('Upload failed: {error}', { error: e.message }), 'error');
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
  const themeBtn = $('#theme-toggle');
  const drawThemeBtn = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    themeBtn.replaceChildren(icon(dark ? 'sun' : 'moon'));
    themeBtn.setAttribute('aria-label', dark ? t('Switch to light theme') : t('Switch to dark theme'));
  };
  drawThemeBtn();
  themeBtn.addEventListener('click', () => {
    S.ui.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyAppearance();
    drawThemeBtn();
    saveStudio();
    if (tab === 'settings') renderPanel();
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
  recBtn.textContent = live.mode === 'record' && live.state !== 'idle' ? t('Stop recording') : t('Record');
  liveBtn.textContent = live.mode === 'live' && live.state !== 'idle' ? t('End broadcast') : t('Go live');
  recBtn.classList.toggle('danger', live.mode === 'record' && live.state !== 'idle');
  liveBtn.classList.toggle('danger', live.mode === 'live' && live.state !== 'idle');
  if (live.state === 'idle') {
    status.replaceChildren(h('span', { class: 'pill' }, t('Offline')));
    badge.hidden = true;
    return;
  }
  const label = { starting: t('Starting…'), stopping: t('Finishing…'), live: live.mode === 'record' ? 'REC' : 'LIVE' }[live.state];
  const parts = [h('span', { class: `pill ${live.mode === 'record' ? 'rec' : 'live'}` }, label)];
  if (s) {
    parts.push(h('span', { class: 'elapsed' }, formatDuration(s.elapsed)));
    for (const o of s.outputs || []) {
      parts.push(h('span', { class: `out ${o.state}`, title: o.error || outputState(o.state) }, `${o.name} · ${o.state === 'live' ? `${o.kbps} kbps` : outputState(o.state)}`));
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
    title: t(l.label),
    'aria-label': t(l.label),
    'aria-pressed': String(S.layout === l.id),
    onclick: () => {
      S.layout = l.id;
      renderLayouts();
      changed();
    },
  }, layoutIcon(l.id), h('small', {}, t(l.label)))));
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

function connectionLabel(state) {
  return {
    new: t('connecting'),
    connecting: t('connecting'),
    disconnected: t('reconnecting'),
    failed: t('connection failed'),
    closed: t('disconnected'),
  }[state] || state;
}

function personCard(p) {
  const onStage = stageIds.includes(p.id);
  const isFeatured = featured === p.id;
  const video = thumbVideo(p);
  const nameInput = h('input', {
    class: 'name', value: p.name, 'aria-label': t('Display name'), onchange: (e) => {
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
    actions.push(h('button', { class: `btn small ${onStage ? '' : 'primary'}`, onclick: () => toggleStage(p.id) }, onStage ? t('Remove') : t('Add to stage')));
  } else {
    actions.push(h('button', {
      class: `btn small ${isFeatured ? '' : 'primary'}`, onclick: () => {
        featured = isFeatured ? null : p.id;
        renderPeople();
        pushScene();
      },
    }, isFeatured ? t('Hide') : t('Show')));
    actions.push(h('button', { class: 'btn small ghost', onclick: () => stopSource(p.id) }, t('Stop')));
  }
  if (p.kind === 'guest') {
    const muteLabel = p.muted ? t('Unmute guest') : t('Mute guest');
    actions.push(h('button', {
      class: 'icon-btn', title: muteLabel, 'aria-label': muteLabel, onclick: () => {
        p.muted = !p.muted;
        mixer.setMuted(p.id, p.muted);
        renderPeople();
      },
    }, icon(p.muted ? 'micOff' : 'mic', 16)));
    actions.push(h('button', {
      class: 'icon-btn', title: t('Remove from studio'), 'aria-label': t('Remove from studio'), onclick: () => {
        confirmDialog(t('Remove {name} from the studio?', { name: p.name }), t('Remove')).then((ok) => ok && send({ to: p.id, type: 'kick' }));
      },
    }, icon('close', 16)));
  }
  const badges = [];
  if (onStage) badges.push(h('span', { class: 'badge on' }, t('On stage')));
  if (isFeatured) badges.push(h('span', { class: 'badge on' }, t('Showing')));
  if (p.kind === 'guest' && p.connection && p.connection !== 'connected') badges.push(h('span', { class: 'badge' }, connectionLabel(p.connection)));
  if (p.micOn === false) badges.push(h('span', { class: 'badge' }, t('mic off')));
  if (p.camOn === false) badges.push(h('span', { class: 'badge' }, t('cam off')));
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
    cards.push(h('button', { class: 'person invite-card', onclick: () => inviteDialog() }, icon('invite', 28), h('span', {}, t('Invite a guest'))));
  }
  $('#people').replaceChildren(...cards);
}

function renderControls() {
  const host = people.get('host');
  const mic = host?.micOn !== false;
  const cam = host?.camOn !== false;
  const ctl = (name, label, onclick, active = false) => h('button', { class: `ctl ${active ? 'active' : ''}`, onclick, 'aria-label': label }, icon(name), h('small', {}, label));
  $('#controls').replaceChildren(
    ctl(mic ? 'mic' : 'micOff', mic ? t('Mute') : t('Unmute'), () => {
      host.micOn = !mic;
      host.stream.getAudioTracks().forEach((tr) => (tr.enabled = host.micOn));
      renderControls();
      renderPeople();
    }, !mic),
    ctl(cam ? 'cam' : 'camOff', cam ? t('Stop cam') : t('Start cam'), () => {
      host.camOn = !cam;
      host.stream.getVideoTracks().forEach((tr) => (tr.enabled = host.camOn));
      renderControls();
      renderPeople();
      pushScene();
    }, !cam),
    ctl('screen', people.has('screen') ? t('Stop share') : t('Share screen'), shareScreen, people.has('screen')),
    ctl('media', t('Video clips'), mediaDialog, people.has('media')),
    ctl('invite', t('Invite'), () => inviteDialog()),
    ctl('gear', t('Settings'), () => { tab = 'settings'; renderTabs(); renderPanel(); }),
  );
}

const TABS = [
  ['brand', () => t('Brand')],
  ['style', () => t('Style')],
  ['banners', () => t('Banners')],
  ['comments', () => t('Comments')],
  ['chat', () => t('Chat')],
  ['destinations', () => t('Destinations')],
  ['settings', () => t('Settings')],
  ['help', () => t('Help')],
];

function renderTabs() {
  $('#tabs').replaceChildren(...TABS.map(([id, label]) => h('button', {
    role: 'tab', class: `tab ${tab === id ? 'active' : ''}`, 'aria-selected': String(tab === id), onclick: () => {
      tab = id;
      renderTabs();
      renderPanel();
    },
  }, label())));
}

function field(label, control, hint) {
  // A <label> around several buttons would forward clicks on its text to the
  // first button, so groups use a plain container.
  const single = ['INPUT', 'SELECT', 'TEXTAREA'].includes(control.tagName);
  return h(single ? 'label' : 'div', { class: 'field' }, h('span', {}, label), control, hint ? h('small', { class: 'muted' }, hint) : null);
}

function section(title, ...children) {
  return h('section', { class: 'card' }, h('h3', {}, title), children);
}

function select(value, options, onChange) {
  return h('select', { onchange: (e) => onChange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v, selected: value === v }, label)));
}

function segmented(value, options, onChange, label) {
  return h('div', { class: 'segmented small', role: 'radiogroup', 'aria-label': label },
    options.map(([v, text]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(value === v), class: value === v ? 'active' : '',
      onclick: () => onChange(v),
    }, text)));
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
    allowNone ? h('button', { class: `thumb-btn none ${!selectedId ? 'active' : ''}`, onclick: () => onPick(null) }, t('None')) : null,
    imgs.map((a) => h('button', { class: `thumb-btn ${selectedId === a.id ? 'active' : ''}`, title: a.name, onclick: () => onPick(a.id) },
      h('img', { src: api.assetUrl(a.id), alt: a.name, loading: 'lazy' }))),
    h('button', { class: 'thumb-btn add', onclick: () => input.click(), 'aria-label': t('Upload image') }, '+'),
    input);
}

function renderPanel() {
  const panel = $('#panel');
  const render = {
    brand: brandPanel,
    style: stylePanel,
    banners: bannersPanel,
    comments: commentsPanel,
    chat: chatPanel,
    destinations: destinationsPanel,
    settings: settingsPanel,
    help: helpPanel,
  }[tab];
  panel.replaceChildren(...[render()].flat().filter(Boolean));
}

function brandPanel() {
  const set = (fn) => (e) => {
    fn(e.target);
    changed();
  };
  return [
    section(t('Colors'),
      h('div', { class: 'row' },
        field(t('Brand color'), h('input', { type: 'color', value: S.theme.primary, oninput: set((el) => (S.theme.primary = el.value)) })),
        field(t('Text color'), h('input', { type: 'color', value: S.theme.text, oninput: set((el) => (S.theme.text = el.value)) })))),
    section(t('Logo'),
      imagePicker('logo', S.logo.id, (id) => { S.logo.id = id; changed(); renderPanel(); }),
      h('div', { class: 'row' },
        field(t('Position'), select(S.logo.position, [['tl', t('Top left')], ['tr', t('Top right')], ['bl', t('Bottom left')], ['br', t('Bottom right')]], (v) => { S.logo.position = v; changed(); })),
        field(t('Size'), h('input', { type: 'range', min: 0.05, max: 0.3, step: 0.01, value: S.logo.size, oninput: set((el) => (S.logo.size = Number(el.value))) })))),
    section(t('Overlay'),
      h('p', { class: 'muted' }, t('A full-screen PNG with transparency, drawn over the video (1280×720 or 1920×1080).')),
      imagePicker('overlay', S.overlayId, (id) => { S.overlayId = id; changed(); renderPanel(); })),
    section(t('Background'),
      field(t('Color'), h('input', { type: 'color', value: S.background.color, oninput: set((el) => (S.background.color = el.value)) })),
      imagePicker('background', S.background.imageId, (id) => { S.background.imageId = id; changed(); renderPanel(); })),
  ];
}

function stylePanel() {
  const th = S.theme;
  const update = (fn) => {
    fn();
    changed();
    renderPanel();
  };
  return [
    section(t('Text'),
      field(t('Font'), select(th.font, [
        ['sans', t('Modern')], ['rounded', t('Rounded')], ['serif', t('Classic serif')], ['mono', t('Monospace')], ['condensed', t('Condensed')],
      ], (v) => update(() => (th.font = v)))),
      h('p', { class: 'font-sample', style: { fontFamily: FONTS[th.font] || FONTS.sans } }, t('The quick brown fox jumps over the lazy dog'))),
    section(t('Name tags'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.showNames, onchange: (e) => { S.showNames = e.target.checked; changed(); } }), h('span', {}, t('Show display names'))),
      field(t('Shape'), segmented(th.style, [['pill', t('Bubble')], ['block', t('Block')], ['minimal', t('Minimal')]], (v) => update(() => (th.style = v)), t('Shape'))),
      field(t('Position'), segmented(th.namePos, [['bl', t('Bottom left')], ['bc', t('Bottom center')], ['tl', t('Top left')]], (v) => update(() => (th.namePos = v)), t('Position')))),
    section(t('Banners'),
      field(t('Look'), segmented(th.bannerStyle, [['solid', t('Solid')], ['gradient', t('Gradient')], ['outline', t('Outline')], ['glass', t('Glass')]], (v) => update(() => (th.bannerStyle = v)), t('Look'))),
      field(t('Position'), segmented(th.bannerPos, [['left', t('Left')], ['center', t('Center')]], (v) => update(() => (th.bannerPos = v)), t('Position')))),
    section(t('Ticker'),
      h('div', { class: 'row' },
        field(t('Background'), h('input', { type: 'color', value: th.tickerBg || th.primary, oninput: (e) => { th.tickerBg = e.target.value; changed(); } })),
        field(t('Text color'), h('input', { type: 'color', value: th.tickerText || th.text, oninput: (e) => { th.tickerText = e.target.value; changed(); } }))),
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => update(() => { th.tickerBg = ''; th.tickerText = ''; }) }, t('Use brand colors'))),
    section(t('Tiles'),
      field(t('Spacing'), h('input', { type: 'range', min: 0, max: 3, step: 0.25, value: th.spacing, oninput: (e) => { th.spacing = Number(e.target.value); changed(); } })),
      field(t('Rounded corners'), h('input', { type: 'range', min: 0, max: 0.04, step: 0.002, value: th.radius, oninput: (e) => { th.radius = Number(e.target.value); changed(); } }))),
  ];
}

function bannersPanel() {
  const title = h('input', { placeholder: t('Title, e.g. Welcome to the show'), maxLength: 80 });
  const subtitle = h('input', { placeholder: t('Subtitle (optional)'), maxLength: 120 });
  const tickerText = h('input', { value: S.ticker.text, placeholder: t('Scrolling text'), maxLength: 300, oninput: (e) => { S.ticker.text = e.target.value; changed(); } });
  return [
    section(t('Banners'),
      h('form', {
        class: 'stack', onsubmit: (e) => {
          e.preventDefault();
          if (!title.value.trim() && !subtitle.value.trim()) return;
          S.banners.push({ id: crypto.randomUUID(), title: title.value.trim(), subtitle: subtitle.value.trim() });
          changed({ scene: false });
          renderPanel();
        },
      }, title, subtitle, h('button', { class: 'btn', type: 'submit' }, t('Add banner'))),
      S.banners.length ? h('ul', { class: 'banner-list' }, S.banners.map((b) => {
        const active = S.activeBanner === b.id;
        return h('li', { class: active ? 'active' : '' },
          h('div', {}, h('strong', {}, b.title), b.subtitle ? h('small', {}, b.subtitle) : null),
          h('button', { class: `btn small ${active ? '' : 'primary'}`, onclick: () => { S.activeBanner = active ? null : b.id; changed(); renderPanel(); } }, active ? t('Hide') : t('Show')),
          h('button', { class: 'icon-btn', 'aria-label': t('Delete banner'), onclick: () => { S.banners = S.banners.filter((x) => x.id !== b.id); if (active) S.activeBanner = null; changed(); renderPanel(); } }, icon('close', 16)));
      })) : h('p', { class: 'muted' }, t('Create banners before the show and put them on screen with one click.'))),
    section(t('Ticker'),
      tickerText,
      field(t('Speed'), h('input', { type: 'range', min: 0.3, max: 3, step: 0.1, value: S.ticker.speed, oninput: (e) => { S.ticker.speed = Number(e.target.value); changed(); } })),
      h('button', { class: `btn ${S.ticker.on ? '' : 'primary'}`, onclick: () => { S.ticker.on = !S.ticker.on; changed(); renderPanel(); } }, S.ticker.on ? t('Hide ticker') : t('Show ticker'))),
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
  const channel = h('input', { placeholder: t('Twitch channel name'), value: S.twitchChannel || '' });
  const author = h('input', { placeholder: t('Name'), maxLength: 40 });
  const text = h('input', { placeholder: t('Comment or question'), maxLength: 300 });
  return [
    section(t('Live chat'),
      h('form', {
        class: 'row', onsubmit: async (e) => {
          e.preventDefault();
          try {
            const r = await api.post('/api/chat/twitch', { channel: channel.value });
            S.twitchChannel = r.channel;
            chatStatus = t('Connecting to #{channel}…', { channel: r.channel });
            saveStudio();
            renderPanel();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }, channel, h('button', { class: 'btn', type: 'submit' }, t('Connect'))),
      chatStatus
        ? h('p', { class: 'muted' }, chatStatus, ' ', h('button', { class: 'link', onclick: async () => { await api.del('/api/chat/twitch'); chatStatus = ''; renderPanel(); } }, t('Disconnect')))
        : h('p', { class: 'muted' }, t('Read-only Twitch chat, no login needed. Add other platforms’ questions below.'))),
    section(t('Add a comment'),
      h('form', {
        class: 'stack', onsubmit: (e) => {
          e.preventDefault();
          if (!text.value.trim()) return;
          const c = { id: crypto.randomUUID(), author: author.value.trim() || t('Viewer'), text: text.value.trim(), platform: '' };
          comments.unshift(c);
          showComment(c);
        },
      }, author, text, h('button', { class: 'btn', type: 'submit' }, t('Show on screen')))),
    currentComment ? h('button', { class: 'btn danger full', onclick: () => showComment(null) }, t('Hide comment from screen')) : null,
    h('ul', { class: 'comments' }, comments.map((c) => h('li', { class: `${hiddenComment === c.id ? 'active' : ''} ${c.shown ? 'shown' : ''}` },
      h('div', {}, h('strong', { style: { color: c.color || 'inherit' } }, c.author), c.platform ? h('small', {}, ` · ${c.platform}`) : null, h('p', {}, c.text)),
      h('button', { class: 'btn small', onclick: () => showComment(hiddenComment === c.id ? null : c) }, hiddenComment === c.id ? t('Hide') : t('Show'))))),
  ];
}

function chatPanel() {
  const input = h('input', { placeholder: t('Message all guests'), maxLength: 500 });
  return [
    section(t('Backstage chat'),
      h('p', { class: 'muted' }, t('Private messages between you and your guests. Viewers never see these.')),
      h('ul', { class: 'chat' }, backstageChat.slice(-100).map((m) => h('li', {}, h('strong', {}, m.author), ' ', m.text))),
      h('form', {
        class: 'row', onsubmit: (e) => {
          e.preventDefault();
          const text = input.value.trim();
          if (!text) return;
          for (const p of people.values()) if (p.kind === 'guest') send({ to: p.id, type: 'chat', text, author: S.hostName || 'Host' });
          backstageChat.push({ author: t('You'), text, at: Date.now() });
          renderPanel();
        },
      }, input, h('button', { class: 'btn', type: 'submit' }, t('Send')))),
  ];
}

function renderLiveOutputs() {
  const host = document.querySelector('#live-outputs');
  if (!host || !live.status) return;
  host.replaceChildren(...(live.status.outputs || []).map((o) => h('li', { class: o.state }, h('strong', {}, o.name), ` — ${outputState(o.state)}${o.state === 'live' ? ` · ${o.kbps} kbps` : ''}${o.error ? ` · ${o.error}` : ''}`)));
}

function guideBlock(platformId) {
  const p = PLATFORMS[platformId] || PLATFORMS.custom;
  return h('details', { class: 'guide' },
    h('summary', {}, platformId === 'custom' ? t('How does a custom server work?') : t('Where do I find the key on {platform}?', { platform: p.label })),
    h('ol', {}, platformGuide(platformId).map((step) => h('li', {}, step))),
    p.link ? h('p', {}, h('a', { href: p.link, target: '_blank', rel: 'noopener' }, t('Open {platform}', { platform: p.label }))) : null);
}

function destinationForm(existing) {
  const platform = h('select', {}, Object.entries(PLATFORMS).map(([v, p]) => h('option', { value: v, selected: (existing?.platform || 'youtube') === v }, v === 'custom' ? t('Custom RTMP') : p.label)));
  const name = h('input', { placeholder: t('Name'), value: existing?.name || '', maxLength: 60, required: true });
  const url = h('input', { placeholder: 'rtmp://… / rtmps://…', value: existing?.url || PLATFORMS.youtube.url, required: true });
  const key = h('input', { type: 'password', placeholder: existing?.hasKey ? t('Saved key {hint}, leave empty to keep it', { hint: existing.keyHint }) : t('Stream key'), autocomplete: 'off' });
  const guide = h('div', {}, guideBlock(existing?.platform || 'youtube'));
  platform.addEventListener('change', () => {
    const p = PLATFORMS[platform.value];
    if (p.url || !existing) url.value = p.url;
    if (!name.value || Object.values(PLATFORMS).some((x) => x.label === name.value) || name.value === t('Custom RTMP')) {
      name.value = platform.value === 'custom' ? t('Custom RTMP') : p.label;
    }
    guide.replaceChildren(guideBlock(platform.value));
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
        toast(t('{name} saved', { name: saved.name }));
        if (existing) closeDialog();
        renderPanel();
      } catch (err) {
        toast(err.message, 'error');
      }
    },
  }, field(t('Platform'), platform), guide, field(t('Name'), name), field(t('Server URL'), url), field(t('Stream key'), key),
  h('button', { class: 'btn primary', type: 'submit' }, existing ? t('Save changes') : t('Add destination')));
}

async function testDestination(d, button) {
  button.disabled = true;
  button.textContent = t('Testing…');
  try {
    const r = await api.post(`/api/destinations/${d.id}/test`);
    if (r.ok) toast(t('{name}: the server answered ({server}). The key is checked when you go live.', { name: d.name, server: r.server }));
    else toast(t('{name}: {error}', { name: d.name, error: r.message }), 'error');
  } catch (e) {
    toast(e.message, 'error');
  }
  button.disabled = false;
  button.textContent = t('Test');
}

function destinationsPanel() {
  return [
    live.state !== 'idle' ? section(t('Now streaming'), h('ul', { id: 'live-outputs', class: 'outputs' })) : null,
    section(t('Destinations'),
      destinations.length ? h('ul', { class: 'dest-list' }, destinations.map((d) => {
        const testBtn = h('button', { class: 'btn small ghost', type: 'button' }, t('Test'));
        testBtn.addEventListener('click', () => testDestination(d, testBtn));
        return h('li', {},
          h('label', { class: 'switch', title: d.enabled ? t('Enabled') : t('Disabled') },
            h('input', {
              type: 'checkbox', checked: d.enabled, 'aria-label': t('Use {name}', { name: d.name }), onchange: async (e) => {
                const saved = await api.post('/api/destinations', { id: d.id, name: d.name, platform: d.platform, url: d.url, enabled: e.target.checked });
                Object.assign(d, saved);
              },
            }), h('span', {})),
          h('div', { class: 'grow' }, h('strong', {}, d.name), h('small', {}, `${PLATFORMS[d.platform]?.label || 'RTMP'} · ${d.hasKey ? t('key {hint}', { hint: d.keyHint || t('saved') }) : t('no key')}`)),
          testBtn,
          h('button', { class: 'btn small ghost', onclick: () => openDialog([h('h2', {}, t('Edit {name}', { name: d.name })), destinationForm(d)], []) }, t('Edit')),
          h('button', {
            class: 'icon-btn', 'aria-label': t('Delete {name}', { name: d.name }), onclick: async () => {
              if (!(await confirmDialog(t('Delete {name}?', { name: d.name }), t('Delete')))) return;
              await api.del(`/api/destinations/${d.id}`);
              destinations = destinations.filter((x) => x.id !== d.id);
              renderPanel();
            },
          }, icon('close', 16)));
      })) : h('p', { class: 'muted' }, t('Stream keys stay on this computer and are never shown again after saving.'))),
    section(t('Add a destination'), destinationForm(null)),
  ];
}

function appearanceSection() {
  const ui = S.ui;
  const update = (fn) => {
    fn();
    applyAppearance();
    saveStudio();
    renderAll();
    translateStatic();
  };
  const customAccent = h('input', { type: 'color', value: ui.accent, 'aria-label': t('Custom color'), oninput: (e) => { ui.accent = e.target.value; applyAppearance(); saveStudio(); } });
  return section(t('Appearance'),
    field(t('Language'), select(ui.lang || getLang(), [['it', 'Italiano'], ['en', 'English']], (v) => update(() => (ui.lang = v)))),
    field(t('Theme'), segmented(ui.theme, [['auto', t('Automatic')], ['dark', t('Dark')], ['light', t('Light')]], (v) => update(() => (ui.theme = v)), t('Theme'))),
    field(t('Accent color'), h('div', { class: 'swatches' },
      ACCENTS.map((c) => h('button', {
        type: 'button', class: `swatch ${ui.accent === c ? 'active' : ''}`, style: { background: c }, 'aria-label': c, 'aria-pressed': String(ui.accent === c),
        onclick: () => update(() => (ui.accent = c)),
      })),
      customAccent)),
    field(t('Text size'), segmented(ui.textSize, [['s', t('Small')], ['m', t('Medium')], ['l', t('Large')]], (v) => update(() => (ui.textSize = v)), t('Text size'))),
    field(t('Density'), segmented(ui.density, [['comfortable', t('Comfortable')], ['compact', t('Compact')]], (v) => update(() => (ui.density = v)), t('Density'))),
    field(t('Side panel'), segmented(ui.panelSide, [['right', t('Right')], ['left', t('Left')]], (v) => update(() => (ui.panelSide = v)), t('Side panel'))));
}

function settingsPanel() {
  const st = S.settings;
  const devices = h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('Loading devices…')));
  navigator.mediaDevices.enumerateDevices().then((list) => {
    const opts = (kind, current) => [h('option', { value: '' }, t('Default')), ...list.filter((d) => d.kind === kind).map((d) => h('option', { value: d.deviceId, selected: d.deviceId === current }, d.label || kind))];
    devices.replaceChildren(
      field(t('Camera'), h('select', { onchange: (e) => { st.camId = e.target.value; saveStudio(); startCamera(); } }, opts('videoinput', st.camId))),
      field(t('Microphone'), h('select', { onchange: (e) => { st.micId = e.target.value; saveStudio(); startCamera(); } }, opts('audioinput', st.micId))),
    );
  });
  const idle = live.state === 'idle';
  const iceText = h('textarea', { rows: 4, spellcheck: false }, JSON.stringify(info.iceServers, null, 2));
  const check = (checked, label, onchange) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) }), h('span', {}, label));
  return [
    appearanceSection(),
    section(t('Output'),
      h('div', { class: 'row' },
        field(t('Resolution'), h('select', { disabled: !idle, onchange: (e) => { st.resolution = e.target.value; applyOutput(); } },
          [['720p', '1280×720 (HD)'], ['1080p', '1920×1080 (Full HD)']].map(([v, l]) => h('option', { value: v, selected: st.resolution === v }, l)))),
        field(t('Frame rate'), h('select', { disabled: !idle, onchange: (e) => { st.fps = Number(e.target.value); applyOutput(); } },
          [30, 60].map((v) => h('option', { value: v, selected: st.fps === v }, `${v} fps`))))),
      h('div', { class: 'row' },
        field(t('Video bitrate (kbps)'), h('input', { type: 'number', min: 500, max: 20000, step: 100, value: st.videoKbps, disabled: !idle, onchange: (e) => { st.videoKbps = Number(e.target.value); saveStudio(); } })),
        field(t('Audio bitrate (kbps)'), h('select', { disabled: !idle, onchange: (e) => { st.audioKbps = Number(e.target.value); saveStudio(); } },
          [96, 128, 160, 192, 256].map((v) => h('option', { value: v, selected: st.audioKbps === v }, v))))),
      h('small', { class: 'muted' }, t('YouTube suggests 4500–9000 kbps for 1080p30 and 2500–6000 for 720p.'))),
    section(t('Camera and microphone'), devices,
      check(st.mirror, t('Mirror my camera'), (v) => { st.mirror = v; changed(); renderPeople(); }),
      check(st.echoCancellation, t('Echo cancellation'), (v) => { st.echoCancellation = v; saveStudio(); startCamera(); }),
      check(st.noiseSuppression, t('Noise suppression'), (v) => { st.noiseSuppression = v; saveStudio(); startCamera(); }),
      check(st.autoGainControl, t('Automatic gain'), (v) => { st.autoGainControl = v; saveStudio(); startCamera(); }),
      check(st.monitor, t('Hear guests and clips on this computer (use headphones)'), (v) => { st.monitor = v; mixer.setMonitor(v); saveStudio(); })),
    section(t('Guests'),
      h('button', { class: 'btn', onclick: () => inviteDialog() }, t('Invite guests')),
      field(t('ICE servers (STUN/TURN)'), iceText, t('Add a TURN server if guests behind strict firewalls cannot connect. JSON list of {urls, username, credential}.')),
      h('button', {
        class: 'btn small', onclick: async () => {
          try {
            const value = JSON.parse(iceText.value);
            if (!Array.isArray(value)) throw new Error(t('expected a JSON list'));
            await api.put('/api/ice', value);
            info.iceServers = value;
            toast(t('ICE servers saved. They apply to guests who join from now on.'));
          } catch (e) {
            toast(t('Invalid ICE servers: {error}', { error: e.message }), 'error');
          }
        },
      }, t('Save ICE servers'))),
    section(t('Recordings'),
      h('p', {}, h('code', {}, info.recordingsDir)),
      h('button', { class: 'btn', onclick: () => api.post('/api/recordings/open').catch((e) => toast(e.message, 'error')) }, t('Open folder'))),
    h('p', { class: 'muted center' }, t('streamFree {version} · free and open source (MIT)', { version: info.version })),
  ];
}

function helpPanel() {
  return [
    ...helpTopics().map(([title, paragraphs]) => section(title, paragraphs.map((p) => h('p', {}, p)))),
    section(t('Go live on a platform'),
      h('p', { class: 'muted' }, t('Each platform gives you a server address and a secret stream key. Paste them in Destinations.')),
      Object.keys(PLATFORMS).map((id) => guideBlock(id))),
    section(t('About'),
      h('p', {}, t('streamFree {version} · free and open source (MIT)', { version: info.version })),
      h('p', {},
        h('a', { href: 'https://iamvinbas.github.io/streamFree/', target: '_blank', rel: 'noopener' }, t('Website')), ' · ',
        h('a', { href: 'https://github.com/iamvinbas/streamFree', target: '_blank', rel: 'noopener' }, 'GitHub'), ' · ',
        h('a', { href: 'https://github.com/iamvinbas/streamFree/issues', target: '_blank', rel: 'noopener' }, t('Report a problem')))),
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
  inviteDialog,
  get live() { return live; },
  get sharing() { return sharing; },
  get backstageChat() { return backstageChat; },
  get audioState() { return mixer?.ctx.state; },
  routing: () => mixer.routing(),
  sendChat: (text) => {
    for (const p of people.values()) if (p.kind === 'guest') send({ to: p.id, type: 'chat', text, author: S.hostName || 'Host' });
  },
  kick: (id) => send({ to: id, type: 'kick' }),
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
  setStyle: (patch) => { Object.assign(S.theme, patch); changed(); },
  setUi: (patch) => { Object.assign(S.ui, patch); applyAppearance(); renderAll(); translateStatic(); },
  showBanner: (title, subtitle) => {
    const b = { id: crypto.randomUUID(), title, subtitle };
    S.banners.push(b);
    S.activeBanner = b.id;
    changed();
  },
};

boot();
