// Program compositor and encoder. Runs in a dedicated worker so that the
// stream keeps its frame rate when the studio tab is in the background:
// Chrome throttles timers and animation frames of hidden tabs, not of workers.
//
// Inputs: one ReadableStream<VideoFrame> per source (camera, screen, guest,
// media clip), ImageBitmaps for branding, and the scene description.
// Outputs: the preview canvas, a small return feed for guests, and H.264/AAC
// chunks sent over a WebSocket to the local server.

import { computeLayout } from './layouts.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const sources = new Map(); // id -> { reader, frame }
const images = new Map(); // id -> ImageBitmap
let scene = { layout: 'grid', stage: [], screen: null, names: {}, theme: {} };
let width = 1280;
let height = 720;
let fps = 30;
let canvas = new OffscreenCanvas(width, height);
let ctx = canvas.getContext('2d', { alpha: false });
let preview = null;
let previewCtx = null;
let returnCanvas = new OffscreenCanvas(640, 360);
let returnCtx = returnCanvas.getContext('2d', { alpha: false });
let returnFeed = false;
let bannerSince = 0;
let bannerKey = '';
let commentSince = 0;
let commentKey = '';
let tickerStart = 0;
let enc = null; // active broadcast, see start()
let tickTimer = 0;
let nextTick = 0;
let frameNo = 0;

// ---------------------------------------------------------------- drawing

function cover(source, sw, sh, r, mirror) {
  const scale = Math.max(r.w / sw, r.h / sh);
  const cw = r.w / scale;
  const ch = r.h / scale;
  const cx = (sw - cw) / 2;
  const cy = (sh - ch) / 2;
  if (mirror) {
    ctx.save();
    ctx.translate(r.x + r.w, r.y);
    ctx.scale(-1, 1);
    ctx.drawImage(source, cx, cy, cw, ch, 0, 0, r.w, r.h);
    ctx.restore();
  } else {
    ctx.drawImage(source, cx, cy, cw, ch, r.x, r.y, r.w, r.h);
  }
}

function contain(source, sw, sh, r) {
  const scale = Math.min(r.w / sw, r.h / sh);
  const w = sw * scale;
  const h = sh * scale;
  ctx.drawImage(source, r.x + (r.w - w) / 2, r.y + (r.h - h) / 2, w, h);
}

function roundRect(r, radius) {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, radius);
}

function theme() {
  return {
    primary: scene.theme?.primary || '#6d5efc',
    text: scene.theme?.text || '#ffffff',
    style: scene.theme?.style || 'pill',
    radius: scene.theme?.radius ?? 0.012,
  };
}

function drawPlaceholder(r, name) {
  ctx.fillStyle = '#1d2030';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  const t = theme();
  const d = Math.min(r.w, r.h) * 0.32;
  ctx.fillStyle = t.primary;
  ctx.beginPath();
  ctx.arc(r.x + r.w / 2, r.y + r.h / 2, d / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = t.text;
  ctx.font = `600 ${Math.round(d * 0.45)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText((name || '?').trim().charAt(0).toUpperCase(), r.x + r.w / 2, r.y + r.h / 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawNameTag(r, name) {
  if (!name || scene.showNames === false) return;
  const t = theme();
  const size = Math.max(12, Math.round(Math.min(r.h * 0.07, height * 0.032)));
  ctx.font = `600 ${size}px ${FONT}`;
  const tw = ctx.measureText(name).width;
  const padX = size * 0.6;
  const h = size * 1.7;
  const x = r.x + size * 0.5;
  const y = r.y + r.h - h - size * 0.5;
  if (t.style === 'minimal') {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(x, y, tw + padX * 2, h);
  } else {
    ctx.fillStyle = t.primary;
    ctx.beginPath();
    ctx.roundRect(x, y, tw + padX * 2, h, t.style === 'pill' ? h / 2 : 2);
    ctx.fill();
  }
  ctx.fillStyle = t.text;
  ctx.textBaseline = 'middle';
  ctx.fillText(name, x + padX, y + h / 2 + 1);
  ctx.textBaseline = 'alphabetic';
}

function drawTile(id, r, contained) {
  const src = sources.get(id);
  const frame = src?.frame;
  const name = scene.names?.[id];
  const radius = contained ? 0 : height * theme().radius;
  ctx.save();
  roundRect(r, radius);
  ctx.clip();
  if (frame && !scene.hidden?.[id]) {
    if (contained) {
      ctx.fillStyle = '#000';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      contain(frame, frame.displayWidth, frame.displayHeight, r);
    } else {
      cover(frame, frame.displayWidth, frame.displayHeight, r, scene.mirror?.[id]);
    }
  } else {
    drawPlaceholder(r, name);
  }
  ctx.restore();
  if (!contained) drawNameTag(r, name);
}

function wrapLines(text, maxWidth, maxLines) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    } else {
      line = test;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…';
  }
  return lines;
}

function easeOut(t) {
  return 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
}

function drawBanner(now, bottom) {
  const b = scene.banner;
  const key = b ? `${b.title}\u0000${b.subtitle}` : '';
  if (key !== bannerKey) {
    bannerKey = key;
    bannerSince = now;
  }
  if (!b || (!b.title && !b.subtitle)) return;
  const t = theme();
  const p = easeOut((now - bannerSince) / 450);
  const titleSize = Math.round(height * 0.042);
  const subSize = Math.round(height * 0.028);
  ctx.font = `700 ${titleSize}px ${FONT}`;
  const tw = ctx.measureText(b.title || '').width;
  ctx.font = `500 ${subSize}px ${FONT}`;
  const sw = ctx.measureText(b.subtitle || '').width;
  const padX = titleSize * 0.7;
  const w = Math.min(width * 0.8, Math.max(tw, sw) + padX * 2);
  const h = (b.title ? titleSize * 1.5 : 0) + (b.subtitle ? subSize * 1.6 : 0) + titleSize * 0.4;
  const x = height * 0.04 - (1 - p) * (w + height * 0.05);
  const y = bottom - h - height * 0.04;
  ctx.globalAlpha = p;
  ctx.fillStyle = t.primary;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, height * 0.008);
  ctx.fill();
  ctx.fillStyle = t.text;
  let ty = y + titleSize * 0.3;
  if (b.title) {
    ctx.font = `700 ${titleSize}px ${FONT}`;
    ctx.textBaseline = 'top';
    ctx.fillText(b.title, x + padX, ty + titleSize * 0.15, w - padX * 2);
    ty += titleSize * 1.5;
  }
  if (b.subtitle) {
    ctx.font = `500 ${subSize}px ${FONT}`;
    ctx.globalAlpha = p * 0.9;
    ctx.fillText(b.subtitle, x + padX, ty, w - padX * 2);
  }
  ctx.textBaseline = 'alphabetic';
  ctx.globalAlpha = 1;
}

function drawComment(now, bottom) {
  const c = scene.comment;
  const key = c ? `${c.author}\u0000${c.text}` : '';
  if (key !== commentKey) {
    commentKey = key;
    commentSince = now;
  }
  if (!c) return false;
  const t = theme();
  const p = easeOut((now - commentSince) / 450);
  const nameSize = Math.round(height * 0.03);
  const textSize = Math.round(height * 0.034);
  const w = width * 0.46;
  const pad = textSize * 0.8;
  ctx.font = `500 ${textSize}px ${FONT}`;
  const lines = wrapLines(c.text, w - pad * 2, 3);
  const h = pad * 1.6 + nameSize * 1.3 + lines.length * textSize * 1.3;
  const x = height * 0.04;
  const y = bottom - h - height * 0.04 + (1 - p) * height * 0.05;
  ctx.globalAlpha = p;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, height * 0.012);
  ctx.fill();
  ctx.fillStyle = t.primary;
  ctx.fillRect(x, y + height * 0.012, height * 0.006, h - height * 0.024);
  ctx.textBaseline = 'top';
  ctx.font = `700 ${nameSize}px ${FONT}`;
  ctx.fillStyle = c.color || t.primary;
  const platform = c.platform ? `  ·  ${c.platform}` : '';
  ctx.fillText(`${c.author}${platform}`, x + pad, y + pad * 0.8, w - pad * 2);
  ctx.font = `500 ${textSize}px ${FONT}`;
  ctx.fillStyle = '#16181f';
  lines.forEach((line, i) => ctx.fillText(line, x + pad, y + pad * 0.8 + nameSize * 1.3 + i * textSize * 1.3));
  ctx.textBaseline = 'alphabetic';
  ctx.globalAlpha = 1;
  return true;
}

// Returns the y where content above the ticker must end.
function drawTicker(now) {
  const tk = scene.ticker;
  if (!tk || !tk.text) {
    tickerStart = 0;
    return height;
  }
  if (!tickerStart) tickerStart = now;
  const t = theme();
  const size = Math.round(height * 0.032);
  const h = size * 1.8;
  const y = height - h;
  ctx.fillStyle = t.primary;
  ctx.fillRect(0, y, width, h);
  ctx.font = `600 ${size}px ${FONT}`;
  ctx.fillStyle = t.text;
  const text = `${tk.text}     •     `;
  const tw = ctx.measureText(text).width;
  const speed = (tk.speed || 1) * height * 0.12; // px per second
  const offset = ((now - tickerStart) / 1000 * speed) % tw;
  ctx.textBaseline = 'middle';
  for (let x = -offset; x < width; x += tw) ctx.fillText(text, x, y + h / 2 + 1);
  ctx.textBaseline = 'alphabetic';
  return y;
}

function drawLogo() {
  const logo = scene.logo?.id && images.get(scene.logo.id);
  if (!logo) return;
  const size = (scene.logo.size || 0.12) * width;
  const scale = size / Math.max(logo.width, logo.height);
  const w = logo.width * scale;
  const h = logo.height * scale;
  const m = height * 0.035;
  const pos = scene.logo.position || 'tr';
  const x = pos.includes('l') ? m : width - m - w;
  const y = pos.includes('t') ? m : height - m - h;
  ctx.drawImage(logo, x, y, w, h);
}

function drawProgram(now) {
  // Background
  const bg = scene.background;
  const bgImage = bg?.imageId && images.get(bg.imageId);
  if (bgImage) {
    const scale = Math.max(width / bgImage.width, height / bgImage.height);
    const w = bgImage.width * scale;
    const h = bgImage.height * scale;
    ctx.drawImage(bgImage, (width - w) / 2, (height - h) / 2, w, h);
  } else {
    ctx.fillStyle = bg?.color || '#0f1117';
    ctx.fillRect(0, 0, width, height);
  }

  const stage = (scene.stage || []).filter((id) => sources.has(id) || scene.names?.[id]);
  const screenId = scene.screen && sources.has(scene.screen) ? scene.screen : null;
  const layout = computeLayout(scene.layout, stage.length, !!screenId, width, height);
  if (screenId && layout.screen) drawTile(screenId, layout.screen, true);
  layout.cams.forEach((r, i) => drawTile(stage[i], r, false));

  const overlay = scene.overlayId && images.get(scene.overlayId);
  if (overlay) ctx.drawImage(overlay, 0, 0, width, height);

  drawLogo();
  const bottom = drawTicker(now);
  if (!drawComment(now, bottom)) drawBanner(now, bottom);
  else bannerKey = '';
}

// ---------------------------------------------------------------- loop

function tick() {
  const now = performance.now();
  drawProgram(now);
  if (previewCtx) previewCtx.drawImage(canvas, 0, 0, preview.width, preview.height);
  if (enc?.encoding) encodeVideo(now);
  frameNo++;
  if (returnFeed && frameNo % Math.max(1, Math.round(fps / 15)) === 0) {
    returnCtx.drawImage(canvas, 0, 0, returnCanvas.width, returnCanvas.height);
    const frame = new VideoFrame(returnCanvas, { timestamp: Math.round(now * 1000) });
    self.postMessage({ type: 'return-frame', frame }, [frame]);
  }
  const interval = 1000 / fps;
  nextTick = Math.max(nextTick + interval, now + 1);
  if (nextTick - now > interval * 2) nextTick = now + interval;
  tickTimer = setTimeout(tick, nextTick - performance.now());
}

function restartLoop() {
  clearTimeout(tickTimer);
  nextTick = performance.now();
  tick();
}

// ---------------------------------------------------------------- sources

async function pump(id, readable) {
  const reader = readable.getReader();
  const entry = { reader, frame: null };
  const old = sources.get(id);
  if (old) removeSource(id, old);
  sources.set(id, entry);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (sources.get(id) !== entry) {
        value.close();
        break;
      }
      const prev = entry.frame;
      entry.frame = value;
      prev?.close();
    }
  } catch {
    // The track ended or the stream was cancelled.
  }
  if (sources.get(id) === entry) {
    entry.frame?.close();
    entry.frame = null;
  }
}

function removeSource(id, entry = sources.get(id)) {
  if (!entry) return;
  sources.delete(id);
  entry.reader.cancel().catch(() => {});
  entry.frame?.close();
  entry.frame = null;
}

// ---------------------------------------------------------------- encoding

function videoCodec(w, h, f) {
  const mbps = (w * h * f) / 256; // macroblocks per second
  if (mbps <= 108000) return 'avc1.64001f'; // level 3.1: 720p30
  if (mbps <= 216000) return 'avc1.640020'; // level 3.2: 720p60
  if (mbps <= 245760) return 'avc1.640028'; // level 4.0: 1080p30
  return 'avc1.64002a'; // level 4.2: 1080p60
}

function sendJSON(value) {
  if (enc?.ws?.readyState === WebSocket.OPEN) enc.ws.send(JSON.stringify(value));
}

function sendChunk(kind, chunk, ptsUs) {
  const ws = enc?.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const buf = new ArrayBuffer(10 + chunk.byteLength);
  const view = new DataView(buf);
  view.setUint8(0, kind);
  view.setUint8(1, chunk.type === 'key' ? 1 : 0);
  view.setBigInt64(2, BigInt(Math.max(0, Math.round(ptsUs))));
  chunk.copyTo(new Uint8Array(buf, 10));
  ws.send(buf);
  enc.sentBytes += buf.byteLength;
}

function encodeVideo(now) {
  const e = enc;
  const ws = e.ws;
  // Back-pressure: if the server is not keeping up, skip frames and restart
  // with a keyframe once the socket drains.
  if (ws.bufferedAmount > 16 * 1024 * 1024 || e.video.encodeQueueSize > fps) {
    e.dropped++;
    e.forceKey = true;
    return;
  }
  const ts = Math.round((now - e.t0) * 1000);
  const frame = new VideoFrame(canvas, { timestamp: ts, duration: Math.round(1e6 / fps) });
  const key = e.forceKey || e.encodedFrames % (fps * 2) === 0;
  e.forceKey = false;
  e.video.encode(frame, { keyFrame: key });
  frame.close();
  e.encodedFrames++;
}

async function pickVideoConfig(base) {
  for (const bitrateMode of ['constant', 'variable']) {
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
      const config = { ...base, bitrateMode, hardwareAcceleration };
      try {
        const { supported } = await VideoEncoder.isConfigSupported(config);
        if (supported) return config;
      } catch {
        // try the next combination
      }
    }
  }
  throw new Error(`This browser cannot encode H.264 at ${base.width}x${base.height}. Use Chrome or Edge.`);
}

async function start(opts) {
  if (enc) throw new Error('already broadcasting');
  const ws = new WebSocket(opts.ingestUrl);
  ws.binaryType = 'arraybuffer';
  const e = {
    ws,
    encoding: false,
    t0: 0,
    encodedFrames: 0,
    forceKey: true,
    dropped: 0,
    sentBytes: 0,
    videoConfigSent: false,
    audioConfigSent: false,
    audioIn0: null,
    audioBase: 0,
    stopped: null,
    audioReader: null,
  };
  enc = e;
  ws.onmessage = (m) => {
    if (typeof m.data !== 'string') return;
    const msg = JSON.parse(m.data);
    if (msg.type === 'stopped') e.stopped?.(msg);
    self.postMessage({ type: 'ingest', msg });
  };
  ws.onclose = () => {
    if (enc === e) {
      self.postMessage({ type: 'ingest', msg: { type: 'closed' } });
      teardown(e);
    }
    e.stopped?.(null);
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('could not connect to the streamFree server'));
  });
  ws.send(JSON.stringify({ type: 'start', record: opts.record, destinations: opts.destinations, name: opts.name }));

  const videoBase = {
    codec: videoCodec(width, height, fps),
    width,
    height,
    bitrate: opts.videoBitrate,
    framerate: fps,
    latencyMode: 'realtime',
    avc: { format: 'avc' },
  };
  const videoConfig = await pickVideoConfig(videoBase);
  e.video = new VideoEncoder({
    output: (chunk, meta) => {
      if (!e.videoConfigSent && meta?.decoderConfig?.description) {
        e.videoConfigSent = true;
        sendJSON({
          type: 'video-config',
          width,
          height,
          framerate: fps,
          bitrate: opts.videoBitrate,
          description: Array.from(new Uint8Array(meta.decoderConfig.description)),
        });
      }
      if (e.videoConfigSent) sendChunk(2, chunk, chunk.timestamp);
    },
    error: (err) => fail(e, `video encoder: ${err.message}`),
  });
  e.video.configure(videoConfig);

  e.audioReader = opts.audioReadable.getReader();
  pumpAudio(e, opts.audioBitrate);

  e.t0 = performance.now();
  e.encoding = true;
  self.postMessage({ type: 'encoding', config: videoConfig });
}

async function pumpAudio(e, bitrate) {
  let encoder = null;
  try {
    for (;;) {
      const { value: data, done } = await e.audioReader.read();
      if (done) break;
      if (!e.encoding || enc !== e) {
        data.close();
        if (enc !== e) break;
        continue;
      }
      if (!encoder) {
        // Anchor audio to the video clock now, before any await: the first
        // encoder setup can take seconds, and audio captured meanwhile waits
        // in the stream. Taking the anchor later would delay all audio by
        // that much and break lip sync.
        e.audioIn0 = data.timestamp;
        e.audioBase = (performance.now() - e.t0) * 1000;
        const config = { codec: 'mp4a.40.2', sampleRate: data.sampleRate, numberOfChannels: data.numberOfChannels, bitrate };
        const { supported } = await AudioEncoder.isConfigSupported(config);
        if (!supported) {
          data.close();
          fail(e, 'This browser cannot encode AAC audio. Use Chrome or Edge on Windows or macOS.');
          return;
        }
        encoder = new AudioEncoder({
          output: (chunk, meta) => {
            if (!e.audioConfigSent && meta?.decoderConfig?.description) {
              e.audioConfigSent = true;
              sendJSON({
                type: 'audio-config',
                sampleRate: config.sampleRate,
                channels: config.numberOfChannels,
                bitrate,
                description: Array.from(new Uint8Array(meta.decoderConfig.description)),
              });
            }
            if (e.audioConfigSent) sendChunk(4, chunk, chunk.timestamp - e.audioIn0 + e.audioBase);
          },
          error: (err) => fail(e, `audio encoder: ${err.message}`),
        });
        encoder.configure(config);
        e.audio = encoder;
      }
      encoder.encode(data);
      data.close();
    }
  } catch (err) {
    if (enc === e) fail(e, `audio: ${err.message}`);
  }
}

function fail(e, message) {
  self.postMessage({ type: 'error', error: message });
  if (enc === e) stop().catch(() => {});
}

function teardown(e) {
  e.encoding = false;
  if (enc === e) enc = null;
  if (e.ws.readyState === WebSocket.CONNECTING || e.ws.readyState === WebSocket.OPEN) {
    try {
      e.ws.close();
    } catch {
      // already closing
    }
  }
  e.audioReader?.cancel().catch(() => {});
  for (const coder of [e.video, e.audio]) {
    try {
      if (coder && coder.state !== 'closed') coder.close();
    } catch {
      // already closed
    }
  }
}

async function stop() {
  const e = enc;
  if (!e) return null;
  e.encoding = false;
  try {
    await Promise.all([e.video?.flush(), e.audio?.flush()].filter(Boolean));
  } catch {
    // encoder already failed; send what we have
  }
  const result = new Promise((resolve) => {
    e.stopped = resolve;
    setTimeout(() => resolve(null), 20000);
  });
  sendJSON({ type: 'stop' });
  const msg = await result;
  teardown(e);
  try {
    e.ws.close();
  } catch {
    // ignore
  }
  return msg;
}

// ---------------------------------------------------------------- messages

function setSize(w, h, f) {
  if (enc) return;
  width = w;
  height = h;
  fps = f;
  canvas = new OffscreenCanvas(width, height);
  ctx = canvas.getContext('2d', { alpha: false });
  restartLoop();
  warmUpEncoder();
}

// Encoders can take seconds to initialize the first time (measured ~2.4 s
// for constant-bitrate H.264 and ~2 s for AAC on macOS). Pay that cost while
// the host is preparing, not when they press "Go live".
async function warmUpEncoder() {
  try {
    const config = await pickVideoConfig({
      codec: videoCodec(width, height, fps), width, height, bitrate: 4_500_000, framerate: fps,
      latencyMode: 'realtime', avc: { format: 'avc' },
    });
    const encoder = new VideoEncoder({ output: () => {}, error: () => {} });
    encoder.configure(config);
    const frame = new VideoFrame(canvas, { timestamp: 0 });
    encoder.encode(frame, { keyFrame: true });
    frame.close();
    await encoder.flush();
    encoder.close();
    const audio = new AudioEncoder({ output: () => {}, error: () => {} });
    audio.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
    const silence = new AudioData({
      format: 'f32-planar', sampleRate: 48000, numberOfFrames: 1024, numberOfChannels: 2, timestamp: 0,
      data: new Float32Array(2048),
    });
    audio.encode(silence);
    silence.close();
    await audio.flush();
    audio.close();
  } catch {
    // The real start reports encoder problems to the host.
  }
  self.postMessage({ type: 'encoder-ready' });
}

self.onmessage = async (event) => {
  const m = event.data;
  try {
    switch (m.type) {
      case 'init':
        preview = m.preview;
        previewCtx = preview.getContext('2d', { alpha: false });
        setSize(m.width, m.height, m.fps);
        break;
      case 'size':
        setSize(m.width, m.height, m.fps);
        break;
      case 'source':
        pump(m.id, m.readable);
        break;
      case 'remove-source':
        removeSource(m.id);
        break;
      case 'image':
        images.get(m.id)?.close();
        images.set(m.id, m.bitmap);
        break;
      case 'remove-image':
        images.get(m.id)?.close();
        images.delete(m.id);
        break;
      case 'scene':
        scene = m.scene;
        break;
      case 'return-feed':
        returnFeed = m.enabled;
        break;
      case 'start':
        await start(m.options);
        break;
      case 'stop': {
        const result = await stop();
        self.postMessage({ type: 'stopped', result, id: m.id });
        break;
      }
      case 'stats':
        self.postMessage({
          type: 'stats',
          id: m.id,
          encoding: !!enc?.encoding,
          frames: enc?.encodedFrames || 0,
          dropped: enc?.dropped || 0,
          sentBytes: enc?.sentBytes || 0,
          videoConfigSent: !!enc?.videoConfigSent,
          audioConfigSent: !!enc?.audioConfigSent,
          audioState: enc?.audio?.state || 'none',
        });
        break;
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: err.message || String(err) });
    if (m.type === 'start' && enc) {
      teardown(enc);
    }
  }
};
