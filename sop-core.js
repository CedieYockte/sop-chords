/* SOP — chord detection core (no dependencies). Works in the browser and in Node for testing. */
(function (root) {
  'use strict';

  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

  // Chord qualities: intervals, template weights, and a small penalty so simple triads win ties.
  const Q = [
    { id: 'maj',  suffix: '',     iv: [0, 4, 7],     w: [1, 0.9, 0.8],      pen: 0 },
    { id: 'min',  suffix: 'm',    iv: [0, 3, 7],     w: [1, 0.9, 0.8],      pen: 0 },
    { id: '7',    suffix: '7',    iv: [0, 4, 7, 10], w: [1, 0.9, 0.7, 0.65], pen: 0.035 },
    { id: 'maj7', suffix: 'maj7', iv: [0, 4, 7, 11], w: [1, 0.9, 0.7, 0.65], pen: 0.035 },
    { id: 'm7',   suffix: 'm7',   iv: [0, 3, 7, 10], w: [1, 0.9, 0.7, 0.65], pen: 0.035 },
    { id: 'sus2', suffix: 'sus2', iv: [0, 2, 7],     w: [1, 0.85, 0.8],     pen: 0.08 },
    { id: 'sus4', suffix: 'sus4', iv: [0, 5, 7],     w: [1, 0.85, 0.8],     pen: 0.08 },
    { id: 'dim',  suffix: 'dim',  iv: [0, 3, 6],     w: [1, 0.9, 0.8],      pen: 0.07 },
  ];

  const TEMPLATES = [];
  for (let r = 0; r < 12; r++) {
    Q.forEach((q, qi) => {
      const v = new Float32Array(12);
      q.iv.forEach((iv, j) => { v[(r + iv) % 12] = q.w[j]; });
      const n = Math.hypot(...v);
      for (let i = 0; i < 12; i++) v[i] /= n;
      TEMPLATES.push({ r, qi, v });
    });
  }

  const mod12 = (x) => ((x % 12) + 12) % 12;

  // Harmonic-aware templates: real notes also sound overtones (octave, fifth, major third...),
  // so e.g. a minor chord's root adds a little major third. Modelling that stops minor chords
  // being read as major. Used by the whole-song decoder.
  const HARM = [[0, 1], [12, 0.6], [19, 0.36], [24, 0.22], [28, 0.13], [31, 0.08]];
  const H_TEMPLATES = [];
  function buildHarmTemplates(decay) {
    H_TEMPLATES.length = 0;
    for (let r = 0; r < 12; r++) {
      Q.forEach((q, qi) => {
        const v = new Float32Array(12);
        q.iv.forEach((iv, j) => {
          HARM.forEach(([st, w], h) => { v[(r + iv + st) % 12] += q.w[j] * Math.pow(decay, h); });
        });
        const n = Math.hypot(...v);
        for (let i = 0; i < 12; i++) v[i] /= n;
        H_TEMPLATES.push({ r, qi, v });
      });
    }
  }

  function normMax(v) {
    let m = 0;
    for (let i = 0; i < 12; i++) if (v[i] > m) m = v[i];
    const out = new Float32Array(12);
    if (m > 0) for (let i = 0; i < 12; i++) out[i] = v[i] / m;
    return out;
  }

  /**
   * Build a 12-bin pitch-class profile from an AnalyserNode dB spectrum.
   * Uses spectral peaks only, with parabolic interpolation for accurate pitch.
   */
  function chromaFromSpectrum(db, sampleRate, fftSize, fmin, fmax) {
    const chroma = new Float32Array(12);
    const binHz = sampleRate / fftSize;
    const k0 = Math.max(2, Math.floor(fmin / binHz));
    const k1 = Math.min(db.length - 2, Math.ceil(fmax / binHz));
    let energy = 0;
    for (let k = k0; k <= k1; k++) {
      const v = db[k];
      if (!(v > -110)) continue;
      if (v < db[k - 1] || v < db[k + 1]) continue; // local peaks only
      const a = db[k - 1], c = db[k + 1];
      const denom = a - 2 * v + c;
      const p = Number.isFinite(denom) && denom !== 0 ? 0.5 * (a - c) / denom : 0;
      const f = (k + Math.max(-0.5, Math.min(0.5, p))) * binHz;
      const midi = 69 + 12 * Math.log2(f / 440);
      const nearest = Math.round(midi);
      const dev = Math.abs(midi - nearest);
      if (dev > 0.4) continue;
      const mag = Math.pow(10, v / 20);
      chroma[mod12(nearest)] += (1 - dev * 2) * mag;
      energy += mag * mag;
    }
    return { chroma, energy };
  }

  /**
   * Bass profile: one-hot on the LOWEST strong spectral peak (35–300 Hz),
   * so the bass note is found even when higher chord tones are louder.
   */
  function bassFromSpectrum(db, sampleRate, fftSize) {
    const out = new Float32Array(12);
    const binHz = sampleRate / fftSize;
    const k0 = Math.max(2, Math.floor(35 / binHz));
    const k1 = Math.min(db.length - 2, Math.ceil(300 / binHz));
    const peaks = [];
    let maxMag = 0;
    for (let k = k0; k <= k1; k++) {
      const v = db[k];
      if (!(v > -110) || v < db[k - 1] || v < db[k + 1]) continue;
      const mag = Math.pow(10, v / 20);
      peaks.push({ k, v, mag });
      if (mag > maxMag) maxMag = mag;
    }
    for (const p of peaks) {
      if (p.mag < maxMag * 0.35) continue;
      const a = db[p.k - 1], c = db[p.k + 1];
      const denom = a - 2 * p.v + c;
      const off = Number.isFinite(denom) && denom !== 0 ? 0.5 * (a - c) / denom : 0;
      const f = (p.k + Math.max(-0.5, Math.min(0.5, off))) * binHz;
      const midi = 69 + 12 * Math.log2(f / 440);
      if (Math.abs(midi - Math.round(midi)) > 0.4) continue;
      out[mod12(Math.round(midi))] = 1;
      break;
    }
    return out;
  }

  /** Match a smoothed chroma (+ bass chroma) against all chord templates. */
  function classify(chroma, bass) {
    const c = new Float32Array(12);
    let mean = 0;
    for (let i = 0; i < 12; i++) mean += chroma[i];
    mean /= 12;
    for (let i = 0; i < 12; i++) c[i] = Math.max(0, chroma[i] - mean * 0.6);
    const n = Math.hypot(...c);
    if (n < 1e-9) return null;
    for (let i = 0; i < 12; i++) c[i] /= n;

    const bn = normMax(bass);
    let best = null, second = null;
    for (const t of TEMPLATES) {
      let s = 0;
      for (let i = 0; i < 12; i++) s += c[i] * t.v[i];
      s += 0.12 * bn[t.r] - Q[t.qi].pen;
      const cand = { r: t.r, q: t.qi, s };
      if (!best || s > best.s) { second = best; best = cand; }
      else if (!second || s > second.s) second = cand;
    }

    // Slash chord: a clear bass note that is a chord tone but not the root.
    let bpc = -1, b1 = 0, b2 = 0;
    for (let i = 0; i < 12; i++) {
      if (bn[i] > b1) { b2 = b1; b1 = bn[i]; bpc = i; } else if (bn[i] > b2) b2 = bn[i];
    }
    let b = -1;
    if (bpc >= 0 && bpc !== best.r && b2 < 0.7) {
      const tones = Q[best.q].iv.map((iv) => (best.r + iv) % 12);
      if (tones.includes(bpc)) b = bpc;
    }
    return { r: best.r, q: best.q, b, s: best.s, margin: second ? best.s - second.s : 1 };
  }

  const chordId = (c) => (c ? `${c.r}:${c.q}:${c.b}` : 'N');

  /** Smooths frames over time and only switches chords once a new one holds steady. */
  class ChordTracker {
    constructor(o = {}) {
      this.alpha = o.alpha ?? 0.35;
      this.hold = o.hold ?? 3;
      this.minScore = o.minScore ?? 0.6;
      this.reset();
    }
    reset() {
      this.sm = null; this.bsm = null; this.current = null;
      this.cand = null; this.candN = 0; this.peakE = 0;
    }
    push(chroma, bass, energy) {
      this.peakE = Math.max(energy, this.peakE * 0.995);
      const voiced = energy > 1e-9 && energy > this.peakE * 0.01;
      const cn = normMax(chroma), bn = normMax(bass);
      if (!this.sm) { this.sm = cn; this.bsm = bn; }
      else {
        const a = this.alpha;
        for (let i = 0; i < 12; i++) {
          this.sm[i] = this.sm[i] * (1 - a) + cn[i] * a;
          this.bsm[i] = this.bsm[i] * (1 - a) + bn[i] * a;
        }
      }
      let det = null;
      if (voiced) {
        const c = classify(this.sm, this.bsm);
        if (c && c.s >= this.minScore) det = c;
      }
      const id = chordId(det), curId = chordId(this.current);
      let changed = false;
      if (id === curId) {
        this.cand = null; this.candN = 0;
        if (det && this.current) this.current.s = det.s;
      } else {
        if (this.cand && this.cand.id === id) this.candN++;
        else { this.cand = { id, det }; this.candN = 1; }
        const need = id === 'N' ? this.hold * 3 : this.hold;
        if (this.candN >= need) {
          this.current = det; this.cand = null; this.candN = 0; changed = true;
        }
      }
      return { chord: this.current, changed, voiced, smooth: this.sm, raw: det };
    }
  }

  // Krumhansl–Kessler key profiles
  const KMAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KMIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  function pearson(x, y) {
    let mx = 0, my = 0;
    for (let i = 0; i < 12; i++) { mx += x[i]; my += y[i]; }
    mx /= 12; my /= 12;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < 12; i++) {
      num += (x[i] - mx) * (y[i] - my);
      dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2;
    }
    return dx && dy ? num / Math.sqrt(dx * dy) : 0;
  }
  function detectKey(acc) {
    let total = 0;
    for (let i = 0; i < 12; i++) total += acc[i];
    if (total <= 0) return null;
    const res = [];
    for (let t = 0; t < 12; t++) {
      const x = new Array(12);
      for (let i = 0; i < 12; i++) x[i] = acc[(i + t) % 12];
      res.push({ root: t, minor: false, c: pearson(x, KMAJ) });
      res.push({ root: t, minor: true, c: pearson(x, KMIN) });
    }
    res.sort((a, b) => b.c - a.c);
    return { root: res[0].root, minor: res[0].minor, conf: res[0].c - res[1].c, corr: res[0].c };
  }

  // Note spelling
  const FLAT_MAJOR = [5, 10, 3, 8, 1, 6];   // F Bb Eb Ab Db Gb
  const FLAT_MINOR = [2, 7, 0, 5, 10, 3];   // Dm Gm Cm Fm Bbm Ebm
  function useFlats(mode, key, tr) {
    if (mode === 'flat') return true;
    if (mode === 'sharp') return false;
    if (!key) return false;
    const r = mod12(key.root + tr);
    return key.minor ? FLAT_MINOR.includes(r) : FLAT_MAJOR.includes(r);
  }
  const noteName = (pc, flats) => (flats ? FLAT : SHARP)[mod12(pc)];
  function label(ch, tr = 0, flats = false) {
    if (!ch) return '—';
    let s = noteName(ch.r + tr, flats) + Q[ch.q].suffix;
    if (ch.b >= 0) s += '/' + noteName(ch.b + tr, flats);
    return s;
  }
  function keyLabel(k, tr = 0, flats = false) {
    if (!k) return '—';
    return noteName(k.root + tr, flats) + (k.minor ? ' minor' : ' major');
  }

  // Nashville Number System (relative to the major tonic)
  const DEG = ['1', 'b2', '2', 'b3', '3', '4', 'b5', '5', 'b6', '6', 'b7', '7'];
  const NQ = { maj: '', min: 'm', '7': '7', maj7: 'maj7', m7: 'm7', sus2: 'sus2', sus4: 'sus4', dim: '°' };
  function nashville(ch, key) {
    if (!ch || !key) return '';
    const tonic = key.minor ? mod12(key.root + 3) : key.root;
    let s = DEG[mod12(ch.r - tonic)] + NQ[Q[ch.q].id];
    if (ch.b >= 0) s += '/' + DEG[mod12(ch.b - tonic)];
    return s;
  }

  // Capo suggestion: lowest capo that lets you use common open-chord keys
  function capo(key, tr = 0) {
    if (!key) return null;
    const root = mod12(key.root + tr);
    const easy = key.minor ? [9, 4, 2] : [0, 7, 2, 9, 4];
    for (let c = 0; c <= 7; c++) {
      const shape = mod12(root - c);
      if (easy.includes(shape)) return { fret: c, shapeRoot: shape, minor: key.minor };
    }
    return null;
  }

  // Guitar chord shapes (strings low E → high e; -1 = muted)
  const OPEN = {
    '0:maj': [-1, 3, 2, 0, 1, 0], '0:7': [-1, 3, 2, 3, 1, 0], '0:maj7': [-1, 3, 2, 0, 0, 0],
    '0:sus2': [-1, 3, 0, 0, 3, 3], '0:sus4': [-1, 3, 3, 0, 1, 1],
    '2:maj': [-1, -1, 0, 2, 3, 2], '2:min': [-1, -1, 0, 2, 3, 1], '2:7': [-1, -1, 0, 2, 1, 2],
    '2:maj7': [-1, -1, 0, 2, 2, 2], '2:m7': [-1, -1, 0, 2, 1, 1],
    '2:sus2': [-1, -1, 0, 2, 3, 0], '2:sus4': [-1, -1, 0, 2, 3, 3],
    '7:maj': [3, 2, 0, 0, 0, 3], '7:7': [3, 2, 0, 0, 0, 1], '7:maj7': [3, -1, 0, 0, 0, 2],
  };
  const E_SHAPE = {
    maj: [0, 2, 2, 1, 0, 0], min: [0, 2, 2, 0, 0, 0], '7': [0, 2, 0, 1, 0, 0],
    maj7: [0, 2, 1, 1, 0, 0], m7: [0, 2, 0, 0, 0, 0], sus4: [0, 2, 2, 2, 0, 0],
    dim: [0, 1, 2, 0, -1, -1],
  };
  const A_SHAPE = {
    maj: [-1, 0, 2, 2, 2, 0], min: [-1, 0, 2, 2, 1, 0], '7': [-1, 0, 2, 0, 2, 0],
    maj7: [-1, 0, 2, 1, 2, 0], m7: [-1, 0, 2, 0, 1, 0], sus2: [-1, 0, 2, 2, 0, 0],
    sus4: [-1, 0, 2, 2, 3, 0], dim: [-1, 0, 1, 2, 1, -1],
  };
  function guitarShape(r, qIndex) {
    const qid = Q[qIndex].id;
    const open = OPEN[`${r}:${qid}`];
    if (open) return { frets: open, barre: 0 };
    const opts = [];
    if (E_SHAPE[qid]) opts.push({ f: mod12(r - 4), shape: E_SHAPE[qid] });
    if (A_SHAPE[qid]) opts.push({ f: mod12(r - 9), shape: A_SHAPE[qid] });
    opts.sort((a, b) => a.f - b.f);
    const o = opts[0];
    return { frets: o.shape.map((x) => (x < 0 ? -1 : x + o.f)), barre: o.f };
  }

  function bassPosition(pc) {
    const e = mod12(pc - 4), a = mod12(pc - 9);
    return e <= a ? { string: 'E', fret: e } : { string: 'A', fret: a };
  }

  // ---------------------------------------------------------------------------------------------
  // Whole-song analysis (used by "Scan song"): 36-bin chroma (3 bins per semitone, untuned) is
  // recorded per frame; after the scan the recording's tuning is measured, the chroma is folded
  // to 12 tuned pitch classes, and the best chord sequence for the WHOLE song is found with a
  // Viterbi search (stays on a chord unless the evidence for a change is sustained).
  // ---------------------------------------------------------------------------------------------

  /** 36-bin untuned chroma + tuning statistics from one spectrum. */
  function chroma36FromSpectrum(db, sampleRate, fftSize, fmin, fmax) {
    const c = new Float32Array(36);
    const binHz = sampleRate / fftSize;
    const k0 = Math.max(2, Math.floor(fmin / binHz)), k1 = Math.min(db.length - 2, Math.ceil(fmax / binHz));
    let energy = 0, tc = 0, ts = 0;
    for (let k = k0; k <= k1; k++) {
      const v = db[k];
      if (!(v > -110) || v < db[k - 1] || v < db[k + 1]) continue;
      const a = db[k - 1], b = db[k + 1], denom = a - 2 * v + b;
      const p = Number.isFinite(denom) && denom !== 0 ? 0.5 * (a - b) / denom : 0;
      const f = (k + Math.max(-0.5, Math.min(0.5, p))) * binHz;
      const midi = 69 + 12 * Math.log2(f / 440);
      const mag = Math.pow(10, v / 20);
      const x = 3 * midi, xi = Math.floor(x), fr = x - xi;      // split between the two nearest 1/3-semitone bins
      c[((xi % 36) + 36) % 36] += mag * (1 - fr);
      c[(((xi + 1) % 36) + 36) % 36] += mag * fr;
      const ang = 2 * Math.PI * midi;
      tc += mag * Math.cos(ang); ts += mag * Math.sin(ang);
      energy += mag * mag;
    }
    return { c36: c, energy, tc, ts };
  }

  /** Lowest strong note in the bass range as an (untuned) fractional MIDI number, or -1. */
  function bassMidiFromSpectrum(db, sampleRate, fftSize) {
    const binHz = sampleRate / fftSize;
    const k0 = Math.max(2, Math.floor(35 / binHz)), k1 = Math.min(db.length - 2, Math.ceil(300 / binHz));
    let maxMag = 0; const peaks = [];
    for (let k = k0; k <= k1; k++) {
      const v = db[k];
      if (!(v > -110) || v < db[k - 1] || v < db[k + 1]) continue;
      const mag = Math.pow(10, v / 20); peaks.push([k, v, mag]); if (mag > maxMag) maxMag = mag;
    }
    for (const [k, v, mag] of peaks) {
      if (mag < maxMag * 0.35) continue;
      const a = db[k - 1], b = db[k + 1], denom = a - 2 * v + b;
      const p = Number.isFinite(denom) && denom !== 0 ? 0.5 * (a - b) / denom : 0;
      return 69 + 12 * Math.log2(((k + Math.max(-0.5, Math.min(0.5, p))) * binHz) / 440);
    }
    return -1;
  }

  const tuningCents = (tc, ts) => (tc || ts ? (Math.atan2(ts, tc) / (2 * Math.PI)) * 100 : 0);

  /** Fold 36-bin chroma to 12 tuned pitch classes. */
  function fold36(c36, cents) {
    const out = new Float32Array(12), shift = cents / (100 / 3);   // tuning offset in 1/3-semitone bins
    for (let pc = 0; pc < 12; pc++) {
      const center = 3 * pc + shift;
      for (let d = -1; d <= 1; d += 0.5) {                       // ±1/3 semitone: no leakage into neighbouring notes
        const x = center + d, xi = Math.floor(x), fr = x - xi;
        const w = 1 - Math.abs(d) * 0.6;
        const val = c36[((xi % 36) + 36) % 36] * (1 - fr) + c36[(((xi + 1) % 36) + 36) % 36] * fr;
        out[pc] += w * val;
      }
    }
    return out;
  }

  function chordScore(c, bass, t) {   // c: centred, unit-norm chroma; bass: 0..1 per pitch class
    let s = 0;
    for (let i = 0; i < 12; i++) s += c[i] * t.v[i];
    return s + 0.15 * bass[t.r] - Q[t.qi].pen;
  }
  function centre(chroma) {
    const c = new Float32Array(12);
    let mean = 0;
    for (let i = 0; i < 12; i++) mean += chroma[i];
    mean /= 12;
    for (let i = 0; i < 12; i++) c[i] = Math.max(0, chroma[i] - mean * 0.6);
    const n = Math.hypot(...c);
    if (n > 1e-9) for (let i = 0; i < 12; i++) c[i] /= n;
    return n > 1e-9 ? c : null;
  }

  /**
   * frames: [{ t, c36, bm, en }] in song time order. Returns { segs:[{s,e,r,q,b}], cents, keyAcc }.
   * switchCost: how much sustained evidence a chord change needs (higher = steadier).
   */
  function decodeSong(frames, opts = {}) {
    const N = frames.length;
    if (!N) return { segs: [], cents: 0, keyAcc: new Float32Array(12) };
    const cents = opts.cents || 0, switchCost = opts.switchCost ?? 0.9, rad = opts.smooth ?? 1;
    let peakE = 0; for (const f of frames) if (f.en > peakE) peakE = f.en;
    // tuned 12-bin chroma per frame, normalised
    const ch = frames.map((f) => normMax(fold36(f.c36, cents)));
    const bassPc = frames.map((f) => (f.bm >= 0 ? mod12(Math.round(f.bm - cents / 100)) : -1));
    const keyAcc = new Float32Array(12);
    if (opts.harm) buildHarmTemplates(opts.harm);
    const TPL = opts.harm ? H_TEMPLATES : TEMPLATES;
    const K = TPL.length, NS = K + 1;                           // last state = no chord
    const em = new Float32Array(N * NS);
    for (let i = 0; i < N; i++) {
      // short centred smoothing of chroma and bass votes
      const sm = new Float32Array(12), bs = new Float32Array(12);
      for (let j = Math.max(0, i - rad); j <= Math.min(N - 1, i + rad); j++) {
        for (let k = 0; k < 12; k++) sm[k] += ch[j][k];
      }
      for (let j = Math.max(0, i - rad - 1); j <= Math.min(N - 1, i + rad + 1); j++) if (bassPc[j] >= 0) bs[bassPc[j]] += 1;
      const bn = normMax(bs);
      const voiced = frames[i].en > peakE * 0.004;
      if (voiced) for (let k = 0; k < 12; k++) keyAcc[k] += ch[i][k];
      const c = voiced ? centre(sm) : null;
      for (let k = 0; k < K; k++) em[i * NS + k] = c ? chordScore(c, bn, TPL[k]) : 0;
      em[i * NS + K] = c ? 0.5 : 1.2;
    }
    // Viterbi with a uniform switch cost (O(N·K))
    const score = new Float32Array(NS), back = new Int16Array(N * NS);
    for (let k = 0; k < NS; k++) score[k] = em[k];
    for (let i = 1; i < N; i++) {
      let best = -1e9, bi = 0;
      for (let k = 0; k < NS; k++) if (score[k] > best) { best = score[k]; bi = k; }
      for (let k = 0; k < NS; k++) {
        const stay = score[k], jump = best - switchCost;
        if (stay >= jump) { score[k] = stay + em[i * NS + k]; back[i * NS + k] = k; }
        else { score[k] = jump + em[i * NS + k]; back[i * NS + k] = bi; }
      }
    }
    let k = 0, best = -1e9;
    for (let s = 0; s < NS; s++) if (score[s] > best) { best = score[s]; k = s; }
    const path = new Int16Array(N);
    for (let i = N - 1; i >= 0; i--) { path[i] = k; k = back[i * NS + k]; }
    // path -> segments, with a slash-bass vote per segment
    const segs = [];
    let st0 = 0;
    for (let i = 1; i <= N; i++) {
      if (i < N && path[i] === path[st0]) continue;
      const state = path[st0];
      if (state !== K) {
        const t = TPL[state];
        const votes = new Float32Array(12); let tot = 0;
        for (let j = st0; j < i; j++) if (bassPc[j] >= 0) { votes[bassPc[j]]++; tot++; }
        let bp = -1, bv = 0;
        for (let p = 0; p < 12; p++) if (votes[p] > bv) { bv = votes[p]; bp = p; }
        const tones = Q[t.qi].iv.map((iv) => (t.r + iv) % 12);
        const b = bp >= 0 && bp !== t.r && tones.includes(bp) && tot && bv / tot > 0.5 && votes[t.r] / tot < 0.25 ? bp : -1;
        segs.push({ s: frames[st0].t, e: i < N ? frames[i].t : frames[N - 1].t + 0.1, r: t.r, q: t.qi, b });
      }
      st0 = i;
    }
    return { segs, cents, keyAcc };
  }

  /** Move each chord change to the strongest onset (strum / hit) within ±win seconds. */
  function snapToOnsets(segs, onsets, win = 0.3) {
    if (!onsets || onsets.length < 20) return segs;
    const vals = onsets.map((o) => o.v).sort((a, b) => a - b);
    const med = vals[Math.floor(vals.length / 2)] || 0;
    let j = 0;
    for (let i = 1; i < segs.length; i++) {
      const b = segs[i].s;
      while (j < onsets.length && onsets[j].t < b - win) j++;
      let bt = -1, bv = med * 2.5;
      for (let k = j; k < onsets.length && onsets[k].t <= b + win; k++) {
        // prefer onsets close to the estimate: small distance penalty
        const v = onsets[k].v * (1 - 0.6 * Math.abs(onsets[k].t - b) / win);
        if (v > bv) { bv = v; bt = onsets[k].t; }
      }
      if (bt >= 0 && bt > segs[i - 1].s + 0.3) { segs[i - 1].e = bt; segs[i].s = bt; }
    }
    return segs;
  }

  /** Simplify to plain major/minor triads (keeps dim), dropping slash bass. */
  function simplify(ch) {
    if (!ch) return ch;
    const id = Q[ch.q].id;
    let q = ch.q;
    if (id === '7' || id === 'maj7' || id === 'sus2' || id === 'sus4') q = 0;
    else if (id === 'm7') q = 1;
    return { r: ch.r, q, b: -1, s: ch.s };
  }

  /** Split a chord label into root / quality / bass for fancy rendering. */
  function parts(ch, tr = 0, flats = false) {
    if (!ch) return null;
    return {
      root: noteName(ch.r + tr, flats),
      qual: Q[ch.q].suffix,
      bass: ch.b >= 0 ? noteName(ch.b + tr, flats) : '',
    };
  }

  /** Tempo from an onset-strength envelope sampled at `rate` Hz. Returns {bpm, phase} or null. */
  function estimateTempo(env, rate = 100) {
    const n = env.length;
    if (n < rate * 6) return null;
    // high-pass the envelope (remove slow loudness drift) and half-wave rectify
    const win = Math.round(rate * 0.5);
    const f = new Float32Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += env[i];
      if (i >= win) acc -= env[i - win];
      const mean = acc / Math.min(i + 1, win);
      f[i] = Math.max(0, env[i] - mean);
    }
    const lagMin = Math.floor((60 / 200) * rate), lagMax = Math.ceil((60 / 55) * rate);
    const scores = new Float32Array(lagMax + 2);
    let best = -1, bestLag = 0;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += f[i] * f[i + lag];
      s /= (n - lag);
      const bpm = (60 * rate) / lag;
      const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.7, 2));
      scores[lag] = s;
      if (s * w > best) { best = s * w; bestLag = lag; }
    }
    if (best <= 0) return null;
    // the tempo weighting only picks the region; find the true (unweighted) peak nearby
    for (let k = Math.max(lagMin, bestLag - 3); k <= Math.min(lagMax, bestLag + 3); k++) if (scores[k] > scores[bestLag]) bestLag = k;
    // parabolic refinement
    const a = scores[bestLag - 1] || 0, b = scores[bestLag], c = scores[bestLag + 1] || 0;
    const d = a - 2 * b + c;
    const lag = bestLag + (d ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / d)) : 0);
    let bpm = (60 * rate) / lag;
    while (bpm < 70) bpm *= 2;
    while (bpm > 170) bpm /= 2;
    // beat phase: offset that lines beats up with the strongest onsets
    const period = (60 * rate) / bpm;
    let bestPh = 0, bestPhS = -1;
    for (let ph = 0; ph < period; ph++) {
      let s = 0;
      for (let t = ph; t < n; t += period) s += f[Math.round(t)] || 0;
      if (s > bestPhS) { bestPhS = s; bestPh = ph; }
    }
    return { bpm, phase: bestPh };
  }

  const api = {
    chroma36FromSpectrum, bassMidiFromSpectrum, tuningCents, fold36, decodeSong, snapToOnsets, normMax,
    simplify, parts, estimateTempo,
    SHARP, FLAT, Q, mod12, chromaFromSpectrum, bassFromSpectrum, classify, ChordTracker, detectKey,
    useFlats, noteName, label, keyLabel, nashville, capo, guitarShape, bassPosition, chordId,
  };
  root.SOPCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
