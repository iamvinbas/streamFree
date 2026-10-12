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
    this.program = this.ctx.createMediaStreamDestination();
    this.program.channelCount = 2;
    this.program.channelCountMode = 'explicit';
    // A destination with no active input produces no audio data at all, which
    // would leave the stream without an audio track. Keep a silent source
    // connected so the program always carries (possibly silent) audio.
    this.silence = this.ctx.createConstantSource();
    this.silence.offset.value = 0;
    this.silence.connect(this.program);
    this.silence.start();
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

  /** The mixed program track, fed to the encoder. */
  programTrack() {
    return this.program.stream.getAudioTracks()[0];
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
