// Audio capture for the encoder. Runs on the audio rendering thread: it
// batches the program mix into 1024-frame planar blocks and sends them, with
// the context frame at which each block starts, to the compositor worker.
// Works the same in Chromium and WebKit (which cannot read audio tracks with
// MediaStreamTrackProcessor).

const BLOCK = 1024;
const CHANNELS = 2;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.out = null;
    this.active = false;
    this.block = null;
    this.filled = 0;
    this.startFrame = 0;
    this.port.onmessage = (e) => {
      if (e.data.port) this.out = e.data.port;
      if ('active' in e.data) {
        this.active = e.data.active;
        this.block = null;
      }
    };
  }

  process(inputs) {
    if (!this.active || !this.out) return true;
    const input = inputs[0] || [];
    const frames = input[0] ? input[0].length : 128;
    if (!this.block) {
      this.block = new Float32Array(BLOCK * CHANNELS);
      this.filled = 0;
      this.startFrame = currentFrame;
    }
    for (let c = 0; c < CHANNELS; c++) {
      const src = input[c] || input[0];
      if (src) this.block.set(src.subarray(0, Math.min(frames, BLOCK - this.filled)), c * BLOCK + this.filled);
    }
    this.filled += frames;
    if (this.filled >= BLOCK) {
      this.out.postMessage({ frame: this.startFrame, data: this.block }, [this.block.buffer]);
      this.block = null;
    }
    return true;
  }
}

registerProcessor('streamfree-capture', CaptureProcessor);
