/* SOP — key-change engine for the song's audio.
 * Phase vocoder pitch shifter with peak phase-locking (Laroche & Dolson) for clean, exact notes,
 * and spectral-envelope (formant) preservation so voices keep their natural character.
 * Classic script: works as a content script, in an AudioWorklet, and in Node for testing. */
(function (G) {
  'use strict';
  const TAU = Math.PI * 2;

  class FFT {
    constructor(n) {
      this.n = n;
      this.cos = new Float64Array(n / 2);
      this.sin = new Float64Array(n / 2);
      for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos((TAU * i) / n); this.sin[i] = Math.sin((TAU * i) / n); }
      this.rev = new Uint32Array(n);
      const bits = Math.log2(n);
      for (let i = 0; i < n; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
        this.rev[i] = r;
      }
    }
    transform(re, im, inverse) {
      const n = this.n, rev = this.rev, cs = this.cos, sn = this.sin;
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      const sg = inverse ? 1 : -1;
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = 0, k = 0; j < half; j++, k += step) {
            const a = i + j, b = a + half;
            const c = cs[k], s = sg * sn[k];
            const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
            re[b] = re[a] - tr; im[b] = im[a] - ti;
            re[a] += tr; im[a] += ti;
          }
        }
      }
      if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }

  // moving average of src[0..half] with half-width w, written to dst
  function boxSmooth(src, dst, half, w) {
    let sum = 0, cnt = 0;
    for (let k = 0; k <= Math.min(half, w); k++) { sum += src[k]; cnt++; }
    for (let k = 0; k <= half; k++) {
      dst[k] = sum / cnt;
      const add = k + w + 1, rem = k - w;
      if (add <= half) { sum += src[add]; cnt++; }
      if (rem >= 0) { sum -= src[rem]; cnt--; }
    }
  }

  class SOPPitchShifter {
    constructor(sampleRate, opts = {}) {
      const N = (this.N = opts.fftSize || 4096);
      this.os = opts.osamp || 4;
      this.H = N / this.os;
      this.sr = sampleRate;
      this.half = N / 2;
      this.fft = new FFT(N);
      this.win = new Float64Array(N);
      for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((TAU * i) / N);
      this.inFIFO = new Float32Array(N);
      this.outFIFO = new Float32Array(N);
      this.outAcc = new Float64Array(2 * N);
      this.latency = N - this.H;            // FIFO position (internal)
      this.delay = N;                       // samples of delay from input to output (measured)
      this.phase = Math.round((opts.phase || 0) * this.H);   // stagger frame work between channels (same delay)
      this.rover = this.latency + this.phase;
      const h1 = this.half + 1;
      this.lastPhase = new Float64Array(h1);
      this.lastOut = new Float64Array(h1);
      this.mag = new Float64Array(h1);
      this.ph = new Float64Array(h1);
      this.tb = new Float64Array(h1);       // true frequency of each bin, in bins
      this.logEnv = new Float64Array(h1);
      this.outMag = new Float64Array(h1);
      this.outPh = new Float64Array(h1);
      this.peaks = new Int32Array(h1);
      this.re = new Float64Array(N); this.im = new Float64Array(N);
      this.cre = new Float64Array(N); this.cim = new Float64Array(N);
      this.expct = (TAU * this.H) / N;
      this.norm = 1 / (0.375 * this.os);   // Hann analysis + synthesis overlap-add gain
      this.smoothW = Math.max(2, Math.round((90 * N) / sampleRate)); // envelope smoothing: ±90 Hz per pass
      this.ratio = 1;
      this.formant = opts.formant !== false;
    }
    setSemitones(n) { this.ratio = Math.pow(2, n / 12); }
    reset() {
      this.inFIFO.fill(0); this.outFIFO.fill(0); this.outAcc.fill(0);
      this.lastPhase.fill(0); this.lastOut.fill(0); this.rover = this.latency + this.phase;
    }
    /** Stream any block size. out may be the same length as inp. */
    process(inp, out) {
      const lat = this.latency, N = this.N, inF = this.inFIFO, outF = this.outFIFO;
      for (let i = 0; i < inp.length; i++) {
        inF[this.rover] = inp[i];
        out[i] = outF[this.rover - lat];
        if (++this.rover >= N) { this.rover = lat; this._frame(); }
      }
    }
    _envelope(peaks, np) {
      // Spectral envelope: a line through the log-magnitudes of the spectral peaks, then smoothed.
      // Following the peaks (not the valleys between harmonics) tracks formants for low and high voices alike.
      const half = this.half, mag = this.mag, env = this.logEnv, a = this.cre, b = this.cim, w = this.smoothW;
      if (np === 0) { env.fill(0); return; }
      let pk = peaks[0], pv = Math.log(mag[pk] + 1e-9);
      for (let k = 0; k <= pk; k++) a[k] = pv;
      for (let i = 1; i < np; i++) {
        const k1 = peaks[i], v1 = Math.log(mag[k1] + 1e-9), span = k1 - pk;
        for (let k = pk + 1; k <= k1; k++) a[k] = pv + ((v1 - pv) * (k - pk)) / span;
        pk = k1; pv = v1;
      }
      for (let k = pk + 1; k <= half; k++) a[k] = pv;
      boxSmooth(a, b, half, w);     // a -> b
      boxSmooth(b, env, half, w);   // b -> env  (two passes = triangular smoothing)
    }
    _frame() {
      const N = this.N, H = this.H, half = this.half, re = this.re, im = this.im, win = this.win;
      const mag = this.mag, ph = this.ph, tb = this.tb, lastPhase = this.lastPhase, expct = this.expct;
      for (let k = 0; k < N; k++) { re[k] = this.inFIFO[k] * win[k]; im[k] = 0; }
      this.fft.transform(re, im, false);
      let maxMag = 0;
      for (let k = 0; k <= half; k++) {
        const r = re[k], q = im[k], m = Math.sqrt(r * r + q * q), p = Math.atan2(q, r);
        mag[k] = m; ph[k] = p;
        let d = p - lastPhase[k] - k * expct;
        lastPhase[k] = p;
        d -= TAU * Math.round(d / TAU);
        tb[k] = k + d / expct;
        if (m > maxMag) maxMag = m;
      }
      const ratio = this.ratio, outMag = this.outMag, outPh = this.outPh, lastOut = this.lastOut;
      outMag.fill(0);
      if (maxMag > 1e-9) {
        // spectral peaks (local maxima over ±2 bins)
        const peaks = this.peaks, floor = maxMag * 1e-5;
        let np = 0;
        for (let k = 1; k < half; k++) {
          const m = mag[k];
          if (m > floor && m > mag[k - 1] && m >= mag[k + 1] && (k < 2 || m > mag[k - 2]) && (k + 2 > half || m >= mag[k + 2])) peaks[np++] = k;
        }
        const useEnv = this.formant && ratio !== 1;
        if (useEnv) this._envelope(peaks, np);
        const logEnv = this.logEnv;
        // move each peak and its region (bins nearest to it) as one block, phase-locked to the peak
        for (let i = 0; i < np; i++) {
          const p = peaks[i];
          let lo = 0, hi = half;
          if (i > 0) { lo = peaks[i - 1]; for (let k = peaks[i - 1]; k < p; k++) if (mag[k] < mag[lo]) lo = k; lo += 1; }
          if (i < np - 1) { hi = p; for (let k = p; k < peaks[i + 1]; k++) if (mag[k] < mag[hi]) hi = k; }
          const newFreq = tb[p] * ratio;                // exact target frequency, in bins
          const target = Math.round(newFreq);
          if (target < 0 || target > half) continue;
          const d = target - p;
          const rot = lastOut[target] + expct * newFreq - ph[p];
          for (let k = lo; k <= hi; k++) {
            const j = k + d;
            if (j < 0 || j > half) continue;
            let m = mag[k];
            if (useEnv) {
              // keep the original spectral envelope (formants) at the new position: natural voice
              let g = logEnv[j] - logEnv[k];
              if (g > 2.3) g = 2.3; else if (g < -2.3) g = -2.3;
              m *= Math.exp(g);
            }
            if (m > outMag[j]) { outMag[j] = m; outPh[j] = ph[k] + rot; }
          }
        }
      }
      for (let j = 0; j <= half; j++) {
        if (outMag[j] > 0) lastOut[j] = outPh[j] % TAU;
        else lastOut[j] = (lastOut[j] + expct * j) % TAU;
      }
      // synthesis
      for (let j = 0; j <= half; j++) { re[j] = outMag[j] * Math.cos(outPh[j]); im[j] = outMag[j] * Math.sin(outPh[j]); }
      im[0] = 0; im[half] = 0;
      for (let j = 1; j < half; j++) { re[N - j] = re[j]; im[N - j] = -im[j]; }
      this.fft.transform(re, im, true);
      const acc = this.outAcc, norm = this.norm;
      for (let k = 0; k < N; k++) acc[k] += win[k] * re[k] * norm;
      for (let k = 0; k < H; k++) this.outFIFO[k] = acc[k];
      acc.copyWithin(0, H, 2 * N);
      acc.fill(0, 2 * N - H);
      this.inFIFO.copyWithin(0, H, N);
    }
  }

  G.SOPPitchShifter = SOPPitchShifter;
  G.SOPFFT = FFT;
  if (typeof module !== 'undefined' && module.exports) module.exports = { SOPPitchShifter, FFT };
})(typeof globalThis !== 'undefined' ? globalThis : this);
