// Guest page: preview camera and microphone, join the studio over WebRTC,
// watch the program and talk to the host. Works in any modern browser.

import { h, icon, toast, applyTheme } from './util.js';

applyTheme();

const invite = decodeURIComponent(location.pathname.split('/').pop() || '');
const app = document.querySelector('#app');
let local = null;
let ws = null;
let pc = null;
let micOn = true;
let camOn = true;
let onStage = false;
let chat = [];
let queue = Promise.resolve();
let leaving = false;

function savedName() {
  try {
    return localStorage.getItem('streamfree-guest-name') || '';
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
      toast(`Camera unavailable (${e.message}); joining with audio only.`, 'error');
    } catch (e2) {
      local = new MediaStream();
      toast(`Camera and microphone unavailable: ${e2.message}`, 'error');
    }
  }
  return local;
}

async function lobby() {
  if (!window.isSecureContext) {
    app.replaceChildren(h('main', { class: 'fatal' }, h('h1', {}, 'Secure link needed'),
      h('p', {}, 'Browsers only allow cameras on https:// pages. Ask the host to start streamFree with --lan or --tunnel and send you the new link.')));
    return;
  }
  const preview = h('video', { autoplay: true, muted: true, playsInline: true, class: 'mirror' });
  const name = h('input', { placeholder: 'Your name', value: savedName(), maxLength: 40, required: true, 'aria-label': 'Your name' });
  const camSel = h('select', { 'aria-label': 'Camera' });
  const micSel = h('select', { 'aria-label': 'Microphone' });
  const refresh = async () => {
    preview.srcObject = await getMedia(camSel.value, micSel.value);
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
        h('h1', {}, 'Join the studio'),
        h('div', { class: 'lobby-preview' }, preview),
        h('form', {
          class: 'stack', onsubmit: (e) => {
            e.preventDefault();
            try {
              localStorage.setItem('streamfree-guest-name', name.value.trim());
            } catch {
              // not saved
            }
            join(name.value.trim() || 'Guest');
          },
        },
        h('label', { class: 'field' }, h('span', {}, 'Name'), name),
        h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', {}, 'Camera'), camSel), h('label', { class: 'field' }, h('span', {}, 'Microphone'), micSel)),
        h('p', { class: 'muted' }, 'Use headphones to avoid echo. The host decides when you appear on screen.'),
        h('button', { class: 'btn primary big', type: 'submit' }, 'Enter backstage')))),
  );
  await refresh();
}

function sendSignal(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function join(name) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws/guest?invite=${encodeURIComponent(invite)}&name=${encodeURIComponent(name)}`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    // Handle messages strictly in order: ICE candidates must wait for the offer.
    queue = queue.then(() => onMessage(msg)).catch((err) => toast(err.message, 'error'));
  };
  ws.onclose = () => {
    pc?.close();
    local?.getTracks().forEach((t) => t.stop());
    if (!leaving) ended('The connection to the studio ended. The host may have removed you or closed the studio.');
  };
  renderRoom(name);
}

let iceServers = [];

async function onMessage(m) {
  switch (m.type) {
    case 'welcome':
      iceServers = m.iceServers || [];
      sendSignal({ type: 'state', micOn, camOn });
      break;
    case 'offer': {
      pc?.close();
      pc = new RTCPeerConnection({ iceServers });
      pc.onicecandidate = (e) => e.candidate && sendSignal({ type: 'candidate', candidate: e.candidate });
      pc.ontrack = (e) => {
        const program = document.querySelector('#program');
        const stream = program.srcObject || new MediaStream();
        stream.addTrack(e.track);
        program.srcObject = stream;
        program.play().catch(() => {});
      };
      pc.onconnectionstatechange = () => setStatus();
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      for (const t of pc.getTransceivers()) {
        const kind = t.receiver.track.kind;
        const track = kind === 'video' ? local.getVideoTracks()[0] : local.getAudioTracks()[0];
        if (track) await t.sender.replaceTrack(track);
        t.direction = 'sendrecv';
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: 'answer', sdp: answer.sdp });
      break;
    }
    case 'candidate':
      if (pc && m.candidate) await pc.addIceCandidate(m.candidate).catch(() => {});
      break;
    case 'stage':
      onStage = !!m.onStage;
      setStatus();
      toast(onStage ? 'You are on stage: viewers can see and hear you.' : 'You are backstage.');
      break;
    case 'chat':
      chat.push({ author: m.author || 'Host', text: m.text });
      renderChat();
      break;
  }
}

function setStatus() {
  const el = document.querySelector('#guest-status');
  if (!el) return;
  const state = pc?.connectionState;
  if (state && state !== 'connected') {
    el.className = 'pill';
    el.textContent = state === 'failed' ? 'Connection failed — the host may need a TURN server' : 'Connecting…';
    return;
  }
  el.className = `pill ${onStage ? 'live' : ''}`;
  el.textContent = onStage ? 'On stage' : 'Backstage';
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
        class: `ctl ${micOn ? '' : 'active'}`, 'aria-label': micOn ? 'Mute' : 'Unmute', onclick: () => {
          micOn = !micOn;
          local.getAudioTracks().forEach((t) => (t.enabled = micOn));
          sendSignal({ type: 'state', micOn });
          drawControls();
        },
      }, icon(micOn ? 'mic' : 'micOff'), h('small', {}, micOn ? 'Mute' : 'Unmute')),
      h('button', {
        class: `ctl ${camOn ? '' : 'active'}`, 'aria-label': camOn ? 'Stop camera' : 'Start camera', onclick: () => {
          camOn = !camOn;
          local.getVideoTracks().forEach((t) => (t.enabled = camOn));
          sendSignal({ type: 'state', camOn });
          drawControls();
        },
      }, icon(camOn ? 'cam' : 'camOff'), h('small', {}, camOn ? 'Stop cam' : 'Start cam')),
      h('button', {
        class: 'ctl danger', 'aria-label': 'Leave', onclick: () => {
          leaving = true;
          ws?.close();
          pc?.close();
          local?.getTracks().forEach((t) => t.stop());
          ended('You left the studio.');
        },
      }, icon('leave'), h('small', {}, 'Leave')),
    );
  };
  drawControls();
  const input = h('input', { placeholder: 'Message the host', maxLength: 500, 'aria-label': 'Message the host' });
  app.replaceChildren(
    h('header', { class: 'topbar' }, h('div', { class: 'brand' }, h('img', { src: '/static/favicon.svg', alt: '', width: 24, height: 24 }), 'streamFree'),
      h('div', { class: 'status' }, h('span', { id: 'guest-status', class: 'pill' }, 'Connecting…')), h('div', {}, name)),
    h('main', { class: 'guest-room' },
      h('section', { class: 'stage-col' },
        h('div', { class: 'preview-wrap' }, h('video', { id: 'program', autoplay: true, playsInline: true, 'aria-label': 'Live program' }), self),
        controls),
      h('aside', { class: 'sidebar' },
        h('section', { class: 'card' }, h('h3', {}, 'Backstage chat'), h('ul', { id: 'guest-chat', class: 'chat' }),
          h('form', {
            class: 'row', onsubmit: (e) => {
              e.preventDefault();
              const text = input.value.trim();
              if (!text) return;
              sendSignal({ type: 'chat', text });
              chat.push({ author: 'You', text });
              input.value = '';
              renderChat();
            },
          }, input, h('button', { class: 'btn', type: 'submit' }, 'Send'))))),
  );
}

function ended(message) {
  app.replaceChildren(h('main', { class: 'fatal' }, h('h1', {}, 'streamFree'), h('p', {}, message),
    h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Join again')));
}

lobby();

window.streamFreeGuest = { get pc() { return pc; }, get onStage() { return onStage; }, join };
