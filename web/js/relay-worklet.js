// Plays relayed audio (see relay.js) with a small jitter buffer.
//
// Packets arrive over TCP in bursts. The player waits until about 100 ms
// are buffered, then plays at the context rate, resampling linearly from the
// sender's rate. If the buffer grows past 250 ms (the sender's clock runs a
// little fast, or a burst arrived after a stall) it skips ahead, so latency
// never creeps up during a long call; if it runs dry it refills before
// playing again.

const TARGET = 0.1; // seconds buffered before playing
const MAX = 0.25; // seconds buffered before skipping ahead

class RelayPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = sampleRate * 2; // 2 s ring at the context rate
    this.ring = new Float32Array(this.size);
    this.read = 0;
    this.write = 0;
    this.playing = false;
    this.port.onmessage = ({ data }) => this.push(data.samples, data.rate);
  }

  get buffered() {
    return (this.write - this.read + this.size) % this.size;
  }

  push(samples, rate) {
    // Resample to the context rate.
    const ratio = rate / sampleRate;
    const n = Math.floor(samples.length / ratio);
    for (let i = 0; i < n; i++) {
      const pos = i * ratio;
      const j = Math.floor(pos);
      const frac = pos - j;
      const a = samples[j];
      const b = j + 1 < samples.length ? samples[j + 1] : a;
      this.ring[this.write] = a + (b - a) * frac;
      this.write = (this.write + 1) % this.size;
      if (this.write === this.read) this.read = (this.read + 1) % this.size; // overflow: drop oldest
    }
    if (this.buffered > MAX * sampleRate) {
      this.read = (this.write - Math.round(TARGET * sampleRate) + this.size) % this.size;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!this.playing) {
      if (this.buffered >= TARGET * sampleRate) this.playing = true;
      else return true;
    }
    for (let i = 0; i < out.length; i++) {
      if (this.read === this.write) {
        this.playing = false; // ran dry: refill before playing again
        break;
      }
      out[i] = this.ring[this.read];
      this.read = (this.read + 1) % this.size;
    }
    return true;
  }
}

registerProcessor('streamfree-relay-player', RelayPlayer);
