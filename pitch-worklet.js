/* SOP — AudioWorklet that runs the key-change engine off the main thread (needs pitch-dsp.js loaded first). */
class SOPPitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // the right channel does its heavy work half a hop later, so no single audio block carries both
    this.sh = [new globalThis.SOPPitchShifter(sampleRate, { phase: 0 }), new globalThis.SOPPitchShifter(sampleRate, { phase: 0.5 })];
    this.active = false;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.semis === 'number') this.sh.forEach((s) => s.setSemitones(d.semis));
      if (typeof d.formant === 'boolean') this.sh.forEach((s) => { s.formant = d.formant; });
      if (typeof d.active === 'boolean') {
        if (d.active && !this.active) this.sh.forEach((s) => s.reset());
        this.active = d.active;
      }
    };
    this.port.postMessage({ delay: this.sh[0].delay });
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!out) return true;
    if (!this.active || !inp || !inp.length) { for (const ch of out) ch.fill(0); return true; }
    for (let c = 0; c < out.length && c < 2; c++) this.sh[c].process(inp[Math.min(c, inp.length - 1)], out[c]);
    return true;
  }
}
registerProcessor('sop-pitch', SOPPitchProcessor);
