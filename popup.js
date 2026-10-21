const C = window.SOPCore;
const REPO = 'https://github.com/CedieYockte/sop-chords';
const defaults = { enabled: true, accidentals: 'auto', minimized: false, pos: null, diagrams: true };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let prefs = { ...defaults };

function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 1600);
}
const openTab = (url) => chrome.tabs.create({ url });
const keyOf = (rec) => {
  const k = rec && rec.k ? C.detectKey(Float32Array.from(rec.k)) : null;
  if (!k) return null;
  const tr = rec.x || 0;
  return { key: k, short: C.noteName(k.root + tr, C.useFlats(prefs.accidentals, k, tr)) + (k.minor ? 'm' : '') };
};

// ---------- settings ----------
function renderPrefs() {
  $('enabled').checked = prefs.enabled;
  $('diagrams').checked = prefs.diagrams;
  document.querySelectorAll('#acc button').forEach((b) => b.classList.toggle('on', b.dataset.v === prefs.accidentals));
}
const savePrefs = () => chrome.storage.sync.set({ sopPrefs: prefs });
$('enabled').addEventListener('change', (e) => { prefs.enabled = e.target.checked; savePrefs(); loadContext(); });
$('diagrams').addEventListener('change', (e) => { prefs.diagrams = e.target.checked; savePrefs(); });
$('acc').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  prefs.accidentals = b.dataset.v; savePrefs(); renderPrefs(); loadCharts();
});

// ---------- stats + recent songs ----------
function loadCharts() {
  chrome.storage.local.get(null, (all) => {
    const charts = Object.entries(all).filter(([k]) => k.startsWith('chart:'))
      .map(([k, v]) => ({ vid: k.slice(6), ...v })).filter((c) => c.s && c.s.length);
    $('sSongs').textContent = charts.length;
    $('sChords').textContent = charts.reduce((n, c) => n + c.s.length, 0).toLocaleString();
    const tally = {};
    charts.forEach((c) => { const k = keyOf(c); if (k) tally[k.short] = (tally[k.short] || 0) + 1; });
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    $('sKey').textContent = top ? top[0] : '—';

    const box = $('songs');
    $('clearAll').style.display = charts.length ? '' : 'none';
    if (!charts.length) { box.innerHTML = '<div class="empty">Songs you play with SOP will show here.</div>'; return; }
    charts.sort((a, b) => (b.u || 0) - (a.u || 0));
    box.innerHTML = charts.slice(0, 3).map((c) => {
      const k = keyOf(c);
      return `<div class="song" data-vid="${esc(c.vid)}"><span class="k">${k ? esc(k.short) : '?'}</span>
        <span class="t">${esc(c.t || 'Untitled video')}</span><span class="n">${c.s.length} chords</span></div>`;
    }).join('');
  });
}
$('songs').addEventListener('click', (e) => {
  const s = e.target.closest('.song');
  if (s) openTab('https://www.youtube.com/watch?v=' + encodeURIComponent(s.dataset.vid));
});
$('clearAll').addEventListener('click', () => {
  if (!confirm('Delete every saved chord chart?')) return;
  chrome.storage.local.get(null, (all) => {
    chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('chart:')), () => { loadCharts(); toast('All charts cleared'); });
  });
});

// ---------- current tab ----------
function ctxNotYouTube(onYouTube) {
  $('ctx').innerHTML = `<p>${onYouTube
    ? 'Open a song on YouTube and SOP will read its chords right beside the video.'
    : 'SOP reads chords off a YouTube video, so it has nothing to show on this page.'}</p>
    <button class="btn" id="goYT">Go to YouTube</button>`;
  $('goYT').onclick = () => openTab('https://www.youtube.com/');
}

function loadContext() {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    const url = tab && tab.url ? new URL(tab.url) : null;
    const onYT = !!url && /(^|\.)youtube\.com$/.test(url.hostname);
    const isVideo = onYT && (url.pathname === '/watch' || url.pathname.startsWith('/shorts/'));
    if (!isVideo) return ctxNotYouTube(onYT);

    const ask = (retry) => chrome.tabs.sendMessage(tab.id, { type: 'sop:status' }, (st) => {
      if (chrome.runtime.lastError || !st) {
        if (retry) {
          // Tab was open before SOP was installed/updated: load SOP into it now.
          chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['sop-core.js', 'content.js'] }, () => {
            if (chrome.runtime.lastError) return showReload();
            setTimeout(() => ask(false), 400);
          });
          return;
        }
        return showReload();
      }
      const pills = [];
      if (st.chord) pills.push(`Now <b>${esc(st.chord)}</b>`);
      if (st.key) pills.push(`Key <b>${esc(st.key)}</b>`);
      if (st.capo) pills.push(esc(st.capo));
      pills.push(`<b>${st.chords}</b> chords`);
      $('ctx').innerHTML = `<div class="title">${st.started ? '<span class="live"></span>' : ''}${esc(st.title || 'This video')}</div>
        <div class="info">${pills.map((p) => `<span class="pill">${p}</span>`).join('')}</div>
        <button class="btn primary" id="show">${st.started ? 'Show SOP panel' : prefs.enabled ? 'Open SOP panel' : 'Turn on SOP for this video'}</button>`;
      $('show').onclick = () => {
        if (!prefs.enabled) { prefs.enabled = true; savePrefs(); renderPrefs(); }
        chrome.tabs.sendMessage(tab.id, { type: 'sop:show' }, () => window.close());
      };
    });
    const showReload = () => {
      $('ctx').innerHTML = `<p>Reload this YouTube tab once so SOP can start working on it.</p>
        <button class="btn" id="reload">Reload tab</button>`;
      $('reload').onclick = () => { chrome.tabs.reload(tab.id); window.close(); };
    };
    ask(true);
  });
}

// ---------- links ----------
$('lGit').onclick = () => openTab(REPO);
$('lHelp').onclick = () => openTab(REPO + '#readme');
$('lShare').onclick = async () => {
  try { await navigator.clipboard.writeText(`SOP — live chords for any YouTube song: ${REPO}`); toast('Link copied — share it with your team'); }
  catch { openTab(REPO); }
};
$('feedback').onclick = (e) => { e.preventDefault(); openTab(REPO + '/issues/new'); };
$('ver').textContent = 'v' + chrome.runtime.getManifest().version;

chrome.storage.sync.get('sopPrefs', (d) => {
  prefs = Object.assign({}, defaults, d.sopPrefs || {});
  renderPrefs(); loadCharts(); loadContext();
});
