const defaults = { enabled: true, accidentals: 'auto', minimized: false, pos: null, diagrams: true };
const $ = (id) => document.getElementById(id);

chrome.storage.sync.get('sopPrefs', (d) => {
  const prefs = Object.assign({}, defaults, d.sopPrefs || {});
  $('enabled').checked = prefs.enabled;
  $('diagrams').checked = prefs.diagrams;
  $('acc').value = prefs.accidentals;
  const save = () => {
    prefs.enabled = $('enabled').checked;
    prefs.diagrams = $('diagrams').checked;
    prefs.accidentals = $('acc').value;
    chrome.storage.sync.set({ sopPrefs: prefs });
  };
  ['enabled', 'diagrams', 'acc'].forEach((id) => $(id).addEventListener('change', save));
});

chrome.storage.local.get(null, (all) => {
  const keys = Object.keys(all).filter((k) => k.startsWith('chart:'));
  if (!keys.length) return;
  const box = $('charts');
  box.textContent = `Saved chord charts: ${keys.length} song${keys.length > 1 ? 's' : ''} `;
  const btn = document.createElement('button');
  btn.textContent = 'Clear all';
  btn.onclick = () => {
    if (!confirm('Delete every saved chord chart?')) return;
    chrome.storage.local.remove(keys, () => { box.textContent = 'All charts cleared.'; });
  };
  box.appendChild(btn);
});
