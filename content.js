/* SOP — live chords on YouTube: chord bar inside the player + practice mixer below it */
(() => {
  'use strict';
  window.__sopError = '';
  console.log('[SOP] loaded v' + (chrome.runtime?.getManifest?.().version || '?') + ' on', location.href);
  try {
  // A copy left behind by an older/reloaded version can't talk to the extension any more: shut it down and take over.
  try { if (window.__sopKill) window.__sopKill(); } catch { /* ignore */ }
  document.querySelectorAll('#sop-chords-host,#sop-top-host,#sop-mix-host,#sop-sheet-host').forEach((n) => n.remove());
  window.__sopAlive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };

  const C = window.SOPCore;
  // YouTube enforces Trusted Types (and limits which policy names may exist), so a plain
  // innerHTML assignment throws "requires 'TrustedHTML'" and killed SOP before it drew anything.
  // SOP's own HTML is therefore built node-by-node with a small parser when the browser refuses it.
  // (Content scripts run in an isolated world, so this only changes SOP's code, never YouTube's.)
  const SVGNS = 'http://www.w3.org/2000/svg';
  const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'source', 'col', 'area', 'wbr']);
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
  const decode = (t) => t.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENT[e]);
  function parseInto(parent, html) {
    const doc = parent.ownerDocument || document;
    const stack = [parent];
    const top = () => stack[stack.length - 1];
    const text = (t) => { if (t) top().appendChild(doc.createTextNode(decode(t))); };
    const attrRe = /\s*([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?|\s*(\/?)>/y;
    let i = 0;
    while (i < html.length) {
      const lt = html.indexOf('<', i);
      if (lt < 0) { text(html.slice(i)); break; }
      text(html.slice(i, lt));
      if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt); i = e < 0 ? html.length : e + 3; continue; }
      if (html[lt + 1] === '/') {
        const gt = html.indexOf('>', lt), name = html.slice(lt + 2, gt).trim().toLowerCase();
        for (let k = stack.length - 1; k > 0; k--) if ((stack[k].localName || '').toLowerCase() === name) { stack.length = k; break; }
        i = gt + 1; continue;
      }
      const m = /^<([a-zA-Z][\w:-]*)/.exec(html.slice(lt, lt + 80));
      if (!m) { text('<'); i = lt + 1; continue; }
      const name = m[1];
      const attrs = []; let j = lt + m[0].length, selfClose = false;
      for (;;) {
        attrRe.lastIndex = j;
        const a = attrRe.exec(html);
        if (!a) { j = html.indexOf('>', j) + 1; break; }
        j = attrRe.lastIndex;
        if (a[1] === undefined) { selfClose = a[5] === '/'; break; }
        attrs.push([a[1], decode(a[2] ?? a[3] ?? a[4] ?? '')]);
      }
      const parentNode = top();
      const svg = name.toLowerCase() === 'svg' || parentNode.namespaceURI === SVGNS;
      const el = svg ? doc.createElementNS(SVGNS, name) : doc.createElement(name);
      for (const [k, v] of attrs) { try { el.setAttribute(k, v); } catch { /* ignore bad attribute */ } }
      parentNode.appendChild(el);
      const lname = name.toLowerCase();
      if (lname === 'style' || lname === 'script' || lname === 'textarea' || lname === 'title') {
        const close = html.toLowerCase().indexOf('</' + lname, j);
        el.textContent = html.slice(j, close < 0 ? html.length : close);
        i = close < 0 ? html.length : html.indexOf('>', close) + 1;
        continue;
      }
      if (!selfClose && !VOID.has(lname)) stack.push(el);
      i = j;
    }
  }
  const ttPolicy = (() => {
    const tt = window.trustedTypes;
    if (!tt || !tt.createPolicy) return null;
    try { return tt.createPolicy('sop-html', { createHTML: (x) => x }); } catch { return null; }
  })();
  const trusted = (html) => (ttPolicy && typeof html === 'string' ? ttPolicy.createHTML(html) : html);
  if (!window.__sopTTShim) {
    window.__sopTTShim = true;
    for (const proto of [Element.prototype, ShadowRoot.prototype]) {
      const d = Object.getOwnPropertyDescriptor(proto, 'innerHTML');
      if (!d || !d.set) continue;
      Object.defineProperty(proto, 'innerHTML', {
        ...d,
        set(v) {
          if (ttPolicy) { try { d.set.call(this, ttPolicy.createHTML(String(v))); return; } catch { /* fall through */ } }
          try { d.set.call(this, v); return; } catch { /* Trusted Types refused it: build the nodes ourselves */ }
          while (this.firstChild) this.removeChild(this.firstChild);
          if (v != null && v !== '') parseInto(this, String(v));
        },
      });
    }
  }

  const LAG = 0.5;        // detection latency compensation (s)
  const FRAME_MS = 100;   // chord frames
  const FLUX_MS = 20;     // onset frames for tempo (50 Hz)
  const ROOT_HUES = [0, 25, 48, 75, 110, 150, 175, 195, 220, 255, 285, 320];

  // ---------------- state ----------------
  const prefs = { enabled: false, accidentals: 'auto', instrument: 'guitar', simplify: false, mixer: true, collapsed: false };
  const st = {
    vid: null, title: '', segs: [], keyAcc: new Float32Array(12), key: null,
    transpose: 0, capo: 0, bpmManual: 0, bpmAuto: 0, anchor: 0,
    started: false, openSeg: null, segFloor: 0, lastT: 0, frames: 0, silent: 0,
    loop: { a: null, b: null, on: false },
  };
  const tracker = new C.ChordTracker({ hold: 4 });
  let segVer = 0;
  const flux = [];   // onset envelope at 100 Hz
  let prevSpec = null;

  // ---------------- small helpers ----------------
  const alive = () => window.__sopAlive();
  const getSync = (k) => new Promise((r) => (alive() ? chrome.storage.sync.get(k, r) : r({})));
  const getLocal = (k) => new Promise((r) => (alive() ? chrome.storage.local.get(k, r) : r({})));
  const savePrefs = () => { if (alive()) chrome.storage.sync.set({ sopSettings: prefs }); };
  const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const fmt2 = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const getVid = () => (location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null);
  const getPlayer = () => document.querySelector('#movie_player');
  const getVideo = () => document.querySelector('#movie_player video.html5-main-video') || document.querySelector('video.html5-main-video');
  const isAd = () => !!document.querySelector('#movie_player.ad-showing');
  const songTitle = () => document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube\s*$/, '');
  const bpm = () => st.bpmManual || st.bpmAuto || 0;
  // chords are shown transposed and relative to the capo (i.e. the shapes you play)
  const shift = () => st.transpose - st.capo;
  const flats = () => C.useFlats(prefs.accidentals, st.key, shift());
  const shapeChord = (c) => (prefs.simplify ? C.simplify(c) : c);
  const chordHTML = (c) => {
    const p = C.parts(shapeChord(c), shift(), flats());
    if (!p) return '—';
    return `${esc(p.root)}${p.qual ? `<sup>${esc(p.qual)}</sup>` : ''}${p.bass ? `<small>/${esc(p.bass)}</small>` : ''}`;
  };
  const chordText = (c) => C.label(shapeChord(c), shift(), flats());
  function stopEvents(host) {
    ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress', 'wheel', 'contextmenu']
      .forEach((ev) => host.addEventListener(ev, (e) => e.stopPropagation()));
  }

  // ======================= TOP BAR (inside the player) =======================
  const top = document.createElement('div');
  top.id = 'sop-top-host';
  top.style.cssText = 'position:absolute;top:10px;left:12px;right:12px;z-index:61;display:none;';
  stopEvents(top);
  const ts = top.attachShadow({ mode: 'open' });
  ts.innerHTML = `
  <style>
    * { box-sizing: border-box; font-family: "Segoe UI", Roboto, system-ui, sans-serif; }
    .bar { background: rgba(24,25,30,.93); contain: layout paint;
      border: 1px solid rgba(255,255,255,.09); border-radius: 14px; color: #f1f2f5; box-shadow: 0 10px 30px rgba(0,0,0,.35); overflow: hidden; }
    .tb { display: flex; align-items: center; gap: 8px; padding: 8px 10px; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,.07); }
    .logo { font-weight: 800; letter-spacing: 1.5px; color: #f2c14e; font-size: 13px; margin-right: 2px; }
    .grp { display: flex; align-items: center; gap: 6px; font-weight: 600; white-space: nowrap; }
    .grp > span.l { color: #c9ccd4; }
    .step { display: flex; align-items: center; background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.1); border-radius: 8px; height: 28px; }
    .step button { width: 24px; height: 26px; background: none; border: none; color: #fff; font-size: 15px; cursor: pointer; }
    .step button:hover { background: rgba(255,255,255,.1); }
    .step b { min-width: 36px; text-align: center; font-size: 13.5px; }
    .step b i { font-style: normal; color: #f2c14e; font-size: 10px; margin-left: 2px; }
    .sp { flex: 1; }
    .btn, select { height: 28px; border-radius: 8px; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.08); color: #fff;
      font: 600 12.5px "Segoe UI", Roboto, system-ui, sans-serif; padding: 0 10px; cursor: pointer; white-space: nowrap; }
    select { padding: 0 6px; } select option { background: #222; }
    .btn:hover, select:hover { background: rgba(255,255,255,.15); }
    .btn.on { background: rgba(242,193,78,.18); border-color: rgba(242,193,78,.55); color: #ffd97a; }
    .btn.listen { background: #f2c14e; color: #17140a; border-color: #f2c14e; }
    .btn.listen.live { background: rgba(255,77,94,.16); border-color: rgba(255,77,94,.6); color: #ffb0b8; }
    .btn.listen.live::before { content: ''; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #ff4d5e; margin-right: 6px; vertical-align: 1px; animation: p 1.4s infinite; }
    @keyframes p { 50% { opacity: .3; } }
    .ico { width: 28px; padding: 0; font-size: 14px; }
    .row { display: flex; align-items: stretch; gap: 10px; padding: 10px; }
    .cards { flex: 1; display: flex; gap: 8px; overflow-x: auto; contain: content; padding-bottom: 6px; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.25) transparent; min-height: 86px; }
    .card { flex: 0 0 auto; width: 122px; height: 80px; border-radius: 12px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.1);
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; cursor: pointer; position: relative; overflow: hidden; color: #fff; }
    .card:hover { background: rgba(255,255,255,.12); }
    .card .n { font-size: 25px; font-weight: 800; line-height: 1; }
    .card .n sup { font-size: 13px; font-weight: 700; margin-left: 1px; }
    .card .n small { font-size: 15px; font-weight: 700; color: #d6d8de; }
    .card .m { font-size: 12px; color: #b9bcc6; }
    .card .pb { position: absolute; left: 12px; right: 12px; bottom: 9px; height: 3px; border-radius: 3px; background: rgba(255,255,255,.12); }
    .card .pb i { display: block; height: 100%; width: 0; border-radius: 3px; background: #f2c14e; }
    .card.cur { border-color: #f2c14e; background: rgba(242,193,78,.14); box-shadow: inset 0 0 0 1px rgba(242,193,78,.4); }
    .card.live .m::after { content: ' · live'; color: #ff8a96; }
    .empty { color: #c9ccd4; font-size: 13px; align-self: center; padding: 0 6px; line-height: 1.5; }
    .shape { flex: 0 0 auto; width: 118px; display: flex; flex-direction: column; align-items: center; justify-content: center;
      background: rgba(255,255,255,.05); border-radius: 12px; border: 1px solid rgba(255,255,255,.08); }
    .shape .cap { font-size: 10.5px; color: #b9bcc6; margin-top: 2px; }
    .msg { padding: 0 12px 9px; font-size: 12px; color: #ffb4b4; display: none; }
    .bar.min .row, .bar.min .msg { display: none; }
    .bar.min .tb { border-bottom: none; }
    .now { font-weight: 800; font-size: 15px; color: #ffd97a; min-width: 40px; display: none; }
    .now sup { font-size: 10px; } .now small { font-size: 12px; }
    .bar.min .now { display: block; }
    @media (max-width: 760px) { .hide-s { display: none; } .shape { display: none; } }
  </style>
  <div class="bar">
    <div class="tb">
      <span class="logo">SOP</span>
      <span class="now"></span>
      <div class="grp"><span class="l">Key:</span><div class="step"><button data-a="k-">−</button><b class="key">—</b><button data-a="k+">+</button></div></div>
      <div class="grp"><span class="l">BPM:</span><div class="step"><button data-a="b-">−</button><b class="bpm" title="Double-click to reset to detected tempo">—</b><button data-a="b+">+</button></div></div>
      <span class="sp"></span>
      <button class="btn listen" data-a="listen">▶ Listen</button>
      <select class="inst hide-s" title="Instrument"><option value="guitar">Guitar</option><option value="piano">Piano</option><option value="bass">Bass</option></select>
      <select class="capo" title="Capo"></select>
      <button class="btn simp hide-s" data-a="simp">≡ Simplify</button>
      <button class="btn" data-a="sheet">▤ Sheet</button>
      <button class="btn hide-s" data-a="mixer" title="Practice mixer below the video">♫ Mixer</button>
      <button class="btn ico" data-a="min" title="Collapse">▴</button>
      <button class="btn ico" data-a="close" title="Turn off SOP">✕</button>
    </div>
    <div class="row"><div class="cards"></div><div class="shape"></div></div>
    <div class="msg"></div>
  </div>`;
  const T = (s) => ts.querySelector(s);
  const tEl = { bar: T('.bar'), now: T('.now'), key: T('.key'), bpm: T('.bpm'), listen: T('.listen'), inst: T('.inst'), capo: T('.capo'),
    simp: T('.simp'), cards: T('.cards'), shape: T('.shape'), msg: T('.msg'), min: T('[data-a="min"]'), mixer: T('[data-a="mixer"]') };

  function topMsg(text) { tEl.msg.textContent = text || ''; tEl.msg.style.display = text ? 'block' : 'none'; }

  // ---------- chord shape diagrams ----------
  function guitarSVG(r, q) {
    const shape = C.guitarShape(r, q), fr = shape.frets, pos = fr.filter((f) => f > 0);
    const maxF = pos.length ? Math.max(...pos) : 0, base = maxF <= 4 ? 1 : Math.min(...pos);
    const X = (i) => 18 + i * 14, Y = (j) => 14 + j * 13;
    let s = `<svg width="100" height="84" viewBox="0 0 100 84">`;
    for (let j = 0; j <= 4; j++) s += `<line x1="${X(0)}" y1="${Y(j)}" x2="${X(5)}" y2="${Y(j)}" stroke="rgba(255,255,255,.35)"/>`;
    for (let i = 0; i < 6; i++) s += `<line x1="${X(i)}" y1="${Y(0)}" x2="${X(i)}" y2="${Y(4)}" stroke="rgba(255,255,255,.5)"/>`;
    if (base === 1) s += `<rect x="${X(0) - 1}" y="${Y(0) - 3}" width="${X(5) - X(0) + 2}" height="3" fill="#e9eaee"/>`;
    else s += `<text x="${X(5) + 5}" y="${Y(0) + 10}" fill="#c9ccd4" font-size="9">${base}fr</text>`;
    if (shape.barre > 0) {
      const idx = fr.map((f, i) => (f === shape.barre ? i : -1)).filter((i) => i >= 0);
      if (idx.length >= 2) s += `<rect x="${X(idx[0]) - 5}" y="${Y(shape.barre - base) + 1.5}" width="${X(idx[idx.length - 1]) - X(idx[0]) + 10}" height="10" rx="5" fill="#f2c14e"/>`;
    }
    fr.forEach((f, i) => {
      if (f < 0) s += `<text x="${X(i)}" y="${Y(0) - 4}" fill="#9aa0ad" font-size="9" text-anchor="middle">×</text>`;
      else if (f === 0) s += `<circle cx="${X(i)}" cy="${Y(0) - 7}" r="3" fill="none" stroke="#e9eaee" stroke-width="1.2"/>`;
      else s += `<circle cx="${X(i)}" cy="${Y(f - base) + 6.5}" r="5" fill="#f2c14e"/>`;
    });
    return s + '</svg>';
  }
  function pianoSVG(r, q) {
    const tones = C.Q[q].iv.map((iv) => C.mod12(r + iv));
    const whites = [0, 2, 4, 5, 7, 9, 11], blacks = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 };
    const W = 7, s0 = 4; let s = `<svg width="104" height="60" viewBox="0 0 104 60">`;
    for (let o = 0; o < 2; o++) whites.forEach((pc, i) => {
      const on = tones.includes(pc), x = s0 + (o * 7 + i) * W;
      s += `<rect x="${x}" y="6" width="${W - 1}" height="44" rx="1.5" fill="${on ? '#f2c14e' : '#e9eaee'}"/>`;
      if (on && pc === r) s += `<circle cx="${x + 3}" cy="44" r="1.8" fill="#17140a"/>`;
    });
    for (let o = 0; o < 2; o++) Object.entries(blacks).forEach(([pc, i]) => {
      const on = tones.includes(+pc), x = s0 + (o * 7 + i) * W + W * 0.62;
      s += `<rect x="${x}" y="6" width="${W * 0.72}" height="27" rx="1" fill="${on ? '#c9952a' : '#1b1c20'}"/>`;
    });
    return s + '</svg>';
  }
  function bassSVG(rootPc) {
    const p = C.bassPosition(rootPc), si = p.string === 'E' ? 0 : 1, f0 = p.fret;
    const dots = [[si, f0, true], [si + 1, f0 + 2, false], [si + 2, f0 + 2, false]].filter((d) => d[0] < 4);
    const base = f0 <= 2 ? 1 : f0; const X = (i) => 22 + i * 18, Y = (j) => 14 + j * 13;
    let s = `<svg width="100" height="84" viewBox="0 0 100 84">`;
    for (let j = 0; j <= 4; j++) s += `<line x1="${X(0)}" y1="${Y(j)}" x2="${X(3)}" y2="${Y(j)}" stroke="rgba(255,255,255,.35)"/>`;
    for (let i = 0; i < 4; i++) s += `<line x1="${X(i)}" y1="${Y(0)}" x2="${X(i)}" y2="${Y(4)}" stroke="rgba(255,255,255,.5)" stroke-width="${1.8 - i * .25}"/>`;
    if (base === 1) s += `<rect x="${X(0) - 1}" y="${Y(0) - 3}" width="${X(3) - X(0) + 2}" height="3" fill="#e9eaee"/>`;
    else s += `<text x="${X(3) + 5}" y="${Y(0) + 10}" fill="#c9ccd4" font-size="9">${base}fr</text>`;
    dots.forEach(([i, f, root]) => {
      if (f === 0) s += `<circle cx="${X(i)}" cy="${Y(0) - 7}" r="3.5" fill="none" stroke="#f2c14e" stroke-width="1.6"/>`;
      else s += `<circle cx="${X(i)}" cy="${Y(f - base) + 6.5}" r="5" fill="${root ? '#f2c14e' : 'rgba(242,193,78,.45)'}"/>`;
    });
    return s + '</svg>';
  }
  let shapeId = '';
  function renderShape(c) {
    const sc = shapeChord(c);
    const id = sc ? `${C.chordId(sc)}|${shift()}|${prefs.instrument}|${flats()}` : 'none';
    if (id === shapeId) return;
    shapeId = id;
    if (!sc) { tEl.shape.innerHTML = `<span class="cap">chord shape</span>`; return; }
    const r = C.mod12(sc.r + shift());
    const svg = prefs.instrument === 'piano' ? pianoSVG(r, sc.q)
      : prefs.instrument === 'bass' ? bassSVG(C.mod12((sc.b >= 0 ? sc.b : sc.r) + shift())) : guitarSVG(r, sc.q);
    tEl.shape.innerHTML = svg + `<span class="cap">${esc(chordText(c))} · ${prefs.instrument}</span>`;
  }

  // ---------- chord cards ----------
  function displaySegs() {
    // Chart segments (+ the one being heard right now), simplified & merged for display
    const list = st.segs.slice();
    if (st.openSeg) {
      const v = getVideo();
      list.push({ s: st.openSeg.s, e: Math.max(st.openSeg.s + 0.1, v ? v.currentTime - LAG : st.openSeg.s), c: st.openSeg.c, live: true });
      list.sort((a, b) => a.s - b.s);
    }
    const minLen = Math.max(0.6, bpm() ? 60 / bpm() * 0.9 : 0.6);   // shorter than ~1 beat = passing note, not a chord change
    const out = [];
    for (const s of list) {
      const c = shapeChord(s.c), last = out[out.length - 1];
      const short = !s.live && s.e - s.s < minLen;
      if (last && (C.chordId(last.c) === C.chordId(c) || short) && s.s - last.e < 0.6) { last.e = Math.max(last.e, s.e); last.live = last.live || s.live; }
      else out.push({ s: s.s, e: s.e, c, raw: s.c, live: !!s.live });
    }
    // second pass: merge neighbours that became identical after folding
    const merged = [];
    for (const d of out) {
      const last = merged[merged.length - 1];
      if (last && C.chordId(last.c) === C.chordId(d.c) && d.s - last.e < 0.6) { last.e = Math.max(last.e, d.e); last.live = last.live || d.live; }
      else merged.push(d);
    }
    return merged;
  }
  let cardSig = '', curCard = -1, cardData = [];
  function renderCards(force) {
    cardData = displaySegs();
    const b = bpm();
    const last = cardData[cardData.length - 1];
    const liveSig = last && last.live ? `${C.chordId(last.c)}@${last.s.toFixed(1)}-${b ? Math.max(1, Math.round((last.e - last.s) * b / 60)) : Math.round(last.e - last.s)}` : '';
    const sig = `${segVer}|${cardData.length}|${liveSig}|${Math.round(b)}|${shift()}|${flats()}|${prefs.simplify}|${st.started}`;
    if (!force && sig === cardSig) return;
    cardSig = sig;
    if (!cardData.length) {
      tEl.cards.innerHTML = `<div class="empty">${st.started ? 'Listening… play the song and the chords will appear here.' :
        'Press <b>▶ Listen</b> and play the song. Chords appear as it plays, and the whole song is saved after one play-through.'}</div>`;
      curCard = -1; return;
    }
    tEl.cards.innerHTML = cardData.map((d, i) => {
      const beats = b ? `${Math.max(1, Math.round((d.e - d.s) * b / 60))} beats` : `${(d.e - d.s).toFixed(1)}s`;
      return `<div class="card${d.live ? ' live' : ''}" data-i="${i}"><div class="n">${chordHTML(d.raw)}</div><div class="m">${fmt(d.s)} · ${beats}</div><div class="pb"><i></i></div></div>`;
    }).join('');
    curCard = -1;
  }
  function updateCards(t) {
    let idx = -1;
    for (let i = 0; i < cardData.length; i++) if (t >= cardData[i].s && t < cardData[i].e + (cardData[i].live ? 5 : 0)) { idx = i; break; }
    const nodes = tEl.cards.children;
    if (idx !== curCard) {
      const old = nodes[curCard];
      if (old && old.classList) { old.classList.remove('cur'); const bar = old.querySelector('.pb i'); if (bar) bar.style.width = '0'; }
      curCard = idx;
      const n = nodes[idx];
      if (n && n.classList) {
        n.classList.add('cur');
        tEl.cards.scrollLeft = Math.max(0, n.offsetLeft - tEl.cards.clientWidth * 0.2);
      }
    }
    const n = nodes[idx];
    if (n && n.querySelector) {
      const d = cardData[idx];
      const pct = d.live ? 100 : Math.min(100, Math.max(0, ((t - d.s) / Math.max(0.1, d.e - d.s)) * 100));
      n.querySelector('.pb i').style.width = pct + '%';
    }
  }

  function renderToolbar() {
    if (st.key) {
      const r = C.mod12(st.key.root + st.transpose);
      tEl.key.innerHTML = esc(C.noteName(r, C.useFlats(prefs.accidentals, st.key, st.transpose)) + (st.key.minor ? 'm' : '')) +
        (st.transpose ? `<i>${st.transpose > 0 ? '+' : ''}${st.transpose}</i>` : '');
    } else tEl.key.innerHTML = st.transpose ? `<i>${st.transpose > 0 ? '+' : ''}${st.transpose}</i>` : '—';
    tEl.bpm.textContent = bpm() ? Math.round(bpm()) : '—';
    const sug = C.capo(st.key, st.transpose);
    tEl.capo.innerHTML = Array.from({ length: 8 }, (_, i) =>
      `<option value="${i}"${i === st.capo ? ' selected' : ''}>Capo ${i}${sug && sug.fret === i && i > 0 ? ' ★' : ''}</option>`).join('');
    tEl.inst.value = prefs.instrument;
    tEl.simp.classList.toggle('on', prefs.simplify);
    tEl.mixer.classList.toggle('on', prefs.mixer);
    tEl.listen.textContent = st.started ? 'Listening' : '▶ Listen';
    tEl.listen.classList.toggle('live', st.started);
    tEl.bar.classList.toggle('min', prefs.collapsed);
    tEl.min.textContent = prefs.collapsed ? '▾' : '▴';
  }

  ts.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) {
      const card = e.target.closest('.card');
      if (card) { const v = getVideo(); if (v) v.currentTime = cardData[+card.dataset.i].s + 0.02; }
      return;
    }
    const a = b.dataset.a;
    if (a === 'k+' || a === 'k-') { st.transpose = Math.max(-11, Math.min(11, st.transpose + (a === 'k+' ? 1 : -1))); changed(); }
    else if (a === 'b+' || a === 'b-') { const cur = Math.round(bpm() || 100); st.bpmManual = Math.max(30, Math.min(260, cur + (a === 'b+' ? 1 : -1))); changed(); }
    else if (a === 'listen') { st.started ? stop() : start(); }
    else if (a === 'simp') { prefs.simplify = !prefs.simplify; savePrefs(); changed(); }
    else if (a === 'sheet') openSheet();
    else if (a === 'mixer') { prefs.mixer = !prefs.mixer; savePrefs(); placeHosts(); renderToolbar(); }
    else if (a === 'min') { prefs.collapsed = !prefs.collapsed; savePrefs(); renderToolbar(); }
    else if (a === 'close') { prefs.enabled = false; savePrefs(); updateVisibility(); }
  });
  ts.addEventListener('dblclick', (e) => { if (e.target.closest('.bpm')) { st.bpmManual = 0; changed(); } });
  tEl.inst.addEventListener('change', () => { prefs.instrument = tEl.inst.value; savePrefs(); shapeId = ''; uiTick(); });
  tEl.capo.addEventListener('change', () => { st.capo = +tEl.capo.value; changed(); });

  // ======================= MIXER (below the video) =======================
  const mix = document.createElement('div');
  mix.id = 'sop-mix-host';
  mix.style.cssText = 'display:none;margin:12px 0 4px;';
  stopEvents(mix);
  const ms = mix.attachShadow({ mode: 'open' });
  const CH = [
    { id: 'vocals', name: 'Vocals', color: '#ff4d73', ico: '🎤' },
    { id: 'bass', name: 'Bass', color: '#8b7bff', ico: '🎸' },
    { id: 'drums', name: 'Drums', color: '#ffb22e', ico: '🥁' },
    { id: 'inst', name: 'Instruments', color: '#4f9dff', ico: '🎹' },
  ];
  ms.innerHTML = `
  <style>
    * { box-sizing: border-box; font-family: "Segoe UI", Roboto, system-ui, sans-serif; }
    .wrap { background: #0f1014; border: 1px solid #23252d; border-radius: 16px; padding: 14px 16px; color: #eceef2; font-size: 13px; }
    .hd { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .ttl { font-size: 11px; font-weight: 800; letter-spacing: 1.2px; color: #8c91a0; margin-right: 4px; }
    .chip { height: 30px; padding: 0 13px; border-radius: 999px; background: #1d1f26; border: 1px solid #2b2e38; color: #e6e8ed; font-weight: 600; font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 7px; }
    .chip:hover { background: #262933; }
    .chip.on { background: #ececf0; color: #111; border-color: #ececf0; }
    .chip i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .sp { flex: 1; }
    .sw { display: inline-flex; align-items: center; gap: 9px; padding: 5px 6px 5px 13px; background: #102a26; border: 1px solid #1d4a42; border-radius: 999px; color: #7fe0c8; font-weight: 600; cursor: pointer; user-select: none; }
    .sw b { width: 38px; height: 22px; border-radius: 999px; background: #2a2e38; position: relative; transition: .2s; }
    .sw b::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #cfd3dc; transition: .2s; }
    .sw.on b { background: #2fd1a8; } .sw.on b::after { left: 19px; background: #fff; }
    .note { color: #6f7484; font-size: 11.5px; margin: 8px 2px 10px; }
    .grid { display: grid; grid-template-columns: 210px 34px 1fr; gap: 6px 8px; align-items: stretch; }
    .lab { background: #17181e; border: 1px solid #23252d; border-radius: 12px; padding: 9px 12px; display: flex; flex-direction: column; justify-content: center; gap: 8px; }
    .lab .nm { font-weight: 600; display: flex; align-items: center; gap: 8px; }
    input[type=range] { width: 100%; height: 4px; -webkit-appearance: none; appearance: none; background: #33363f; border-radius: 4px; outline: none; }
    input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: var(--c); border: none; }
    .ms { display: flex; flex-direction: column; gap: 4px; }
    .ms button { flex: 1; border-radius: 7px; border: none; background: #24262e; color: #d4d7de; font-weight: 700; font-size: 11.5px; cursor: pointer; }
    .ms button:hover { background: #2f323c; }
    .ms button.m.on { background: #7a1525; color: #fff; } .ms button.s.on { background: #f2c14e; color: #17140a; }
    .lane { border-radius: 12px; border: 1px solid #23252d; overflow: hidden; position: relative; min-height: 58px; }
    .lane canvas { width: 100%; height: 100%; display: block; position: absolute; inset: 0; }
    .seg { display: inline-flex; background: #1d1f26; border-radius: 8px; padding: 2px; gap: 2px; }
    .seg button { border: none; background: none; color: #a9adb9; font-weight: 600; font-size: 11.5px; padding: 3px 8px; border-radius: 6px; cursor: pointer; }
    .seg button.on { background: #3a3d48; color: #fff; }
    .met { display: flex; align-items: center; gap: 12px; padding: 0 12px; position: absolute; inset: 0; color: #9aa0ad; font-size: 12px; background: #15161b; }
    .met .bpm { margin-left: auto; font-weight: 800; letter-spacing: .5px; color: #c9ccd4; }
    .dots { display: flex; gap: 6px; } .dots i { width: 9px; height: 9px; border-radius: 50%; background: #2c2f38; }
    .dots i.on { background: #b9a6ff; } .dots i.on.acc { background: #f2c14e; }
    .tl { position: relative; height: 46px; border-radius: 12px; overflow: hidden; background: #15161b; border: 1px solid #23252d; cursor: pointer; margin-top: 10px; }
    .tl canvas { width: 100%; height: 100%; display: block; }
    .ft { display: flex; align-items: center; gap: 12px; margin-top: 12px; flex-wrap: wrap; }
    .round { width: 40px; height: 40px; border-radius: 50%; border: none; background: #24262e; color: #fff; font-size: 15px; cursor: pointer; }
    .round.big { width: 48px; height: 48px; background: #f1f2f5; color: #111; font-size: 16px; }
    .time { font: 700 15px ui-monospace, SFMono-Regular, Menlo, monospace; color: #fff; } .time span { color: #7c8191; font-weight: 500; }
    .loop { display: flex; align-items: center; gap: 6px; color: #9aa0ad; font-size: 11px; font-weight: 800; letter-spacing: 1px; }
    .loop b { color: #e6e8ed; font-size: 12px; letter-spacing: 0; font-weight: 600; }
    .small { height: 28px; border-radius: 8px; border: 1px solid #2b2e38; background: #1d1f26; color: #e6e8ed; font-weight: 600; font-size: 12px; padding: 0 10px; cursor: pointer; letter-spacing: 0; }
    .small.on { background: rgba(242,193,78,.16); border-color: rgba(242,193,78,.5); color: #ffd97a; }
    @media (max-width: 700px) { .grid { grid-template-columns: 150px 30px 1fr; } }
  </style>
  <div class="wrap">
    <div class="hd">
      <span class="ttl">PRACTICE</span>
      <button class="chip on" data-p="all">All</button>
      <button class="chip" data-p="vocals"><i style="background:#ff4d73"></i>Vocals only</button>
      <button class="chip" data-p="karaoke">Instrumental</button>
      <button class="chip" data-p="bass"><i style="background:#8b7bff"></i>Bass focus</button>
      <button class="chip" data-p="rhythm"><i style="background:#ffb22e"></i>Rhythm only</button>
      <span class="sp"></span>
      <span class="sw" data-a="stem">Stem audio <b></b></span>
    </div>
    <div class="note">Splits the mix with audio filters on your computer (not AI), so it's instant and free. Separation is approximate and works best on stereo recordings.</div>
    <div class="grid">
      ${CH.map((c) => `
        <div class="lab" style="--c:${c.color}"><div class="nm" style="color:${c.color}"><span>${c.ico}</span>${c.name}</div>
          <input type="range" min="0" max="150" value="100" data-v="${c.id}"></div>
        <div class="ms"><button class="m" data-m="${c.id}" title="Mute">M</button><button class="s" data-s="${c.id}" title="Solo">S</button></div>
        <div class="lane" style="background:${c.color}14"><canvas data-w="${c.id}"></canvas></div>`).join('')}
      <div class="lab" style="--c:#b9a6ff"><div class="nm" style="color:#b9a6ff"><span>⏱</span>Metronome</div>
        <input type="range" min="0" max="150" value="80" data-v="metro"></div>
      <div class="ms"><button class="m on" data-m="metro" title="Click on/off">M</button><button class="s" style="visibility:hidden">S</button></div>
      <div class="lane"><div class="met"><div class="seg"><button data-sub="0.5">0.5×</button><button data-sub="1" class="on">1×</button><button data-sub="2">2×</button></div>
        <div class="dots"><i></i><i></i><i></i><i></i></div><span class="bpm">— BPM</span></div></div>
    </div>
    <div class="tl"><canvas class="tlc"></canvas></div>
    <div class="ft">
      <button class="round" data-a="back" title="Back 5 seconds">⟲</button>
      <button class="round big" data-a="play" title="Play / pause">▶</button>
      <button class="round" data-a="fwd" title="Forward 5 seconds">⟳</button>
      <span class="time">00:00 <span>/ 00:00</span></span>
      <span class="sp"></span>
      <span class="loop">LOOP A–B
        <button class="small" data-a="la">Set A</button><button class="small" data-a="lb">Set B</button>
        <button class="small lt" data-a="lt">Off</button><b class="lr">press L</b></span>
      <div class="seg speed"><button data-rate="0.5">0.5×</button><button data-rate="0.75">0.75×</button><button data-rate="1" class="on">1×</button><button data-rate="1.25">1.25×</button></div>
    </div>
  </div>`;
  const M = (s) => ms.querySelector(s);
  const mEl = { time: M('.time'), play: M('[data-a="play"]'), sw: M('.sw'), tl: M('.tlc'), bpm: M('.met .bpm'), dots: [...ms.querySelectorAll('.dots i')], lt: M('.lt'), lr: M('.lr') };
  const mixState = { stem: false, vol: { vocals: 1, bass: 1, drums: 1, inst: 1, metro: 0.8 }, mute: {}, solo: {}, metro: false, sub: 1 };

  ms.addEventListener('click', (e) => {
    const v = getVideo();
    const p = e.target.closest('[data-p]');
    if (p) return applyPreset(p.dataset.p);
    const m = e.target.closest('[data-m]');
    if (m) {
      const id = m.dataset.m;
      if (id === 'metro') { mixState.metro = !mixState.metro; m.classList.toggle('on', !mixState.metro); if (mixState.metro) ensureListening(); }
      else { mixState.mute[id] = !mixState.mute[id]; m.classList.toggle('on', mixState.mute[id]); ensureStem(); }
      return applyMix();
    }
    const s = e.target.closest('[data-s]');
    if (s && s.dataset.s) { const id = s.dataset.s; mixState.solo[id] = !mixState.solo[id]; s.classList.toggle('on', mixState.solo[id]); ensureStem(); return applyMix(); }
    const sub = e.target.closest('[data-sub]');
    if (sub) { mixState.sub = +sub.dataset.sub; ms.querySelectorAll('[data-sub]').forEach((b) => b.classList.toggle('on', b === sub)); return; }
    const rate = e.target.closest('[data-rate]');
    if (rate && v) { v.playbackRate = +rate.dataset.rate; return; }
    const a = e.target.closest('[data-a]'); if (!a || !v) return;
    const act = a.dataset.a;
    if (act === 'stem') { if (mixState.stem) { mixState.stem = false; applyMix(); } else ensureStem(); }
    else if (act === 'play') { if (v.paused) v.play(); else v.pause(); }
    else if (act === 'back') v.currentTime = Math.max(0, v.currentTime - 5);
    else if (act === 'fwd') v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 5);
    else if (act === 'la') { st.loop.a = v.currentTime; if (st.loop.b != null && st.loop.b <= st.loop.a) st.loop.b = null; renderLoop(); }
    else if (act === 'lb') { st.loop.b = v.currentTime; if (st.loop.a == null || st.loop.a >= st.loop.b) st.loop.a = Math.max(0, st.loop.b - 8); st.loop.on = true; renderLoop(); }
    else if (act === 'lt') toggleLoop();
  });
  ms.addEventListener('input', (e) => {
    const r = e.target.closest('[data-v]'); if (!r) return;
    mixState.vol[r.dataset.v] = r.value / 100;
    if (r.dataset.v !== 'metro') ensureStem();
    applyMix();
  });
  M('.tl').addEventListener('click', (e) => {
    const v = getVideo(); if (!v || !v.duration) return;
    const rc = e.currentTarget.getBoundingClientRect();
    v.currentTime = ((e.clientX - rc.left) / rc.width) * v.duration;
  });
  function toggleLoop() {
    const v = getVideo();
    if (st.loop.a == null || st.loop.b == null) {
      // quick loop: the chord section you're on
      const t = v ? v.currentTime : 0, d = cardData.find((c) => t >= c.s && t < c.e);
      if (d) { st.loop.a = d.s; st.loop.b = d.e; } else if (v) { st.loop.a = Math.max(0, t - 4); st.loop.b = t + 4; }
    }
    st.loop.on = !st.loop.on; renderLoop();
  }
  function renderLoop() {
    mEl.lt.textContent = st.loop.on ? 'On' : 'Off';
    mEl.lt.classList.toggle('on', st.loop.on);
    mEl.lr.textContent = st.loop.a != null && st.loop.b != null ? `${fmt(st.loop.a)} → ${fmt(st.loop.b)}` : st.loop.a != null ? `A ${fmt(st.loop.a)}` : 'press L';
  }
  function applyPreset(p) {
    ms.querySelectorAll('[data-p]').forEach((b) => b.classList.toggle('on', b.dataset.p === p));
    const sets = { vocals: ['vocals'], bass: ['bass'], rhythm: ['bass', 'drums'] };
    CH.forEach((c) => { mixState.solo[c.id] = false; mixState.mute[c.id] = false; });
    if (p === 'karaoke') mixState.mute.vocals = true;
    else if (sets[p]) sets[p].forEach((id) => { mixState.solo[id] = true; });
    ms.querySelectorAll('[data-m]').forEach((b) => { if (b.dataset.m !== 'metro') b.classList.toggle('on', !!mixState.mute[b.dataset.m]); });
    ms.querySelectorAll('[data-s]').forEach((b) => { if (b.dataset.s) b.classList.toggle('on', !!mixState.solo[b.dataset.s]); });
    if (p === 'all') { mixState.stem = false; applyMix(); } else ensureStem();
  }

  // ======================= AUDIO ENGINE =======================
  let ctx = null, A = null, hookedVideo = null;
  const hooked = new WeakSet();
  function buildGraph() {
    ctx = new AudioContext({ latencyHint: 'playback' });
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const bq = (type, f, q = 0.707) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; };
    const an = (size) => { const n = ctx.createAnalyser(); n.fftSize = size; n.smoothingTimeConstant = 0; return n; };
    A = { input: g(), master: g(), dry: g(1), wet: g(0), main: an(16384), fluxAn: an(2048), ch: {}, meters: {} };
    A.mainBuf = new Float32Array(A.main.frequencyBinCount);
    A.fluxBuf = new Float32Array(A.fluxAn.frequencyBinCount);
    A.input.connect(A.main); A.input.connect(A.fluxAn);
    A.input.connect(A.dry); A.dry.connect(A.master);
    A.wet.connect(A.master); A.master.connect(ctx.destination);
    // mid / side split
    const split = ctx.createChannelSplitter(2), mid = g(), side = g();
    A.split = split;
    const lm = g(0.5), rm = g(0.5), ls = g(0.5), rs = g(-0.5);
    split.connect(lm, 0); split.connect(rm, 1); split.connect(ls, 0); split.connect(rs, 1);
    lm.connect(mid); rm.connect(mid); ls.connect(side); rs.connect(side);
    const chain = (src, nodes) => nodes.reduce((a, b) => { a.connect(b); return b; }, src);
    const meter = (id, node) => { const m = an(512); node.connect(m); A.meters[id] = { an: m, buf: new Float32Array(512) }; };
    const voc = chain(mid, [bq('highpass', 220), bq('highpass', 220), bq('lowpass', 4500), bq('lowpass', 4500)]); // centre voice band
    const bas = chain(mid, [bq('lowpass', 200), bq('lowpass', 200)]);                                              // centre lows
    const drmIn = bq('highpass', 4800); A.drmIn = drmIn;
    const drm = chain(drmIn, [bq('highpass', 4800)]);                                                              // cymbals / air
    const ins = chain(side, [bq('highpass', 200), bq('lowpass', 4800)]);                                           // stereo-spread band
    const merge = ctx.createChannelMerger(2), pl = g(1), pr = g(-1), insOut = g();
    ins.connect(pl); ins.connect(pr); pl.connect(merge, 0, 0); pr.connect(merge, 0, 1); merge.connect(insOut);
    const meterSrc = { vocals: voc, bass: bas, drums: drm, inst: ins };   // meters tap the mono band (stereo-spread side signal would cancel out)
    [['vocals', voc], ['bass', bas], ['drums', drm], ['inst', insOut]].forEach(([id, node]) => {
      meter(id, meterSrc[id]);
      A.ch[id] = g(1); node.connect(A.ch[id]); A.ch[id].connect(A.wet);
    });
    A.metro = g(0.8); A.metro.connect(ctx.destination);
  }
  function hook(video) {
    if (!ctx) buildGraph();
    if (!hooked.has(video)) {
      const src = ctx.createMediaElementSource(video); // throws if another extension already owns this video's audio
      src.connect(A.input);
      hooked.add(video);
      video.addEventListener('seeking', () => { closeSeg(st.lastT); tracker.reset(); prevSpec = null; st.segFloor = video.currentTime; flux.length = 0; nextBeat = null; });
      video.addEventListener('pause', () => closeSeg(Math.max(st.segFloor, video.currentTime - LAG)));
    }
    hookedVideo = video;
    if (ctx.state === 'suspended') ctx.resume();
  }
  let branchOn = false;
  function setStemBranch() {
    if (!A) return;
    const want = mixState.stem || (window.__sopMixVisible ? window.__sopMixVisible() : false);
    if (want === branchOn) return;
    branchOn = want;
    if (want) { A.input.connect(A.split); A.input.connect(A.drmIn); }
    else { try { A.input.disconnect(A.split); A.input.disconnect(A.drmIn); } catch { /* already off */ } }
  }
  function applyMix() {
    setStemBranch();
    if (!A) { mEl.sw.classList.toggle('on', mixState.stem); return; }
    const now = ctx.currentTime, anySolo = CH.some((c) => mixState.solo[c.id]);
    A.dry.gain.setTargetAtTime(mixState.stem ? 0 : 1, now, 0.03);
    A.wet.gain.setTargetAtTime(mixState.stem ? 1 : 0, now, 0.03);
    CH.forEach((c) => {
      const on = !mixState.mute[c.id] && (!anySolo || mixState.solo[c.id]);
      A.ch[c.id].gain.setTargetAtTime(on ? mixState.vol[c.id] : 0, now, 0.03);
    });
    A.metro.gain.setTargetAtTime(mixState.vol.metro, now, 0.02);
    mEl.sw.classList.toggle('on', mixState.stem);
  }
  function ensureListening() { if (!st.started) start(); return st.started; }
  function ensureStem() { if (!ensureListening()) return; mixState.stem = true; applyMix(); }

  // ---------- chart (segments) ----------
  function addSegment(seg) {
    if (seg.e - seg.s < 0.35) return;
    const out = [];
    for (const s of st.segs) {
      if (s.e <= seg.s || s.s >= seg.e) { out.push(s); continue; }
      if (s.s < seg.s) out.push({ ...s, e: seg.s });
      if (s.e > seg.e) out.push({ ...s, s: seg.e });
    }
    out.push(seg); out.sort((a, b) => a.s - b.s);
    const merged = [];
    for (const s of out) {
      if (s.e - s.s < 0.2) continue;
      const last = merged[merged.length - 1];
      if (last && C.chordId(last.c) === C.chordId(s.c) && s.s - last.e < 0.3) last.e = Math.max(last.e, s.e);
      else merged.push({ ...s });
    }
    st.segs = merged;
    segVer++;
  }
  function closeSeg(end) {
    const o = st.openSeg; if (!o) return;
    st.openSeg = null;
    if (end > o.s) { addSegment({ s: o.s, e: end, c: o.c }); scheduleSave(); }
  }
  let saveTimer = null;
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveChart, 1500); }
  function saveChart() {
    if (!st.vid || !alive()) return;
    const r2 = (x) => Math.round(x * 100) / 100;
    chrome.storage.local.set({ ['chart:' + st.vid]: {
      s: st.segs.map((x) => [r2(x.s), r2(x.e), x.c.r, x.c.q, x.c.b]),
      k: Array.from(st.keyAcc, (v) => Math.round(v * 100) / 100),
      x: st.transpose, cp: st.capo, bm: st.bpmManual, ba: Math.round(st.bpmAuto * 10) / 10, an: r2(st.anchor),
      t: st.title, u: Date.now(),
    } });
  }
  async function loadChart(vid) {
    Object.assign(st, { segs: [], keyAcc: new Float32Array(12), key: null, transpose: 0, capo: 0, bpmManual: 0, bpmAuto: 0, anchor: 0, loop: { a: null, b: null, on: false } });
    const rec = (await getLocal('chart:' + vid))['chart:' + vid];
    if (rec && vid === st.vid) {
      st.segs = (rec.s || []).map(([s, e, r, q, b]) => ({ s, e, c: { r, q, b, s: 1 } }));
      st.keyAcc = Float32Array.from(rec.k || new Array(12).fill(0));
      st.key = C.detectKey(st.keyAcc);
      Object.assign(st, { transpose: rec.x || 0, capo: rec.cp || 0, bpmManual: rec.bm || 0, bpmAuto: rec.ba || 0, anchor: rec.an || 0 });
    }
    segVer++;
    changed();
    renderLoop();
  }
  function changed() { shapeId = ''; renderToolbar(); renderCards(true); scheduleSave(); uiTick(); }

  // ---------- detection loops ----------
  let tickTimer = null, fluxTimer = null, tempoTimer = null;
  const BLOCKED = "SOP can't hear this video — another extension (like Chord Lens or an equalizer) is already using its sound. Turn that extension off, reload the page, and press Listen.";
  function tick() {
    const v = getVideo(); if (!v || !st.vid || !A) return;
    if (v !== hookedVideo) { try { hook(v); } catch { stop(); topMsg(BLOCKED); return; } }
    if (ctx.state === 'suspended') ctx.resume();
    const playing = !v.paused && !v.ended && v.readyState > 2;
    if (!playing || isAd()) { if (st.openSeg) closeSeg(Math.max(st.segFloor, v.currentTime - LAG)); return; }
    A.main.getFloatFrequencyData(A.mainBuf);
    const sr = ctx.sampleRate, n = A.main.fftSize;
    const main = C.chromaFromSpectrum(A.mainBuf, sr, n, 80, 1800);
    const bass = C.bassFromSpectrum(A.mainBuf, sr, n);
    if (main.energy === 0) { if (++st.silent === 40 && !v.muted && v.volume > 0) topMsg(BLOCKED); }
    else if (st.silent) { st.silent = 0; topMsg(''); }
    const res = tracker.push(main.chroma, bass, main.energy);
    const t = v.currentTime, tc = Math.max(st.segFloor, t - LAG);
    if (res.voiced && res.smooth) {
      for (let i = 0; i < 12; i++) st.keyAcc[i] += res.smooth[i];
      if (++st.frames % 20 === 0) {
        let tot = 0; for (let i = 0; i < 12; i++) tot += st.keyAcc[i];
        if (tot > 400) { const k = C.detectKey(st.keyAcc); const was = st.key && `${st.key.root}${st.key.minor}`; st.key = k; if (was !== `${k.root}${k.minor}`) renderToolbar(); }
        scheduleSave();
      }
    }
    if (res.changed) closeSeg(tc);
    if (tracker.current && !st.openSeg) st.openSeg = { s: tc, c: { ...tracker.current } };
    if (!tracker.current && st.openSeg) closeSeg(tc);
    st.lastT = t;
  }
  function fluxTick() {
    const v = getVideo(); if (!A || !v || v.paused || isAd()) return;
    A.fluxAn.getFloatFrequencyData(A.fluxBuf);
    const binHz = ctx.sampleRate / A.fluxAn.fftSize, k1 = Math.min(A.fluxBuf.length, Math.ceil(8000 / binHz));
    let s = 0;
    if (prevSpec) for (let k = 2; k < k1; k++) { const d = A.fluxBuf[k] - prevSpec[k]; if (d > 0 && A.fluxBuf[k] > -90 && Number.isFinite(d)) s += d; }
    const tmp = prevSpec || new Float32Array(A.fluxBuf.length); prevSpec = A.fluxBuf; A.fluxBuf = tmp;   // swap, no allocation
    flux.push({ v: s, p: ctx.currentTime * 1000 });   // audio clock = when the analysed samples were rendered
    if (flux.length > 1000) flux.splice(0, flux.length - 1000);
  }
  function tempoTick() {
    const v = getVideo();
    if (flux.length < 350 || !v || v.paused) return;
    // resample the onset envelope onto an exact 100 Hz grid using the real clock (timers jitter)
    const p0 = flux[0].p, p1 = flux[flux.length - 1].p, grid = [];
    for (let p = p0, j = 0; p <= p1; p += 20) {
      while (j < flux.length - 2 && flux[j + 1].p <= p) j++;
      const a = flux[j], b = flux[j + 1], f = b.p > a.p ? (p - a.p) / (b.p - a.p) : 0;
      grid.push(a.v + (b.v - a.v) * Math.max(0, Math.min(1, f)));
    }
    const r = C.estimateTempo(grid, 50);
    if (!r) return;
    const rate = v.playbackRate || 1;
    const songBpm = r.bpm / rate;   // tempo of the recording, independent of playback speed
    if (!st.bpmAuto || Math.abs(st.bpmAuto - songBpm) > 6) st.bpmAuto = songBpm;
    else st.bpmAuto = st.bpmAuto * 0.7 + songBpm * 0.3;
    // beat anchor in video time: the phase frame happened (now - its time) ago
    const phaseP = p0 + r.phase * 20;
    st.anchor = v.currentTime - ((ctx.currentTime * 1000 - phaseP) / 1000) * rate;
    renderToolbar(); renderCards();
  }

  // ---------- metronome ----------
  let nextBeat = null, beatCount = 0;
  function metroTick() {
    const v = getVideo();
    if (!A || !mixState.metro || !v || v.paused || !bpm()) { nextBeat = null; return; }
    const per = 60 / bpm() / mixState.sub, rate = v.playbackRate || 1, look = 0.15, vt = v.currentTime;
    if (nextBeat == null || nextBeat < vt - 0.05 || nextBeat > vt + 2) {
      const k = Math.ceil((vt - st.anchor) / per); nextBeat = st.anchor + k * per; beatCount = k;
    }
    while (nextBeat < vt + look * rate) {
      const when = ctx.currentTime + Math.max(0, (nextBeat - vt) / rate);
      const perBar = Math.max(1, Math.round(4 * mixState.sub));
      const acc = ((beatCount % perBar) + perBar) % perBar === 0;
      const o = ctx.createOscillator(), gg = ctx.createGain();
      o.frequency.value = acc ? 1500 : 1000;
      gg.gain.setValueAtTime(0.0001, when); gg.gain.exponentialRampToValueAtTime(0.9, when + 0.002); gg.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
      o.connect(gg); gg.connect(A.metro); o.start(when); o.stop(when + 0.06);
      nextBeat += per; beatCount++;
    }
  }

  // ---------- mixer drawing ----------
  const waves = {};
  function drawMixer(v) {
    if (mix.style.display === 'none' || !mix.isConnected) return;
    const anySolo = CH.some((x) => mixState.solo[x.id]);
    CH.forEach((c) => {
      const cv = ms.querySelector(`canvas[data-w="${c.id}"]`); if (!cv) return;
      const w = cv.clientWidth, h = cv.clientHeight; if (!w) return;
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      const arr = waves[c.id] || (waves[c.id] = []);
      if (A && v && !v.paused) {
        const m = A.meters[c.id]; m.an.getFloatTimeDomainData(m.buf);
        let s = 0; for (let i = 0; i < m.buf.length; i++) s += m.buf[i] * m.buf[i];
        arr.push(Math.min(1, Math.sqrt(s / m.buf.length) * (c.id === 'drums' ? 12 : c.id === 'inst' ? 7 : 4.5)));
        if (arr.length > w / 5) arr.shift();
      }
      const g = cv.getContext('2d'); g.clearRect(0, 0, w, h);
      const on = !mixState.mute[c.id] && (!anySolo || mixState.solo[c.id]);
      g.fillStyle = on ? c.color : c.color + '55';
      if (!arr.length) { g.fillRect(4, h / 2 - 1, w - 8, 2); }
      for (let i = 0; i < arr.length; i++) { const bh = Math.max(2, arr[i] * (h - 8)); g.fillRect(i * 5 + 2, (h - bh) / 2, 3, bh); }
    });
    const cv = mEl.tl, w = cv.clientWidth, h = cv.clientHeight; if (!w || !v) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const g = cv.getContext('2d'), dur = v.duration || 1; g.clearRect(0, 0, w, h);
    if (st.loop.a != null && st.loop.b != null) { g.fillStyle = st.loop.on ? 'rgba(242,193,78,.2)' : 'rgba(255,255,255,.06)'; g.fillRect(st.loop.a / dur * w, 0, (st.loop.b - st.loop.a) / dur * w, h); }
    g.font = '600 11px Segoe UI, Roboto, sans-serif'; g.textBaseline = 'middle';
    cardData.forEach((d) => {
      const x = d.s / dur * w, ww = Math.max(1, (d.e - d.s) / dur * w);
      g.fillStyle = `hsla(${ROOT_HUES[C.mod12(d.c.r + shift())]},70%,55%,.55)`; g.fillRect(x, 8, ww - 1, h - 16);
      const label = chordText(d.raw);
      if (ww > g.measureText(label).width + 6) { g.fillStyle = '#fff'; g.fillText(label, x + 3, h / 2); }
    });
    if (!cardData.length) { g.fillStyle = '#5f6575'; g.fillText('Chord timeline builds as the song plays', 10, h / 2); }
    const px = v.currentTime / dur * w; g.fillStyle = '#ff3b4f'; g.fillRect(px - 1, 0, 2, h);
  }

  // ---------- UI loop ----------
  function uiTick() {
    const v = getVideo();
    if (!v || !prefs.enabled || !st.vid) return;
    const t = v.currentTime;
    if (st.loop.on && st.loop.a != null && st.loop.b != null && t >= st.loop.b) v.currentTime = st.loop.a;
    renderCards();
    updateCards(t);
    const live = st.started && !v.paused && st.openSeg ? st.openSeg.c : null;
    const at = live || (cardData.find((d) => t >= d.s && t < d.e) || {}).raw || null;
    renderShape(at);
    tEl.now.innerHTML = at ? chordHTML(at) : '—';
    if (mix.style.display !== 'none') {
      mEl.time.innerHTML = `${fmt2(t)} <span>/ ${fmt2(v.duration || 0)}</span>`;
      mEl.play.textContent = v.paused ? '▶' : '❚❚';
      mEl.bpm.textContent = bpm() ? `${Math.round(bpm())} BPM` : '— BPM';
      ms.querySelectorAll('[data-rate]').forEach((b) => b.classList.toggle('on', +b.dataset.rate === v.playbackRate));
      if (bpm() && !v.paused) {
        const beat = Math.floor((t - st.anchor) / (60 / bpm()));
        mEl.dots.forEach((d, i) => { d.className = ((beat % 4) + 4) % 4 === i ? (i === 0 ? 'on acc' : 'on') : ''; });
      }
    }
  }

  function start() {
    const v = getVideo();
    if (!v) return;
    try { hook(v); } catch { topMsg(BLOCKED); return; }
    st.started = true; st.segFloor = v.currentTime; tracker.reset(); prevSpec = null; flux.length = 0;
    clearInterval(tickTimer); clearInterval(fluxTimer); clearInterval(tempoTimer);
    tickTimer = setInterval(tick, FRAME_MS);
    fluxTimer = setInterval(() => { fluxTick(); metroTick(); }, FLUX_MS);
    tempoTimer = setInterval(tempoTick, 4000);
    topMsg('');
    applyMix();
    if (v.paused) v.play().catch(() => {});
    renderToolbar(); renderCards(true);
  }
  function stop() {
    const v = getVideo();
    st.started = false;
    clearInterval(tickTimer); clearInterval(fluxTimer); clearInterval(tempoTimer);
    if (v) closeSeg(Math.max(st.segFloor, v.currentTime - LAG));
    tracker.reset(); saveChart(); renderToolbar(); renderCards(true);
  }

  // ---------- sheet (printable chord chart) ----------
  function openSheet() {
    document.getElementById('sop-sheet-host')?.remove();
    const host = document.createElement('div'); host.id = 'sop-sheet-host';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483600;';
    stopEvents(host);
    const sh = host.attachShadow({ mode: 'open' });
    const segs = displaySegs(), b = bpm();
    const lines = [];
    for (let i = 0; i < segs.length; i += 8) lines.push(segs.slice(i, i + 8));
    const keyTxt = st.key ? C.keyLabel(st.key, st.transpose, C.useFlats(prefs.accidentals, st.key, st.transpose)) : '—';
    const capTxt = st.capo && st.key ? ` · Capo ${st.capo} (play ${C.noteName(st.key.root + shift(), flats())}${st.key.minor ? 'm' : ''} shapes)` : st.capo ? ` · Capo ${st.capo}` : '';
    sh.innerHTML = `<style>
      * { box-sizing: border-box; font-family: "Segoe UI", Roboto, system-ui, sans-serif; }
      .bg { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: grid; place-items: center; }
      .pg { width: min(760px, 92vw); max-height: 86vh; overflow: auto; background: #fff; color: #111; border-radius: 14px; padding: 26px 30px; }
      h1 { margin: 0 0 4px; font-size: 21px; } .meta { color: #555; font-size: 13px; margin-bottom: 18px; }
      .ln { display: grid; grid-template-columns: 54px repeat(8, 1fr); gap: 4px; padding: 7px 0; border-bottom: 1px solid #eee; align-items: baseline; }
      .ln .t { color: #999; font-size: 11.5px; } .c { font-weight: 800; font-size: 17px; } .c sup { font-size: 10px; } .c small { font-size: 12px; color: #444; }
      .nn { display: block; color: #b58a16; font-size: 11px; font-weight: 700; }
      .act { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }
      button { border: 1px solid #ddd; background: #f6f6f7; border-radius: 8px; padding: 8px 14px; font-weight: 600; cursor: pointer; }
      button.p { background: #f2c14e; border-color: #f2c14e; }
      .empty { color: #777; padding: 20px 0; }
    </style>
    <div class="bg"><div class="pg">
      <h1>${esc(st.title || 'Song')}</h1>
      <div class="meta">Key ${esc(keyTxt)}${b ? ` · ${Math.round(b)} BPM` : ''}${esc(capTxt)}${st.transpose ? ` · transposed ${st.transpose > 0 ? '+' : ''}${st.transpose}` : ''}${prefs.simplify ? ' · simplified' : ''}</div>
      ${lines.length ? lines.map((row) => `<div class="ln"><span class="t">${fmt(row[0].s)}</span>${row.map((d) =>
        `<span class="c">${chordHTML(d.raw)}<span class="nn">${esc(st.key ? C.nashville(d.c, st.key) : '')}</span></span>`).join('')}</div>`).join('')
        : '<div class="empty">No chords yet — press Listen and play the song through once.</div>'}
      <div class="act"><button data-a="copy">Copy text</button><button data-a="print">Print</button><button class="p" data-a="close">Close</button></div>
    </div></div>`;
    sh.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (e.target.classList.contains('bg') || a === 'close') host.remove();
      else if (a === 'copy') {
        const txt = [`${st.title} — chords by SOP`, sh.querySelector('.meta').textContent, '',
          ...lines.map((row) => `[${fmt(row[0].s)}]  ${row.map((d) => chordText(d.raw).padEnd(7)).join(' ').trimEnd()}` +
            (st.key ? `\n        ${row.map((d) => C.nashville(d.c, st.key).padEnd(7)).join(' ').trimEnd()}` : ''))].join('\n');
        try { await navigator.clipboard.writeText(txt); e.target.textContent = 'Copied ✓'; } catch { e.target.textContent = 'Copy failed'; }
      } else if (a === 'print') {
        const w = window.open('', '_blank', 'width=820,height=900');
        if (w) {
          const page = sh.querySelector('.pg').cloneNode(true); page.querySelector('.act').remove();
          const html = `<html><head><meta charset="utf-8"><title>${esc(st.title)}</title><style>${sh.querySelector('style').textContent} .pg{max-height:none;width:auto}</style></head><body>${page.outerHTML}</body></html>`;
          try { w.document.write(trusted(html)); } catch { parseInto(w.document.documentElement, html.replace(/^<html>|<\/html>$/g, '')); }
          w.document.close(); w.focus(); w.print();
        }
      }
    });
    document.body.appendChild(host);
  }

  // ---------- placement / lifecycle ----------
  function placeHosts() {
    const show = prefs.enabled && !!st.vid;
    const player = getPlayer();
    if (show && player && top.parentNode !== player) player.appendChild(top);
    top.style.display = show ? 'block' : 'none';
    const below = document.querySelector('ytd-watch-flexy #below') || document.querySelector('#below');
    if (show && prefs.mixer && below && mix.parentNode !== below) below.prepend(mix);
    mix.style.display = show && prefs.mixer ? 'block' : 'none';
  }
  function updateVisibility() {
    placeHosts();
    if (!prefs.enabled && st.started) stop();
  }
  async function onNav() {
    const vid = getVid();
    if (vid === st.vid) { placeHosts(); return; }
    if (st.vid) { closeSeg(st.lastT); saveChart(); }
    st.vid = vid; st.title = songTitle(); st.openSeg = null; st.frames = 0; st.lastT = 0; st.segFloor = 0;
    tracker.reset(); flux.length = 0; prevSpec = null; Object.keys(waves).forEach((k) => (waves[k] = []));
    if (st.started && !vid) stop();
    placeHosts();
    if (vid) await loadChart(vid);
    setTimeout(() => { if (st.vid === vid) st.title = songTitle(); }, 1500);
  }

  document.addEventListener('keydown', (e) => {
    if (!prefs.enabled || !st.vid || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
    if (e.key === 'l' || e.key === 'L') { toggleLoop(); e.preventDefault(); e.stopPropagation(); }
  }, true);

  if (alive()) {
    chrome.runtime.onMessage.addListener((msg, _s, reply) => {
      if (msg?.type === 'sop:status') {
        const v = getVideo();
        const at = st.openSeg ? st.openSeg.c : v ? (cardData.find((d) => v.currentTime >= d.s && v.currentTime < d.e) || {}).raw : null;
        reply({ vid: st.vid, title: st.title || songTitle(), started: st.started, chord: at ? chordText(at) : '', chords: st.segs.length,
          key: st.key ? C.keyLabel(st.key, st.transpose, flats()) : '', capo: st.capo ? `Capo ${st.capo}` : '', enabled: prefs.enabled });
      } else if (msg?.type === 'sop:show') {
        prefs.enabled = true; prefs.collapsed = false; savePrefs(); updateVisibility(); renderToolbar();
        reply({ ok: true });
      }
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'sync' && ch.sopSettings) { Object.assign(prefs, ch.sopSettings.newValue || {}); shapeId = ''; updateVisibility(); renderToolbar(); renderCards(true); }
    });
  }

  (async function init() {
   try {
    Object.assign(prefs, (await getSync('sopSettings')).sopSettings || {});
    await onNav();
    console.log('[SOP] ready — panel', prefs.enabled ? 'ON' : 'OFF (switch it on in the SOP popup)', '| player found:', !!getPlayer(), '| video id:', st.vid);
    window.addEventListener('yt-navigate-finish', onNav);
    window.addEventListener('beforeunload', saveChart);
    const iv1 = setInterval(() => { if (getVid() !== st.vid) onNav(); else if (prefs.enabled) placeHosts(); }, 1000);
    const iv2 = setInterval(uiTick, 200);
    let dead = false;
    let mixOnScreen = false;
    const io = new IntersectionObserver((es) => { mixOnScreen = es.some((e) => e.isIntersecting); setStemBranch(); }, { threshold: 0 });
    io.observe(mix);
    const iv3 = setInterval(() => { if (!dead && prefs.enabled && mixOnScreen && !document.hidden) drawMixer(getVideo()); }, 66);
    window.__sopMixVisible = () => mixOnScreen;
    window.__sopKill = () => {
      dead = true;
      clearInterval(iv1); clearInterval(iv2); clearInterval(iv3); io.disconnect(); clearInterval(tickTimer); clearInterval(fluxTimer); clearInterval(tempoTimer);
      window.removeEventListener('yt-navigate-finish', onNav);
      st.started = false;
      top.remove(); mix.remove();
    };
   } catch (err) { window.__sopError = String(err && err.stack || err); console.error('[SOP] failed to start:', err); }
  })();
  } catch (err) {
    window.__sopError = String(err && err.stack || err);
    console.error('[SOP] failed to start:', err);
  }
})();
