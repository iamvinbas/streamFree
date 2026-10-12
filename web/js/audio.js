// Audio mixer for the studio.
//
// Buses:
// * program: what viewers hear — people on stage, plus the featured screen
//   share or media clip;
// * one return bus per guest ("mix-minus"): everyone except that guest, so
//   guests hear the show without hearing themselves echo back;
// * monitor: what the host hears on their speakers — everyone except the
//   host's own microphone.

export class Mixer {
  constructor() {
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    // The program bus feeds the encoder through an AudioWorklet (see
    // capture-worklet.js). A silent source keeps it rendering when nobody
    // is on stage, so the stream always carries audio.
    this.program = this.ctx.createGain();
    this.program.channelCount = 2;
    this.program.channelCountMode = 'explicit';
    this.silence = this.ctx.createConstantSource();
    this.silence.offset.value = 0;
    this.silence.connect(this.program);
    this.silence.start();
    this.capture = null;
    this.monitor = this.ctx.createGain();
    this.monitor.connect(this.ctx.destination);
    this.monitorEnabled = true;
    this.sources = new Map(); // id -> { input, gain, analyser, kind, element }
    this.guestBuses = new Map(); // guest id -> MediaStreamAudioDestinationNode
    this.onStage = new Set();
    this.featured = null;
    this.muted = new Set();
    this.levels = new Float32Array(1024);
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  /** Loads the capture worklet; call once before startCapture(). */
  async init() {
    await this.ctx.audioWorklet.addModule('/static/js/capture-worklet.js');
    this.capture = new AudioWorkletNode(this.ctx, 'streamfree-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    // Connected to the output through a muted gain so every engine renders it.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.program.connect(this.capture);
    this.capture.connect(mute);
    mute.connect(this.ctx.destination);
  }

  /**
   * Starts sending program audio blocks to `port`. Returns how context time
   * maps to wall-clock time, so the receiver can timestamp the blocks.
   */
  startCapture(port) {
    this.capture.port.postMessage({ port, active: true }, [port]);
    const ts = this.ctx.getOutputTimestamp();
    const contextTime = ts.contextTime || this.ctx.currentTime;
    const performanceTime = ts.performanceTime || performance.now();
    return {
      sampleRate: this.ctx.sampleRate,
      contextTime,
      wallMs: performance.timeOrigin + performanceTime,
    };
  }

  stopCapture() {
    this.capture?.port.postMessage({ active: false });
  }

  /** The return mix for one guest; created on first use. */
  guestTrack(guestId) {
    let bus = this.guestBuses.get(guestId);
    if (!bus) {
      bus = this.ctx.createMediaStreamDestination();
      this.guestBuses.set(guestId, bus);
      this.route();
    }
    return bus.stream.getAudioTracks()[0];
  }

  removeGuestBus(guestId) {
    const bus = this.guestBuses.get(guestId);
    if (!bus) return;
    bus.stream.getTracks().forEach((t) => t.stop());
    this.guestBuses.delete(guestId);
    this.route();
  }

  /**
   * @param {string} id participant or source id
   * @param {'host'|'guest'|'screen'|'media'} kind
   * @param {MediaStream|HTMLMediaElement} input
   */
  add(id, kind, input) {
    this.remove(id);
    let node;
    let element = null;
    if (input instanceof HTMLMediaElement) {
      node = this.ctx.createMediaElementSource(input);
      element = input;
    } else {
      if (!input.getAudioTracks().length) return;
      if (kind === 'guest') {
        // Chrome only delivers remote WebRTC audio to Web Audio while the
        // stream is also attached to a media element.
        element = new Audio();
        element.muted = true;
        element.srcObject = input;
        element.play().catch(() => {});
      }
      node = this.ctx.createMediaStreamSource(input);
    }
    const gain = this.ctx.createGain();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    node.connect(gain);
    gain.connect(analyser);
    this.sources.set(id, { input: node, gain, analyser, kind, element });
    this.route();
  }

  remove(id) {
    const s = this.sources.get(id);
    if (!s) return;
    s.input.disconnect();
    s.gain.disconnect();
    if (s.element && s.kind === 'guest') s.element.srcObject = null;
    this.sources.delete(id);
    this.route();
  }

  setVolume(id, value) {
    const s = this.sources.get(id);
    if (s) s.gain.gain.value = value;
  }

  /** Recomputes every connection from the stage, mute and featured state. */
  route() {
    for (const [id, s] of this.sources) {
      s.gain.disconnect();
      s.gain.connect(s.analyser);
      if (this.muted.has(id)) continue;
      const inProgram =
        s.kind === 'screen' || s.kind === 'media' ? this.featured === id : this.onStage.has(id);
      if (inProgram) s.gain.connect(this.program);
      for (const [guestId, bus] of this.guestBuses) {
        if (guestId === id) continue;
        if (s.kind === 'screen' || s.kind === 'media' ? inProgram : true) s.gain.connect(bus);
      }
      const hearIt = s.kind === 'host' ? false : s.kind === 'guest' || inProgram;
      if (hearIt && this.monitorEnabled) s.gain.connect(this.monitor);
    }
  }

  setStage(ids, featured) {
    this.onStage = new Set(ids);
    this.featured = featured;
    this.route();
  }

  setMuted(id, muted) {
    if (muted) this.muted.add(id);
    else this.muted.delete(id);
    this.route();
  }

  setMonitor(enabled) {
    this.monitorEnabled = enabled;
    this.route();
  }

  /** Peak level 0..1 of a source, for meters. */
  level(id) {
    const s = this.sources.get(id);
    if (!s) return 0;
    s.analyser.getFloatTimeDomainData(this.levels);
    let peak = 0;
    for (const v of this.levels) peak = Math.max(peak, Math.abs(v));
    return Math.min(1, peak);
  }
}
