// Media relay for guests who cannot reach the host directly.
//
// WebRTC needs a direct path between the two computers (or a TURN server).
// Strict NATs, mobile networks and firewalls often block it, so when the
// peer connection does not come up the host switches that guest to the
// relay: audio and video are encoded with WebCodecs and sent over a
// WebSocket through the streamFree server, the same way the guest page and
// its signaling already travel (directly on a LAN, or through the Cloudflare
// tunnel).
//
// Packet (big-endian):
//   0     kind      1 = video, 2 = audio
//   1     flags     bit 0: keyframe
//   2-5   seq       per-kind sequence number, to notice dropped packets
//   6-13  ts        capture time in µs
//   video keyframes then carry: width u16, height u16, codec length u8, codec
//   audio packets then carry:   format u8 (1 Opus, 2 PCM s16), channels u8, sample rate u32
//   followed by the encoded data.

export const VIDEO = 1;
export const AUDIO = 2;
const OPUS = 1;
const PCM = 2;
const VIDEO_CODECS = ['avc1.42e01f', 'vp8'];

const hasVideoCodecs = () => 'VideoEncoder' in self && 'VideoDecoder' in self;

function videoEncoderConfig(codec, width, height, bitrate, fps) {
  const config = { codec, width, height, bitrate, framerate: fps, latencyMode: 'realtime' };
  if (codec.startsWith('avc1')) config.avc = { format: 'annexb' };
  return config;
}

/** What this browser can decode (sent to the other side) and encode. */
export async function relayCaps() {
  const caps = { decode: { video: [], opus: false }, encode: { video: [], opus: false } };
  if (hasVideoCodecs()) {
    for (const codec of VIDEO_CODECS) {
      try {
        if ((await VideoDecoder.isConfigSupported({ codec, codedWidth: 640, codedHeight: 360 })).supported) caps.decode.video.push(codec);
      } catch {
        // not supported
      }
      try {
        if ((await VideoEncoder.isConfigSupported(videoEncoderConfig(codec, 640, 360, 600_000, 20))).supported) caps.encode.video.push(codec);
      } catch {
        // not supported
      }
    }
  }
  const opus = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1 };
  try {
    caps.decode.opus = 'AudioDecoder' in self && (await AudioDecoder.isConfigSupported(opus)).supported === true;
  } catch {
    caps.decode.opus = false;
  }
  try {
    caps.encode.opus = 'AudioEncoder' in self && (await AudioEncoder.isConfigSupported({ ...opus, bitrate: 48000 })).supported === true;
  } catch {
    caps.encode.opus = false;
  }
  return caps;
}

/** The video codec to send to a peer that can decode `peerDecode`. */
export function pickVideoCodec(mine, peerDecode) {
  return mine.encode.video.find((c) => (peerDecode || []).includes(c)) || null;
}

function header(kind, key, seq, ts, extra = 0) {
  const buf = new ArrayBuffer(14 + extra);
  const v = new DataView(buf);
  v.setUint8(0, kind);
  v.setUint8(1, key ? 1 : 0);
  v.setUint32(2, seq >>> 0);
  v.setBigInt64(6, BigInt(Math.max(0, Math.round(ts))));
  return { buf, v };
}

/** Splits a packet into its fields; throws on a malformed one. */
export function parsePacket(data) {
  const v = new DataView(data);
  const kind = v.getUint8(0);
  const key = (v.getUint8(1) & 1) === 1;
  const seq = v.getUint32(2);
  const ts = Number(v.getBigInt64(6));
  let offset = 14;
  const p = { kind, key, seq, ts };
  if (kind === VIDEO && key) {
    p.width = v.getUint16(14);
    p.height = v.getUint16(16);
    const len = v.getUint8(18);
    p.codec = new TextDecoder().decode(new Uint8Array(data, 19, len));
    offset = 19 + len;
  } else if (kind === AUDIO) {
    p.format = v.getUint8(14);
    p.channels = v.getUint8(15);
    p.sampleRate = v.getUint32(16);
    offset = 20;
  }
  p.data = new Uint8Array(data, offset);
  return p;
}

// ---------------------------------------------------------------- video

/**
 * Encodes video for the relay. Feed it a track (camera) with setTrack(), or
 * frames (the host's return feed) with pushFrame(). Frames are drawn into a
 * canvas no larger than `maxSide`, keeping their shape, so portrait phones
 * stay portrait; a new size reconfigures the encoder.
 */
export class VideoSender {
  constructor({ send, codec, maxSide = 640, fps = 20, bitrate = 650_000, canSend = () => true }) {
    this.send = send;
    this.codec = codec;
    this.maxSide = maxSide;
    this.fps = fps;
    this.bitrate = bitrate;
    this.canSend = canSend;
    this.seq = 0;
    this.frames = 0;
    this.lastAt = -Infinity;
    this.forceKey = true;
    this.lastKeyRequest = 0;
    this.encoder = null;
    this.size = null;
    this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(2, 2) : document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.stopped = false;
    this.reader = null;
    this.video = null;
  }

  setCodec(codec) {
    if (codec === this.codec) return;
    this.codec = codec;
    this.size = null; // reconfigure on the next frame
  }

  /** A receiver lost packets: send a keyframe soon (at most twice a second). */
  requestKey() {
    const now = performance.now();
    if (now - this.lastKeyRequest < 500) return;
    this.lastKeyRequest = now;
    this.forceKey = true;
  }

  setTrack(track) {
    this.stopReading();
    if (!track) return;
    if ('MediaStreamTrackProcessor' in self) {
      const processor = new MediaStreamTrackProcessor({ track });
      this.reader = processor.readable.getReader();
      const read = async () => {
        const reader = this.reader;
        while (!this.stopped && reader === this.reader) {
          let r;
          try {
            r = await reader.read();
          } catch {
            return;
          }
          if (r.done) return;
          this.pushFrame(r.value);
        }
      };
      read();
    } else {
      // Safari and Firefox: read the track through a <video> element.
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = new MediaStream([track]);
      video.play().catch(() => {});
      this.video = video;
      const tick = () => {
        if (this.stopped || this.video !== video) return;
        if (video.videoWidth) this.drawSource(video, video.videoWidth, video.videoHeight);
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
        else setTimeout(tick, 1000 / this.fps);
      };
      tick();
    }
  }

  stopReading() {
    this.reader?.cancel().catch(() => {});
    this.reader = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
  }

  /** Takes ownership of `frame`. */
  pushFrame(frame) {
    try {
      this.drawSource(frame, frame.displayWidth, frame.displayHeight);
    } finally {
      frame.close();
    }
  }

  drawSource(source, sw, sh) {
    if (this.stopped || !this.codec || !sw || !sh) return;
    const now = performance.now();
    if (now - this.lastAt < 1000 / this.fps - 2) return;
    // Skip frames while the network or the encoder is behind: nothing was
    // sent, so the receiver's picture stays decodable.
    if (!this.canSend() || (this.encoder && this.encoder.encodeQueueSize > 2)) return;
    this.lastAt = now;
    const scale = Math.min(1, this.maxSide / Math.max(sw, sh));
    const w = Math.max(2, Math.round((sw * scale) / 2) * 2);
    const h = Math.max(2, Math.round((sh * scale) / 2) * 2);
    if (!this.size || this.size[0] !== w || this.size[1] !== h || !this.encoder || this.encoder.state === 'closed') {
      if (!this.configure(w, h)) return;
    }
    this.ctx.drawImage(source, 0, 0, w, h);
    const frame = new VideoFrame(this.canvas, { timestamp: Math.round(now * 1000) });
    const key = this.forceKey || this.frames % (this.fps * 2) === 0;
    this.forceKey = false;
    try {
      this.encoder.encode(frame, { keyFrame: key });
      this.frames++;
    } catch {
      this.size = null;
    }
    frame.close();
  }

  configure(w, h) {
    try {
      this.encoder?.state !== 'closed' && this.encoder?.close();
    } catch {
      // already closed
    }
    this.canvas.width = w;
    this.canvas.height = h;
    const codec = this.codec;
    const encoder = new VideoEncoder({
      output: (chunk) => this.output(chunk, codec, w, h),
      error: () => {
        this.size = null;
      },
    });
    try {
      encoder.configure(videoEncoderConfig(codec, w, h, this.bitrate, this.fps));
    } catch {
      return false;
    }
    this.encoder = encoder;
    this.size = [w, h];
    this.forceKey = true;
    this.frames = 0;
    return true;
  }

  output(chunk, codec, w, h) {
    const key = chunk.type === 'key';
    const codecBytes = new TextEncoder().encode(codec);
    const extra = key ? 5 + codecBytes.length : 0;
    const { buf, v } = header(VIDEO, key, this.seq++, chunk.timestamp, extra + chunk.byteLength);
    if (key) {
      v.setUint16(14, w);
      v.setUint16(16, h);
      v.setUint8(18, codecBytes.length);
      new Uint8Array(buf, 19, codecBytes.length).set(codecBytes);
    }
    chunk.copyTo(new Uint8Array(buf, 14 + extra));
    this.send(buf);
  }

  stop() {
    this.stopped = true;
    this.stopReading();
    try {
      if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    } catch {
      // already closed
    }
  }
}

/**
 * Decodes relayed video. Calls onFrame(VideoFrame) (the callee closes it);
 * asks for a keyframe through requestKey() after a gap or an error.
 */
export class VideoReceiver {
  constructor({ onFrame, requestKey }) {
    this.onFrame = onFrame;
    this.requestKey = requestKey;
    this.decoder = null;
    this.config = '';
    this.expect = null;
    this.waitingForKey = true;
    this.lastAsk = 0;
    this.frames = 0;
  }

  ask() {
    const now = performance.now();
    if (now - this.lastAsk > 500) {
      this.lastAsk = now;
      this.requestKey();
    }
  }

  push(p) {
    if (this.expect !== null && p.seq !== this.expect) this.waitingForKey = true;
    this.expect = (p.seq + 1) >>> 0;
    if (p.key) {
      const config = `${p.codec}:${p.width}x${p.height}`;
      if (config !== this.config || !this.decoder || this.decoder.state === 'closed') {
        this.reset();
        this.decoder = new VideoDecoder({
          output: (frame) => {
            this.frames++;
            this.onFrame(frame);
          },
          error: () => {
            this.config = '';
            this.waitingForKey = true;
            this.ask();
          },
        });
        try {
          this.decoder.configure({ codec: p.codec, codedWidth: p.width, codedHeight: p.height, optimizeForLatency: true });
        } catch {
          this.config = '';
          return;
        }
        this.config = config;
      }
      this.waitingForKey = false;
    }
    if (this.waitingForKey || !this.decoder || this.decoder.state !== 'configured') {
      this.ask();
      return;
    }
    // A decoder that falls behind adds delay: drop and restart from a keyframe.
    if (this.decoder.decodeQueueSize > 8) {
      this.waitingForKey = true;
      this.ask();
      return;
    }
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: p.key ? 'key' : 'delta', timestamp: p.ts, data: p.data }));
    } catch {
      this.waitingForKey = true;
      this.ask();
    }
  }

  reset() {
    try {
      if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    } catch {
      // already closed
    }
    this.decoder = null;
  }

  close() {
    this.reset();
  }
}

// ---------------------------------------------------------------- audio

const workletLoaded = new WeakMap();

/** Loads the capture and player worklets into `ctx` once. */
export function loadRelayWorklets(ctx) {
  if (!workletLoaded.has(ctx)) {
    workletLoaded.set(ctx, Promise.all([
      ctx.audioWorklet.addModule('/static/js/capture-worklet.js'),
      ctx.audioWorklet.addModule('/static/js/relay-worklet.js'),
    ]));
  }
  return workletLoaded.get(ctx);
}

/**
 * Encodes audio from `source` (an AudioNode in `ctx`) as mono Opus, or as
 * 16-bit PCM at half the context rate when Opus cannot be used.
 */
export class AudioSender {
  constructor({ ctx, source, send, opus }) {
    this.ctx = ctx;
    this.send = send;
    this.seq = 0;
    this.stopped = false;
    this.rate = ctx.sampleRate;
    // Opus takes 48 kHz input; other context rates use the PCM path.
    this.useOpus = opus && ctx.sampleRate === 48000;
    this.node = new AudioWorkletNode(ctx, 'streamfree-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
    });
    // Rendered through a muted gain so every engine runs the worklet.
    this.mute = ctx.createGain();
    this.mute.gain.value = 0;
    source.connect(this.node);
    this.node.connect(this.mute);
    this.mute.connect(ctx.destination);
    this.source = source;
    if (this.useOpus) {
      this.encoder = new AudioEncoder({
        output: (chunk) => this.out(OPUS, 1, 48000, chunk.timestamp, (dst) => chunk.copyTo(dst), chunk.byteLength),
        error: () => {
          this.useOpus = false;
        },
      });
      this.encoder.configure({ codec: 'opus', sampleRate: this.rate, numberOfChannels: 1, bitrate: 48000 });
    }
    const channel = new MessageChannel();
    channel.port1.onmessage = ({ data: block }) => this.onBlock(block);
    this.node.port.postMessage({ port: channel.port2, active: true }, [channel.port2]);
  }

  onBlock(block) {
    if (this.stopped) return;
    const n = block.data.length / 2;
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = (block.data[i] + block.data[n + i]) * 0.5;
    const ts = (block.frame / this.rate) * 1e6;
    if (this.useOpus && this.encoder?.state === 'configured') {
      const audio = new AudioData({ format: 'f32-planar', sampleRate: this.rate, numberOfFrames: n, numberOfChannels: 1, timestamp: ts, data: mono });
      this.encoder.encode(audio);
      audio.close();
      return;
    }
    // PCM fallback at half rate (24 kHz from 48 kHz): plenty for speech.
    const half = Math.floor(n / 2);
    const pcm = new Int16Array(half);
    for (let i = 0; i < half; i++) {
      const s = (mono[2 * i] + mono[2 * i + 1]) * 0.5;
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
    }
    this.out(PCM, 1, Math.round(this.rate / 2), ts, (dst) => dst.set(new Uint8Array(pcm.buffer)), pcm.byteLength);
  }

  out(format, channels, sampleRate, ts, write, length) {
    const { buf, v } = header(AUDIO, false, this.seq++, ts, 6 + length);
    v.setUint8(14, format);
    v.setUint8(15, channels);
    v.setUint32(16, sampleRate);
    write(new Uint8Array(buf, 20, length));
    this.send(buf);
  }

  stop() {
    this.stopped = true;
    this.node.port.postMessage({ active: false });
    try {
      this.source.disconnect(this.node);
    } catch {
      // already disconnected
    }
    this.node.disconnect();
    this.mute.disconnect();
    try {
      if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    } catch {
      // already closed
    }
  }
}

/** Decodes relayed audio into a jitter-buffered player node (`this.node`). */
export class AudioReceiver {
  constructor({ ctx }) {
    this.ctx = ctx;
    this.node = new AudioWorkletNode(ctx, 'streamfree-relay-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    this.decoder = null;
    this.packets = 0;
    this.peak = 0; // loudest sample so far, for checks
  }

  push(p) {
    this.packets++;
    if (p.format === PCM) {
      const pcm = new Int16Array(p.data.buffer.slice(p.data.byteOffset, p.data.byteOffset + (p.data.byteLength & ~1)));
      const f = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
      this.play(f, p.sampleRate);
      return;
    }
    if (p.format !== OPUS) return;
    if (!this.decoder || this.decoder.state === 'closed') {
      this.decoder = new AudioDecoder({
        output: (audio) => {
          const f = new Float32Array(audio.numberOfFrames);
          audio.copyTo(f, { planeIndex: 0, format: 'f32-planar' });
          this.play(f, audio.sampleRate);
          audio.close();
        },
        error: () => {
          this.decoder = null;
        },
      });
      this.decoder.configure({ codec: 'opus', sampleRate: p.sampleRate || 48000, numberOfChannels: p.channels || 1 });
    }
    try {
      this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: p.ts, data: p.data }));
    } catch {
      this.decoder = null;
    }
  }

  play(samples, rate) {
    for (let i = 0; i < samples.length; i += 8) this.peak = Math.max(this.peak, Math.abs(samples[i]));
    this.node.port.postMessage({ samples, rate }, [samples.buffer]);
  }

  close() {
    this.node.disconnect();
    try {
      if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    } catch {
      // already closed
    }
  }
}
