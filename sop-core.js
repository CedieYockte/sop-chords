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
    { id: 'sus2', suffix: 'sus2', iv: [0, 2, 7],     w: [1, 0.85, 0.8],     pen: 0.05 },
    { id: 'sus4', suffix: 'sus4', iv: [0, 5, 7],     w: [1, 0.85, 0.8],     pen: 0.05 },
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

  const api = {
    SHARP, FLAT, Q, mod12, chromaFromSpectrum, bassFromSpectrum, classify, ChordTracker, detectKey,
    useFlats, noteName, label, keyLabel, nashville, capo, guitarShape, bassPosition, chordId,
  };
  root.SOPCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
