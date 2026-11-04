// Guest page: preview camera and microphone, join the studio, watch the
// program and talk to the host. Works in any modern browser.
//
// Media normally flows over WebRTC, directly between this browser and the
// host. When the host cannot reach us directly it sends `relay-start` and we
// switch to the relay (relay.js): the same media, encoded here and carried
// over a WebSocket through the streamFree server.

import { h, icon, toast, applyTheme } from './util.js';
import { t, setLang, detectLang } from './i18n.js';
import {
  VIDEO, AUDIO, relayCaps, pickVideoCodec, parsePacket, loadRelayWorklets,
  VideoSender, VideoReceiver, AudioSender, AudioReceiver,
} from './relay.js';

applyTheme();
// Guests see the page in their own browser's language.
setLang(detectLang());
document.title = t('Join streamFree');

const CLOSE_REMOVED = 4001;
const invite = decodeURIComponent(location.pathname.split('/').pop() || '');
const app = document.querySelector('#app');
let local = null;
// Resolves when the camera and microphone are ready (or definitely not).
let mediaReady = Promise.resolve();
let ws = null;
let pc = null;
let micOn = true;
let camOn = true;
let onStage = false;
let chat = [];
let queue = Promise.resolve();
let leaving = false;
let myName = '';
let myId = '';
let relayKey = '';
let iceServers = [];
let audioCtx = null;
let connectedOnce = false;
let retries = 0;
let relay = null; // { ws, videoSend, audioSend, video, audio, frames }

function savedName() {
  try {
    return localStorage.getItem('streamfree-guest-name') || '';
  } catch {
    return '';
  }
}

/** A random id kept for this tab, so the host recognizes us after a reconnect. */
function clientId() {
  try {
    let id = sessionStorage.getItem('streamfree-guest-cid');
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem('streamfree-guest-cid', id);
    }
    return id;
  } catch {
    return '';
  }
}

async function getMedia(camId, micId) {
  local?.getTracks().forEach((t) => t.stop());
  const constraints = {
    video: camId ? { deviceId: { exact: camId }, width: { ideal: 1280 }, height: { ideal: 720 } } : { width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(micId ? { deviceId: { exact: micId } } : {}) },
  };
  try {
    local = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    try {
      local = await navigator.mediaDevices.getUserMedia({ audio: true });
      camOn = false;
      toast(t('Camera unavailable ({error}); joining with audio only.', { error: e.message }), 'error');
    } catch (e2) {
      local = new MediaStream();
      toast(t('Camera and microphone unavailable: {error}', { error: e2.message }), 'error');
    }
  }
  return local;
}

async function lobby() {
  if (!window.isSecureContext) {
    app.replaceChildren(h('main', { class: 'fatal' }, h('h1', {}, t('Secure link needed')),
      h('p', {}, t('Browsers only allow cameras on secure (https://) pages. Ask the host to choose Local network or Internet in the Invite window and send you the new link.'))));
    return;
  }
  const preview = h('video', { autoplay: true, muted: true, playsInline: true, class: 'mirror' });
  const name = h('input', { placeholder: t('Your name'), value: savedName(), maxLength: 40, required: true, 'aria-label': t('Your name') });
  const camSel = h('select', { 'aria-label': t('Camera') });
  const micSel = h('select', { 'aria-label': t('Microphone') });
  const refresh = async () => {
    mediaReady = getMedia(camSel.value, micSel.value);
    preview.srcObject = await mediaReady;
    const list = await navigator.mediaDevices.enumerateDevices();
    const fill = (sel, kind) => {
      const current = sel.value;
      sel.replaceChildren(...list.filter((d) => d.kind === kind).map((d) => h('option', { value: d.deviceId, selected: d.deviceId === current }, d.label || kind)));
    };
    fill(camSel, 'videoinput');
    fill(micSel, 'audioinput');
  };
  camSel.onchange = refresh;
  micSel.onchange = refresh;
  app.replaceChildren(
    h('main', { class: 'lobby' },
      h('div', { class: 'lobby-card' },
        h('h1', {}, t('Join the studio')),
        h('div', { class: 'lobby-preview' }, preview),
        h('form', {
          class: 'stack', onsubmit: (e) => {
            e.preventDefault();
            // Safari only lets audio start from a user gesture: create the
            // audio context now, before anything asynchronous happens.
            startAudio();
            try {
              localStorage.setItem('streamfree-guest-name', name.value.trim());
            } catch {
              // not saved
            }
            join(name.value.trim() || t('Guest'));
          },
        },
        h('label', { class: 'field' }, h('span', {}, t('Name')), name),
        h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', {}, t('Camera')), camSel), h('label', { class: 'field' }, h('span', {}, t('Microphone')), micSel)),
        h('p', { class: 'muted' }, t('Use headphones to avoid echo. The host decides when you appear on screen.')),
        h('button', { class: 'btn primary big', type: 'submit' }, t('Enter backstage'))))),
  );
  await refresh();
}

function startAudio() {
  if (audioCtx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  try {
    audioCtx = new Ctx({ sampleRate: 48000, latencyHint: 'interactive' });
  } catch {
    audioCtx = new Ctx();
  }
  audioCtx.resume().catch(() => {});
}

function sendSignal(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function join(name) {
  // The host's offer needs our tracks: never connect before they exist,
  // even if the guest clicks while the permission prompt is still open.
  await mediaReady;
  if (!local) local = await getMedia('', '');
  myName = name;
  renderRoom(name);
  connect();
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({ invite, name: myName, cid: clientId() });
  const socket = new WebSocket(`${proto}//${location.host}/ws/guest?${params}`);
  ws = socket;
  socket.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    // Handle messages strictly in order: ICE candidates must wait for the offer.
    queue = queue.then(() => onMessage(msg)).catch((err) => toast(err.message, 'error'));
  };
  socket.onclose = (e) => {
    if (ws !== socket) return;
    closeMedia();
    if (leaving) return;
    if (e.code === CLOSE_REMOVED) {
      endSession(t('The host removed you from the studio.'));
      return;
    }
    // A dropped connection (network change, a proxy hiccup): try again for
    // about a minute. The host puts us back on stage if we were on it.
    if (connectedOnce && retries < 8) {
      retries++;
      setStatus(t('Reconnecting…'));
      setTimeout(() => !leaving && connect(), Math.min(8000, 1000 * retries));
      return;
    }
    endSession(t('The connection to the studio ended. The host may have closed the studio.'));
  };
}

function closeMedia() {
  pc?.close();
  pc = null;
  stopRelay();
}

function endSession(message) {
  ws = null;
  local?.getTracks().forEach((t) => t.stop());
  ended(message);
}

async function onMessage(m) {
  switch (m.type) {
    case 'welcome':
      connectedOnce = true;
      retries = 0;
      myId = m.id;
      relayKey = m.relayKey || '';
      iceServers = m.iceServers || [];
      sendSignal({ type: 'state', micOn, camOn });
      setStatus();
      break;
    case 'offer': {
      stopRelay();
      pc?.close();
      const conn = new RTCPeerConnection({ iceServers });
      pc = conn;
      const program = document.querySelector('#program');
      const stream = new MediaStream();
      program.srcObject = stream;
      showProgram('video');
      conn.onicecandidate = (e) => e.candidate && sendSignal({ type: 'candidate', candidate: e.candidate });
      conn.ontrack = (e) => {
        stream.addTrack(e.track);
        program.play().catch(() => askToPlay());
      };
      conn.onconnectionstatechange = () => setStatus();
      await conn.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      for (const tr of conn.getTransceivers()) {
        const kind = tr.receiver.track.kind;
        const track = kind === 'video' ? local.getVideoTracks()[0] : local.getAudioTracks()[0];
        if (track) await tr.sender.replaceTrack(track);
        tr.direction = 'sendrecv';
      }
      const answer = await conn.createAnswer();
      await conn.setLocalDescription(answer);
      sendSignal({ type: 'answer', sdp: answer.sdp });
      break;
    }
    case 'candidate':
      if (pc && m.candidate) await pc.addIceCandidate(m.candidate).catch(() => {});
      break;
    case 'relay-start':
      await startRelay(m.caps || {});
      break;
    case 'relay-ok':
      if (relay) relay.hostReceiving = true;
      setStatus();
      break;
    case 'stage':
      onStage = !!m.onStage;
      setStatus();
      toast(onStage ? t('You are on stage: viewers can see and hear you.') : t('You are backstage.'));
      break;
    case 'chat':
      chat.push({ author: m.author || t('Host'), text: m.text });
      renderChat();
      break;
  }
}

// ---------------------------------------------------------------- relay

async function startRelay(hostDecode) {
  pc?.close();
  pc = null;
  stopRelay();
  startAudio();
  await loadRelayWorklets(audioCtx);
  const mine = await relayCaps();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({ invite, id: myId, key: relayKey });
  const socket = new WebSocket(`${proto}//${location.host}/ws/relay/guest?${params}`);
  socket.binaryType = 'arraybuffer';
  const r = { ws: socket, frames: 0 };
  relay = r;
  const sendBin = (buf) => socket.readyState === WebSocket.OPEN && socket.send(buf);
  socket.onopen = () => {
    if (relay !== r) return;
    const camera = local.getVideoTracks()[0];
    const codec = pickVideoCodec(mine, hostDecode.video);
    if (camera && codec) {
      r.videoSend = new VideoSender({ send: sendBin, codec, maxSide: 640, fps: 20, canSend: () => socket.bufferedAmount < 1_500_000 });
      r.videoSend.setTrack(camera);
    }
    if (local.getAudioTracks().length) {
      r.micSource = audioCtx.createMediaStreamSource(local);
      r.audioSend = new AudioSender({ ctx: audioCtx, source: r.micSource, send: sendBin, opus: mine.encode.opus && hostDecode.opus });
    }
    r.video = new VideoReceiver({
      onFrame: (frame) => drawProgram(r, frame),
      requestKey: () => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'key' })),
    });
    r.audio = new AudioReceiver({ ctx: audioCtx });
    r.audio.node.connect(audioCtx.destination);
    if (audioCtx.state !== 'running') audioCtx.resume().catch(() => askToPlay());
    showProgram('canvas');
    sendSignal({ type: 'relay-ready', caps: mine.decode });
    setStatus();
  };
  socket.onmessage = (e) => {
    if (relay !== r) return;
    if (typeof e.data === 'string') {
      // The host lost some of our video and needs a keyframe.
      if (JSON.parse(e.data).type === 'key') r.videoSend?.requestKey();
      return;
    }
    let p;
    try {
      p = parsePacket(e.data);
    } catch {
      return;
    }
    if (p.kind === VIDEO) r.video?.push(p);
    else if (p.kind === AUDIO) r.audio?.push(p);
  };
  socket.onclose = () => {
    if (relay !== r) return;
    stopRelay();
    // The signaling socket decides whether we are still in the studio.
    if (ws?.readyState === WebSocket.OPEN) setTimeout(() => ws?.readyState === WebSocket.OPEN && startRelay(hostDecode), 1000);
  };
  setStatus();
}

function stopRelay() {
  const r = relay;
  if (!r) return;
  relay = null;
  r.videoSend?.stop();
  r.audioSend?.stop();
  r.micSource?.disconnect();
  r.video?.close();
  r.audio?.close();
  try {
    r.ws.close();
  } catch {
    // already closed
  }
}

function drawProgram(r, frame) {
  const canvas = document.querySelector('#program-canvas');
  if (!canvas || relay !== r) {
    frame.close();
    return;
  }
  if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
  }
  canvas.getContext('2d').drawImage(frame, 0, 0);
  frame.close();
  if (r.frames++ === 0) setStatus();
}

/** Shows the program as a <video> (WebRTC) or a <canvas> (relay). */
function showProgram(kind) {
  const video = document.querySelector('#program');
  const canvas = document.querySelector('#program-canvas');
  if (video) video.hidden = kind !== 'video';
  if (canvas) canvas.hidden = kind !== 'canvas';
}

/** Safari blocked playback with sound: one tap starts it. */
function askToPlay() {
  const wrap = document.querySelector('.preview-wrap');
  if (!wrap || wrap.querySelector('.tap-to-play')) return;
  const btn = h('button', {
    class: 'btn primary tap-to-play', type: 'button', onclick: () => {
      document.querySelector('#program')?.play().catch(() => {});
      audioCtx?.resume().catch(() => {});
      btn.remove();
    },
  }, t('Tap to hear the studio'));
  wrap.append(btn);
}

// ---------------------------------------------------------------- room

function setStatus(text) {
  const el = document.querySelector('#guest-status');
  if (!el) return;
  el.title = '';
  if (text) {
    el.className = 'pill';
    el.textContent = text;
    return;
  }
  if (relay) {
    if (!relay.frames) {
      el.className = 'pill';
      el.textContent = t('Connecting…');
      return;
    }
    el.title = t('Connected through the studio link, because a direct connection was not possible.');
  } else {
    const state = pc?.connectionState;
    if (!pc || state !== 'connected') {
      el.className = 'pill';
      el.textContent = state === 'failed' ? t('Connection failed: retrying through the studio link…') : t('Connecting…');
      return;
    }
  }
  el.className = `pill ${onStage ? 'live' : ''}`;
  el.textContent = onStage ? t('On stage') : t('Backstage');
}

function renderChat() {
  const list = document.querySelector('#guest-chat');
  if (!list) return;
  list.replaceChildren(...chat.slice(-100).map((m) => h('li', {}, h('strong', {}, m.author), ' ', m.text)));
  list.scrollTop = list.scrollHeight;
}

function renderRoom(name) {
  const self = h('video', { autoplay: true, muted: true, playsInline: true, class: 'mirror self' });
  self.srcObject = local;
  const controls = h('div', { class: 'controls' });
  const drawControls = () => {
    controls.replaceChildren(
      h('button', {
        class: `ctl ${micOn ? '' : 'active'}`, 'aria-label': micOn ? t('Mute') : t('Unmute'), onclick: () => {
          micOn = !micOn;
          local.getAudioTracks().forEach((t) => (t.enabled = micOn));
          sendSignal({ type: 'state', micOn });
          drawControls();
        },
      }, icon(micOn ? 'mic' : 'micOff'), h('small', {}, micOn ? t('Mute') : t('Unmute'))),
      h('button', {
        class: `ctl ${camOn ? '' : 'active'}`, 'aria-label': camOn ? t('Stop cam') : t('Start cam'), onclick: () => {
          camOn = !camOn;
          local.getVideoTracks().forEach((t) => (t.enabled = camOn));
          sendSignal({ type: 'state', camOn });
          drawControls();
        },
      }, icon(camOn ? 'cam' : 'camOff'), h('small', {}, camOn ? t('Stop cam') : t('Start cam'))),
      h('button', {
        class: 'ctl danger', 'aria-label': t('Leave'), onclick: () => {
          leaving = true;
          ws?.close();
          closeMedia();
          local?.getTracks().forEach((t) => t.stop());
          ended(t('You left the studio.'));
        },
      }, icon('leave'), h('small', {}, t('Leave'))),
    );
  };
  drawControls();
  const input = h('input', { placeholder: t('Message the host'), maxLength: 500, 'aria-label': t('Message the host') });
  app.replaceChildren(
    h('header', { class: 'topbar' }, h('div', { class: 'brand' }, h('img', { src: '/static/favicon.svg', alt: '', width: 24, height: 24 }), 'streamFree'),
      h('div', { class: 'status' }, h('span', { id: 'guest-status', class: 'pill' }, t('Connecting…'))), h('div', {}, name)),
    h('main', { class: 'guest-room' },
      h('section', { class: 'stage-col' },
        h('div', { class: 'preview-wrap' },
          h('video', { id: 'program', autoplay: true, playsInline: true, 'aria-label': t('Live program') }),
          h('canvas', { id: 'program-canvas', width: 640, height: 360, hidden: true, 'aria-label': t('Live program') }),
          self),
        controls),
      h('aside', { class: 'sidebar' },
        h('section', { class: 'card' }, h('h3', {}, t('Backstage chat')), h('ul', { id: 'guest-chat', class: 'chat' }),
          h('form', {
            class: 'row', onsubmit: (e) => {
              e.preventDefault();
              const text = input.value.trim();
              if (!text) return;
              sendSignal({ type: 'chat', text });
              chat.push({ author: t('You'), text });
              input.value = '';
              renderChat();
            },
          }, input, h('button', { class: 'btn', type: 'submit' }, t('Send')))))),
  );
}

function ended(message) {
  app.replaceChildren(h('main', { class: 'fatal' }, h('h1', {}, 'streamFree'), h('p', {}, message),
    h('button', { class: 'btn primary', onclick: () => location.reload() }, t('Join again'))));
}

lobby();

window.streamFreeGuest = {
  get pc() { return pc; },
  get onStage() { return onStage; },
  get relay() {
    return relay && {
      frames: relay.frames,
      videoFrames: relay.video?.frames || 0,
      audioPackets: relay.audio?.packets || 0,
      audioPeak: relay.audio?.peak || 0,
      hostReceiving: !!relay.hostReceiving,
    };
  },
  // For checks: drop the connection as a network change would.
  dropConnection: () => ws?.close(),
  join,
};
