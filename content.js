/* SOP — live chord panel for YouTube */
(() => {
  'use strict';
  if (window.__sopLoaded) return;
  window.__sopLoaded = true;

  const C = window.SOPCore;
  const LAG = 0.5;              // seconds of detection latency to compensate on the timeline
  const FRAME_MS = 100;
  const MAX_CHORDS_PER_LINE = 8;

  const prefs = { enabled: true, accidentals: 'auto', minimized: false, pos: null, diagrams: true };
  const state = {
    started: false, vid: null, title: '', segs: [], keyAcc: new Float32Array(12), key: null,
    transpose: 0, openSeg: null, segFloor: 0, lastT: 0, frames: 0, silent: 0,
  };
  const tracker = new C.ChordTracker();
  let ctx = null, analyser = null, buf = null, hookedVideo = null, hookedFor = new WeakSet();
  let tickTimer = null, saveTimer = null;

  // ---------- storage helpers (survive extension reloads) ----------
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const syncGet = (k) => new Promise((res) => { if (!alive()) return res({}); chrome.storage.sync.get(k, res); });
  const localGet = (k) => new Promise((res) => { if (!alive()) return res({}); chrome.storage.local.get(k, res); });
  const savePrefs = () => { if (alive()) chrome.storage.sync.set({ sopPrefs: prefs }); };

  // ---------- YouTube helpers ----------
  function getVid() {
    const u = new URL(location.href);
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/shorts\/([\w-]+)/);
    return m ? m[1] : null;
  }
  const getVideo = () =>
    document.querySelector('#movie_player video.html5-main-video') ||
    document.querySelector('video.html5-main-video') ||
    document.querySelector('ytd-reel-video-renderer[is-active] video') ||
    document.querySelector('video');
  const isAd = () => !!document.querySelector('#movie_player.ad-showing');
  const songTitle = () => document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube\s*$/, '');
  const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

  // ---------- UI ----------
  const host = document.createElement('div');
  host.id = 'sop-chords-host';
  host.style.cssText = 'position:fixed;top:80px;right:24px;z-index:2147483000;display:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Segoe UI", Roboto, system-ui, sans-serif; }
    .panel { width: 326px; background: #14161c; color: #eef0f4; border: 1px solid #2b2f3a;
      border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.45); overflow: hidden; font-size: 13px; }
    .hdr { display: flex; align-items: center; gap: 8px; padding: 9px 10px 9px 14px; cursor: move;
      background: linear-gradient(90deg, #1c1f27, #191b22); border-bottom: 1px solid #262a33; user-select: none; }
    .logo { font-weight: 800; letter-spacing: 2px; color: #f2c14e; font-size: 15px; }
    .sub { color: #8a90a0; font-size: 11px; flex: 1; }
    .live { width: 8px; height: 8px; border-radius: 50%; background: #444a58; }
    .live.on { background: #ff4d5e; box-shadow: 0 0 0 0 rgba(255,77,94,.6); animation: pulse 1.6s infinite; }
    @keyframes pulse { 70% { box-shadow: 0 0 0 7px rgba(255,77,94,0); } 100% { box-shadow: 0 0 0 0 rgba(255,77,94,0); } }
    button { cursor: pointer; border: none; font: inherit; color: inherit; }
    .ib { background: #262a34; border-radius: 7px; min-width: 26px; height: 26px; padding: 0 7px; font-size: 13px; }
    .ib:hover { background: #333846; }
    .body { padding: 12px 14px 12px; }
    .now { display: flex; align-items: flex-end; justify-content: space-between; gap: 8px; }
    .chord { font-size: 44px; font-weight: 800; line-height: 1; color: #fff; min-height: 44px; letter-spacing: -.5px; }
    .meta { text-align: right; padding-bottom: 3px; }
    .nash { color: #f2c14e; font-weight: 700; font-size: 16px; min-height: 19px; }
    .next { color: #8a90a0; font-size: 12px; margin-top: 2px; }
    .next b { color: #cfd3dc; }
    .bass { color: #9aa1b2; font-size: 12px; margin-top: 6px; }
    .bass b { color: #dfe3ea; }
    .row { display: flex; align-items: center; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
    .chip { background: #1f232c; border: 1px solid #2c313d; border-radius: 999px; padding: 4px 10px; font-size: 12px; }
    .chip b { color: #f2c14e; }
    .tr span.lbl { color: #8a90a0; font-size: 12px; margin-right: 2px; }
    .tv { min-width: 26px; text-align: center; font-weight: 700; }
    .diag { display: flex; justify-content: center; margin-top: 8px; min-height: 0; }
    .strip { margin-top: 10px; display: flex; gap: 5px; overflow-x: auto; padding-bottom: 6px; scrollbar-width: thin;
      scrollbar-color: #3a3f4c transparent; min-height: 46px; }
    .strip:empty::before { content: 'Chords you play through will build a chart here.'; color: #6b7182; font-size: 12px; padding: 6px 0; }
    .seg { flex: 0 0 auto; background: #1f232c; border: 1px solid #2c313d; border-radius: 8px; padding: 4px 8px;
      display: flex; flex-direction: column; align-items: center; min-width: 44px; }
    .seg b { font-size: 14px; } .seg i { font-style: normal; color: #6b7182; font-size: 10px; }
    .seg.cur { background: #f2c14e; border-color: #f2c14e; color: #14161c; } .seg.cur i { color: #4a3a10; }
    .seg:hover:not(.cur) { border-color: #4a5060; }
    .btn { border-radius: 8px; padding: 7px 10px; background: #262a34; font-size: 12px; font-weight: 600; }
    .btn:hover { background: #333846; }
    .btn.start { background: #f2c14e; color: #14161c; flex: 1; }
    .btn.start.stop { background: #ff4d5e; color: #fff; }
    .msg { margin-top: 8px; font-size: 11.5px; color: #9aa1b2; line-height: 1.4; }
    .msg.warn { color: #ffb4b4; }
    .mini { display: none; padding: 6px 14px 8px; font-size: 22px; font-weight: 800; }
    .panel.min .body { display: none; } .panel.min .mini { display: block; }
    svg text { font-family: inherit; }
  </style>
  <div class="panel">
    <div class="hdr"><span class="logo">SOP</span><span class="sub">live chords</span>
      <span class="live"></span><button class="ib min" title="Minimize">–</button></div>
    <div class="mini">—</div>
    <div class="body">
      <div class="now"><div class="chord">—</div>
        <div class="meta"><div class="nash"></div><div class="next">Next: <b>—</b></div></div></div>
      <div class="bass"></div>
      <div class="row"><div class="chip key">Key: <b>—</b></div><div class="chip capo" style="display:none"></div></div>
      <div class="row tr"><span class="lbl">Transpose</span><button class="ib down">−</button>
        <span class="tv">0</span><button class="ib up">+</button>
        <button class="ib acc" title="Note spelling">Auto ♯/♭</button>
        <button class="ib dg" title="Show/hide guitar shape">Shape</button></div>
      <div class="diag"></div>
      <div class="strip"></div>
      <div class="row"><button class="btn start">▶ Start listening</button>
        <button class="btn copy" title="Copy chord chart">Copy</button>
        <button class="btn clear" title="Clear this song's chart">Clear</button></div>
      <div class="msg">Press <b>Start listening</b>, then play the song. Chords show live and are saved as a chart for this video.</div>
    </div>
  </div>`;
  const $ = (s) => shadow.querySelector(s);
  const el = {
    panel: $('.panel'), hdr: $('.hdr'), live: $('.live'), min: $('.min'), mini: $('.mini'),
    chord: $('.chord'), nash: $('.nash'), next: $('.next b'), bass: $('.bass'),
    key: $('.key b'), capo: $('.capo'), tv: $('.tv'), up: $('.up'), down: $('.down'), acc: $('.acc'), dg: $('.dg'),
    diag: $('.diag'), strip: $('.strip'), start: $('.start'), copy: $('.copy'), clear: $('.clear'), msg: $('.msg'),
  };

  function mount() { if (!host.isConnected) document.documentElement.appendChild(host); }
  function applyPos() {
    if (prefs.pos) {
      const x = Math.min(Math.max(0, prefs.pos.x), window.innerWidth - 120);
      const y = Math.min(Math.max(0, prefs.pos.y), window.innerHeight - 40);
      host.style.left = x + 'px'; host.style.top = y + 'px'; host.style.right = 'auto';
    }
  }
  function setMsg(text, warn = false) { el.msg.innerHTML = text; el.msg.classList.toggle('warn', warn); }

  // Dragging
  el.hdr.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    const r = host.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
    const move = (ev) => {
      prefs.pos = { x: ev.clientX - ox, y: ev.clientY - oy };
      applyPos();
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); savePrefs(); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    e.preventDefault();
  });

  // ---------- display helpers ----------
  const flats = () => C.useFlats(prefs.accidentals, state.key, state.transpose);
  const lbl = (c) => C.label(c, state.transpose, flats());

  function segAt(t) {
    for (const s of state.segs) if (t >= s.s && t < s.e) return s;
    return null;
  }
  function nextSeg(t, cur) {
    const curId = cur ? C.chordId(cur) : null;
    for (const s of state.segs) if (s.s > t && C.chordId(s.c) !== curId) return s;
    return null;
  }

  function diagramSVG(chord) {
    const shape = C.guitarShape(chord.r, chord.q);
    const fr = shape.frets;
    const pos = fr.filter((f) => f > 0);
    const maxF = pos.length ? Math.max(...pos) : 0;
    const base = maxF <= 4 ? 1 : Math.min(...pos);
    const X = (i) => 22 + i * 16, Y = (j) => 26 + j * 18;
    let s = `<svg width="130" height="140" viewBox="0 0 130 140" aria-label="Guitar shape">`;
    for (let j = 0; j <= 5; j++) s += `<line x1="${X(0)}" y1="${Y(j)}" x2="${X(5)}" y2="${Y(j)}" stroke="#4a5060" stroke-width="1"/>`;
    for (let i = 0; i < 6; i++) s += `<line x1="${X(i)}" y1="${Y(0)}" x2="${X(i)}" y2="${Y(5)}" stroke="#6b7182" stroke-width="1"/>`;
    if (base === 1) s += `<rect x="${X(0) - 1}" y="${Y(0) - 4}" width="${X(5) - X(0) + 2}" height="4" fill="#cfd3dc" rx="1"/>`;
    else s += `<text x="${X(5) + 8}" y="${Y(0) + 13}" fill="#9aa1b2" font-size="11">${base}fr</text>`;
    if (shape.barre > 0) {
      const idx = fr.map((f, i) => (f === shape.barre ? i : -1)).filter((i) => i >= 0);
      if (idx.length >= 2) {
        const y = Y(shape.barre - base) + 9;
        s += `<rect x="${X(idx[0]) - 6}" y="${y - 6}" width="${X(idx[idx.length - 1]) - X(idx[0]) + 12}" height="12" rx="6" fill="#f2c14e"/>`;
      }
    }
    fr.forEach((f, i) => {
      if (f < 0) s += `<text x="${X(i)}" y="${Y(0) - 8}" fill="#8a90a0" font-size="11" text-anchor="middle">×</text>`;
      else if (f === 0) s += `<circle cx="${X(i)}" cy="${Y(0) - 12}" r="4" fill="none" stroke="#cfd3dc" stroke-width="1.4"/>`;
      else s += `<circle cx="${X(i)}" cy="${Y(f - base) + 9}" r="6" fill="#f2c14e"/>`;
    });
    s += `<text x="${X(0) - 4}" y="${Y(5) + 16}" fill="#6b7182" font-size="10">E  A  D  G  B  e</text>`;
    return s + '</svg>';
  }

  let shownId = null;
  function showChord(chord, t, live) {
    const id = chord ? C.chordId(chord) + '|' + state.transpose + '|' + flats() : 'N';
    if (id !== shownId) {
      shownId = id;
      const text = lbl(chord);
      el.chord.textContent = text;
      el.mini.textContent = text;
      el.nash.textContent = chord ? C.nashville(chord, state.key) : '';
      if (chord) {
        const bp = chord.b >= 0 ? chord.b : chord.r;
        const pc = C.mod12(bp + state.transpose);
        const p = C.bassPosition(pc);
        el.bass.innerHTML = `Bass: <b>${C.noteName(pc, flats())}</b> · ${p.string} string, ${p.fret === 0 ? 'open' : 'fret ' + p.fret}`;
      } else el.bass.textContent = '';
      el.diag.innerHTML = chord && prefs.diagrams ? diagramSVG({ r: C.mod12(chord.r + state.transpose), q: chord.q }) : '';
    }
    const nx = nextSeg(t, chord);
    el.next.textContent = nx ? lbl(nx.c) : '—';
    el.live.classList.toggle('on', !!live);
  }

  function renderKey() {
    el.key.textContent = state.key ? C.keyLabel(state.key, state.transpose, flats()) : '—';
    const cp = C.capo(state.key, state.transpose);
    if (cp && cp.fret > 0) {
      el.capo.style.display = '';
      el.capo.innerHTML = `Capo <b>${cp.fret}</b> → ${C.noteName(cp.shapeRoot, false)}${cp.minor ? 'm' : ''} shapes`;
    } else el.capo.style.display = 'none';
    el.tv.textContent = state.transpose > 0 ? '+' + state.transpose : String(state.transpose);
    el.acc.textContent = { auto: 'Auto ♯/♭', sharp: '♯', flat: '♭' }[prefs.accidentals];
    el.dg.style.opacity = prefs.diagrams ? '1' : '.5';
  }

  let curChip = -1;
  function renderStrip() {
    const f = flats();
    el.strip.innerHTML = state.segs.map((s, i) =>
      `<button class="seg" data-i="${i}"><b>${C.label(s.c, state.transpose, f)}</b><i>${fmtTime(s.s)}</i></button>`).join('');
    curChip = -1;
  }
  function highlightStrip(t) {
    let idx = -1;
    for (let i = 0; i < state.segs.length; i++) if (t >= state.segs[i].s && t < state.segs[i].e) { idx = i; break; }
    if (idx === curChip) return;
    const prev = el.strip.children[curChip];
    if (prev) prev.classList.remove('cur');
    curChip = idx;
    const chip = el.strip.children[idx];
    if (chip) {
      chip.classList.add('cur');
      const target = chip.offsetLeft - el.strip.clientWidth / 2 + chip.offsetWidth / 2;
      el.strip.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
    }
  }
  const rerender = () => { shownId = null; renderKey(); renderStrip(); };

  // ---------- chart storage ----------
  function addSegment(seg) {
    if (seg.e - seg.s < 0.35) return;
    const out = [];
    for (const s of state.segs) {
      if (s.e <= seg.s || s.s >= seg.e) { out.push(s); continue; }
      if (s.s < seg.s) out.push({ ...s, e: seg.s });
      if (s.e > seg.e) out.push({ ...s, s: seg.e });
    }
    out.push(seg);
    out.sort((a, b) => a.s - b.s);
    const merged = [];
    for (const s of out) {
      if (s.e - s.s < 0.2) continue;
      const last = merged[merged.length - 1];
      if (last && C.chordId(last.c) === C.chordId(s.c) && s.s - last.e < 0.3) last.e = Math.max(last.e, s.e);
      else merged.push({ ...s });
    }
    state.segs = merged;
  }
  function closeSeg(end) {
    const o = state.openSeg;
    if (!o) return;
    state.openSeg = null;
    if (end > o.s) { addSegment({ s: o.s, e: end, c: o.c }); renderStrip(); scheduleSave(); }
  }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveChart, 2000); }
  function saveChart() {
    if (!state.vid || !alive()) return;
    const r2 = (x) => Math.round(x * 100) / 100;
    const rec = {
      s: state.segs.map((x) => [r2(x.s), r2(x.e), x.c.r, x.c.q, x.c.b]),
      k: Array.from(state.keyAcc, (v) => Math.round(v * 100) / 100),
      x: state.transpose, t: state.title, u: Date.now(),
    };
    chrome.storage.local.set({ ['chart:' + state.vid]: rec });
  }
  async function loadChart(vid) {
    state.segs = []; state.keyAcc = new Float32Array(12); state.key = null; state.transpose = 0;
    const data = await localGet('chart:' + vid);
    const rec = data['chart:' + vid];
    if (rec && vid === state.vid) {
      state.segs = rec.s.map(([s, e, r, q, b]) => ({ s, e, c: { r, q, b, s: 1 } }));
      state.keyAcc = Float32Array.from(rec.k || new Array(12).fill(0));
      state.key = C.detectKey(state.keyAcc);
      state.transpose = rec.x || 0;
    }
    rerender();
  }

  // ---------- audio ----------
  function hook(video) {
    if (!ctx) ctx = new AudioContext({ latencyHint: 'playback' });
    if (!analyser) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 16384;
      analyser.smoothingTimeConstant = 0;
      buf = new Float32Array(analyser.frequencyBinCount);
    }
    if (!hookedFor.has(video)) {
      const src = ctx.createMediaElementSource(video); // throws if another extension already owns it
      src.connect(ctx.destination);
      src.connect(analyser);
      hookedFor.add(video);
      attachVideoEvents(video);
    }
    hookedVideo = video;
    if (ctx.state === 'suspended') ctx.resume();
  }

  function attachVideoEvents(v) {
    v.addEventListener('seeking', () => {
      closeSeg(state.lastT);
      tracker.reset();
      state.segFloor = v.currentTime;
    });
    v.addEventListener('pause', () => closeSeg(Math.max(state.segFloor, v.currentTime - LAG)));
  }

  function tick() {
    const v = getVideo();
    if (!v || !state.vid) return;
    if (v !== hookedVideo) {
      try { hook(v); } catch (e) { stop(); setMsg('SOP could not reach this video\'s audio. Reload the page and press Start again.', true); return; }
    }
    if (ctx.state === 'suspended') ctx.resume();
    const playing = !v.paused && !v.ended && v.readyState > 2;
    if (!playing || isAd()) {
      if (state.openSeg) closeSeg(Math.max(state.segFloor, v.currentTime - LAG));
      return;
    }
    analyser.getFloatFrequencyData(buf);
    const sr = ctx.sampleRate, n = analyser.fftSize;
    const main = C.chromaFromSpectrum(buf, sr, n, 80, 1800);
    const bass = C.bassFromSpectrum(buf, sr, n);

    if (main.energy === 0) {
      if (++state.silent === 40 && !v.muted && v.volume > 0) {
        setMsg('No sound is reaching SOP. If the song is playing, reload the page and press Start again. (Audio-equalizer extensions can block it.)', true);
      }
    } else if (state.silent) { state.silent = 0; setMsg('Listening… chords appear after a moment.'); }

    if (!state.saidListening && main.energy > 0) { state.saidListening = true; setMsg('Listening… chords appear after a moment. Click any chord in the chart to jump there.'); }
    const res = tracker.push(main.chroma, bass, main.energy);
    const t = v.currentTime;
    const tc = Math.max(state.segFloor, t - LAG);

    if (res.voiced && res.smooth) {
      for (let i = 0; i < 12; i++) state.keyAcc[i] += res.smooth[i];
      if (++state.frames % 20 === 0) {
        const prevKey = state.key ? state.key.root + ':' + state.key.minor : '';
        let total = 0;
        for (let i = 0; i < 12; i++) total += state.keyAcc[i];
        if (total > 400) state.key = C.detectKey(state.keyAcc); // wait ~10s of music before naming a key
        if ((state.key ? state.key.root + ':' + state.key.minor : '') !== prevKey) rerender();
        scheduleSave();
      }
    }
    if (res.changed) closeSeg(tc);
    if (tracker.current && !state.openSeg) state.openSeg = { s: tc, c: { ...tracker.current } };
    if (!tracker.current && state.openSeg) closeSeg(tc);
    state.lastT = t;
    showChord(tracker.current, t, true);
  }

  function uiTick() {
    if (host.style.display === 'none') return;
    const v = getVideo();
    if (!v) return;
    const t = v.currentTime;
    highlightStrip(t);
    const live = state.started && !v.paused && !v.ended && !isAd();
    if (!live) {
      const s = segAt(t);
      showChord(s ? s.c : null, t, false);
    }
  }

  function start() {
    const v = getVideo();
    if (!v) { setMsg('Open a YouTube video first.', true); return; }
    try { hook(v); } catch (e) {
      setMsg('SOP could not attach to the audio. Another extension (like an equalizer or volume booster) may already be using it — disable it and reload.', true);
      return;
    }
    state.started = true;
    state.saidListening = false;
    state.segFloor = v.currentTime;
    tracker.reset();
    clearInterval(tickTimer);
    tickTimer = setInterval(tick, FRAME_MS);
    el.start.textContent = '■ Stop';
    el.start.classList.add('stop');
    setMsg(v.paused ? 'Ready — press play on the video.' : 'Listening… chords appear after a moment.');
    if (v.paused) v.play().catch(() => {});
  }
  function stop() {
    const v = getVideo();
    state.started = false;
    clearInterval(tickTimer); tickTimer = null;
    if (v) closeSeg(Math.max(state.segFloor, v.currentTime - LAG));
    tracker.reset();
    el.start.textContent = '▶ Start listening';
    el.start.classList.remove('stop');
    el.live.classList.remove('on');
    setMsg('Paused. Your chart is saved — scrub the video to review chords, or Start again to keep building it.');
    saveChart();
  }

  // ---------- buttons ----------
  el.start.addEventListener('click', () => (state.started ? stop() : start()));
  el.min.addEventListener('click', () => {
    prefs.minimized = !prefs.minimized;
    el.panel.classList.toggle('min', prefs.minimized);
    el.min.textContent = prefs.minimized ? '+' : '–';
    savePrefs();
  });
  el.up.addEventListener('click', () => { state.transpose = Math.min(11, state.transpose + 1); rerender(); scheduleSave(); });
  el.down.addEventListener('click', () => { state.transpose = Math.max(-11, state.transpose - 1); rerender(); scheduleSave(); });
  el.acc.addEventListener('click', () => {
    prefs.accidentals = { auto: 'sharp', sharp: 'flat', flat: 'auto' }[prefs.accidentals];
    savePrefs(); rerender();
  });
  el.dg.addEventListener('click', () => { prefs.diagrams = !prefs.diagrams; savePrefs(); rerender(); });
  el.strip.addEventListener('click', (e) => {
    const b = e.target.closest('.seg');
    const v = getVideo();
    if (b && v) v.currentTime = state.segs[+b.dataset.i].s + 0.05;
  });
  el.copy.addEventListener('click', async () => {
    if (!state.segs.length) { setMsg('Nothing to copy yet — play some of the song first.'); return; }
    const f = flats();
    const lines = [`${state.title || 'Song'} — chords by SOP`];
    if (state.key) {
      const cp = C.capo(state.key, state.transpose);
      lines.push(`Key: ${C.keyLabel(state.key, state.transpose, f)}` +
        (cp && cp.fret ? `  |  Capo ${cp.fret} (${C.noteName(cp.shapeRoot, false)}${cp.minor ? 'm' : ''} shapes)` : ''));
    }
    if (state.transpose) lines.push(`Transposed ${state.transpose > 0 ? '+' : ''}${state.transpose}`);
    lines.push('');
    for (let i = 0; i < state.segs.length; i += MAX_CHORDS_PER_LINE) {
      const row = state.segs.slice(i, i + MAX_CHORDS_PER_LINE);
      const chords = row.map((s) => C.label(s.c, state.transpose, f).padEnd(7)).join(' ');
      const nums = state.key ? row.map((s) => C.nashville(s.c, state.key).padEnd(7)).join(' ') : '';
      lines.push(`[${fmtTime(row[0].s)}]  ${chords.trimEnd()}`);
      if (nums) lines.push(`        ${nums.trimEnd()}`);
    }
    try { await navigator.clipboard.writeText(lines.join('\n')); setMsg('Chord chart copied (chords + Nashville numbers).'); }
    catch { setMsg('Could not copy — click on the page once and try again.', true); }
  });
  el.clear.addEventListener('click', () => {
    if (!confirm('Clear the saved chord chart for this video?')) return;
    state.segs = []; state.keyAcc = new Float32Array(12); state.key = null; state.openSeg = null;
    tracker.reset();
    if (alive() && state.vid) chrome.storage.local.remove('chart:' + state.vid);
    rerender();
    setMsg('Chart cleared.');
  });

  // ---------- page lifecycle ----------
  function updateVisibility() {
    const show = prefs.enabled && !!getVid();
    host.style.display = show ? 'block' : 'none';
    if (!show && state.started) stop();
  }
  async function onNav() {
    const vid = getVid();
    if (vid === state.vid) { updateVisibility(); return; }
    if (state.vid) { closeSeg(state.lastT); saveChart(); }
    state.vid = vid;
    state.title = songTitle();
    state.openSeg = null; state.frames = 0; state.lastT = 0; state.segFloor = 0;
    tracker.reset();
    updateVisibility();
    if (vid) await loadChart(vid);
    setTimeout(() => { if (state.vid === vid) { state.title = songTitle(); } }, 1500);
  }

  async function init() {
    const data = await syncGet('sopPrefs');
    Object.assign(prefs, data.sopPrefs || {});
    mount(); applyPos();
    el.panel.classList.toggle('min', prefs.minimized);
    el.min.textContent = prefs.minimized ? '+' : '–';
    await onNav();
    window.addEventListener('yt-navigate-finish', onNav);
    setInterval(() => { if (getVid() !== state.vid) onNav(); }, 1000);
    setInterval(uiTick, 250);
    window.addEventListener('resize', applyPos);
    window.addEventListener('beforeunload', saveChart);
    if (alive()) {
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'sync' && ch.sopPrefs) {
          Object.assign(prefs, ch.sopPrefs.newValue || {});
          updateVisibility(); rerender();
        }
      });
    }
  }
  // ---------- popup messages ----------
  if (alive()) {
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (msg?.type === 'sop:status') {
        const v = getVideo();
        const live = state.started ? tracker.current : (v ? (segAt(v.currentTime) || {}).c : null);
        const cp = C.capo(state.key, state.transpose);
        reply({
          vid: state.vid, title: state.title || songTitle(), started: state.started,
          chord: live ? lbl(live) : '', chords: state.segs.length,
          key: state.key ? C.keyLabel(state.key, state.transpose, flats()) : '',
          capo: cp && cp.fret ? `Capo ${cp.fret}` : '',
        });
      } else if (msg?.type === 'sop:show') {
        prefs.enabled = true;
        prefs.minimized = false;
        el.panel.classList.remove('min');
        el.min.textContent = '–';
        prefs.pos = null; host.style.left = ''; host.style.top = '80px'; host.style.right = '24px';
        savePrefs(); updateVisibility();
        reply({ ok: true });
      }
    });
  }

  init();
})();
