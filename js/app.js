import { Calculator, webUsbAvailable, getKnownCalculators, requestCalculator } from './usb/calculator.js';
import { NwaApp, wasmReady, regionFromInfos } from './nwa/linker.js';
import { installApps } from './nwa/installer.js';
import { loadWasm, importWasmFile } from './wasm-loader.js';
import { loadCatalog, clearStored, getAssetBytes, isStored, removeStored, pruneStored, fmtSize } from './catalog.js';

const $ = (id) => document.getElementById(id);
const BIG = 1048576;
const SEL_KEY = 'numflash.selected.v1';
const SET_KEY = 'numflash.settings.v1';
const META_KEY = 'numflash.meta.v1';      // { "<tag>/<file>:<size>": { name, icon } }

const settings = (() => { try { return { showAll: false, ...JSON.parse(localStorage.getItem(SET_KEY) || '{}') }; } catch { return { showAll: false }; } })();
const saveSettings = () => { try { localStorage.setItem(SET_KEY, JSON.stringify(settings)); } catch { /* ignore */ } };
let meta = {};
try { meta = JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch { /* ignore */ }
const metaKey = (a) => `${S.cat ? S.cat.tag : ''}/${a.name}:${a.size}`;
const metaOf = (it) => (it.kind === 'asset' ? meta[metaKey(it.asset)] : it.meta) || null;

// Keep the main list intentional. Everything else remains available through Settings.
const DEFAULT_APPS = [
  /(^|[^a-z])(en|eng|english)([^a-z]|$)/i,
  /(^|[^a-z])(fr|fra|french|fran[cç]ais)([^a-z]|$)/i,
  /matri/i,
  /invisi/i,
  /numpower/i,
  /hidden/i,
  /peanutgb/i,
  /nofrendo/i,
];
function kindOf(a) {
  if (DEFAULT_APPS.some((re) => re.test(a.name))) return /numplay/i.test(a.name) ? 'launcher' : 'featured';
  return 'other';
}

const S = {
  calc: null, cat: null, filter: 'all',
  queue: [],            // items, in install order
  own: [],              // items picked from this device
  stored: new Set(),    // asset names kept offline
  busy: false,
};

// ---- tiny helpers ------------------------------------------------------------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
}
const logLines = [];
function log(msg) {
  const line = new Date().toISOString().slice(11, 19) + '  ' + msg;
  logLines.push(line);
  $('log').textContent = logLines.join('\n');
  $('log').scrollTop = 1e9;
}
const errText = (e) => (typeof e === 'string' ? e : (e && e.message) || String(e));
const copy = async (text) => { try { await navigator.clipboard.writeText(text); } catch { /* ignore */ } };
const stripExt = (n) => n.replace(/\.nwa$/i, '');
const itemSize = (it) => it.app && it.app.size ? it.app.size : (it.kind === 'asset' ? it.asset.size : it.bytes.length);

// ---- calculator connection ---------------------------------------------------
function setPill(state, text) {
  const p = $('connect');
  p.className = 'pill ' + state;
  $('connectLabel').textContent = text;
}

async function readCalc(interactive = true) {
  const calc = S.calc;
  setPill('busy', 'Reading…');
  try {
    calc.infos = false;
    await calc.process((c) => c.extractInfos());
    const i = calc.infos;
    const fw = i.firmware;
    log(`Connected: ${i.model.displayed_name || i.model.name}, Epsilon ${fw.version}, serial ${i.displayedSerialNumber}`);
    $('calcCard').hidden = false;
    $('calcName').textContent = 'NumWorks ' + (i.model.displayed_name || i.model.name);
    $('calcSub').textContent = `Software ${fw.version}${fw.patch && fw.patch !== '0000000' ? ' (' + fw.patch + ')' : ''}`;
    $('calcInfo').textContent = JSON.stringify({
      model: i.model.name, serial: i.displayedSerialNumber, firmware: fw,
      layout: i.memoryLayout.map((l) => `${l.name} 0x${l.address.toString(16)} ${l.nbPage}x${l.pageSize}`),
    }, (k, v) => (typeof v === 'number' && v > 0xffff ? '0x' + v.toString(16) : v), 2);
    setPill('on', (i.model.displayed_name || i.model.name) + ' connected');
    try {
      const r = regionFromInfos(i);
      $('spaceText').textContent = `Extra-apps space: ${fmtSize(r.flashLength)}`;
    } catch (e) {
      $('spaceText').textContent = errText(e);
    }
    updateQueueBar();
  } catch (e) {
    S.calc = null;
    setPill('', 'Connect');
    $('calcCard').hidden = true;
    log('Connect failed: ' + errText(e));
    if (interactive) alert('Could not read the calculator.\n\n' + errText(e));
  }
}

async function connect(interactive) {
  if (!webUsbAvailable()) return false;
  try {
    let calc = (await getKnownCalculators())[0];
    if (!calc && interactive) calc = await requestCalculator();
    if (!calc) return false;
    S.calc = calc;
    await readCalc(interactive);
    return !!S.calc;
  } catch (e) {
    log('Connect: ' + errText(e));
    if (interactive && !/selection failure.*(NotFound|No device selected)/i.test(errText(e))) alert(errText(e));
    return false;
  }
}

// ---- catalog list -------------------------------------------------------------
const keyOfAsset = (a) => 'asset:' + a.name;

function itemFor(kind, data) {
  return kind === 'asset'
    ? { key: keyOfAsset(data), kind, label: stripExt(data.name), asset: data, state: 'idle' }
    : { key: 'file:' + data.name + ':' + data.bytes.length, kind, label: stripExt(data.name), bytes: data.bytes, state: 'idle' };
}
const inQueue = (key) => S.queue.some((q) => q.key === key);

function toggle(it) {
  const i = S.queue.findIndex((q) => q.key === it.key);
  if (i >= 0) S.queue.splice(i, 1); else S.queue.push(it);
  persistSelection();
  renderLists(); updateQueueBar();
}
function persistSelection() {
  try { localStorage.setItem(SEL_KEY, JSON.stringify(S.queue.filter((q) => q.kind === 'asset').map((q) => q.asset.name))); } catch { /* ignore */ }
}

function card(it, size) {
  const sel = inQueue(it.key);
  const queued = S.queue.find((q) => q.key === it.key);
  const m = metaOf(it);
  const iconUrl = (queued && queued.app && queued.app.iconUrl) || (m && m.icon);
  const icon = iconUrl
    ? h('img', { class: 'ico', src: iconUrl, alt: '' })
    : h('div', { class: 'ico' }, (it.label[0] || '?').toUpperCase());
  const stored = it.kind === 'asset' && S.stored.has(it.asset.name);
  return h('li', { class: 'item' + (sel ? ' sel' : '') },
    icon,
    h('div', {},
      h('div', { class: 'name' }, (queued && queued.app && queued.app.name) || (m && m.name) || it.label),
      h('div', { class: 'meta' }, fmtSize(size), stored ? h('span', { class: 'badge ok' }, 'offline') : null,
        it.kind === 'file' ? h('span', { class: 'badge' }, 'this device') : null)),
    h('button', { class: 'btn small ' + (sel ? 'ghost' : 'primary') + ' act', type: 'button', onclick: () => toggle(it) }, sel ? 'Remove' : 'Add'));
}

function renderLists() {
  const list = $('list');
  list.textContent = '';
  if (!S.cat) return;
  const kinds = S.cat.assets.map(kindOf);
  const nothingKnown = !kinds.some((k) => k !== 'other');
  const showAll = settings.showAll || nothingKnown;
  $('chips').hidden = !showAll;
  const byName = (a, b) => a.name.localeCompare(b.name);
  const add = (a) => list.append(card(S.queue.find((q) => q.key === keyOfAsset(a)) || itemFor('asset', a), a.size));
  if (showAll) {
    S.cat.assets.filter((a) => S.filter === 'all' || (S.filter === 'big' ? a.size >= BIG : a.size < BIG))
      .sort((a, b) => (/numplay/i.test(b.name) - /numplay/i.test(a.name)) || b.size - a.size).forEach(add);
    if (nothingKnown) list.append(h('li', { class: 'muted small' }, "I couldn't recognise the launcher names, so everything is shown."));
  } else {
    const groups = [['NumPlay launchers', 'launcher'], ['Featured apps', 'featured']];
    for (const [title, kind] of groups) {
      const items = S.cat.assets.filter((a) => kindOf(a) === kind).sort(byName);
      if (!items.length) continue;
      list.append(h('li', { class: 'group' }, title));
      items.forEach(add);
    }
    const hidden = S.cat.assets.length - S.cat.assets.filter((a) => kindOf(a) !== 'other').length;
    if (hidden) list.append(h('li', { class: 'muted small' }, `${hidden} more file${hidden > 1 ? 's' : ''} hidden – see Settings.`));
  }
  const mine = $('mineList');
  mine.textContent = '';
  for (const it of S.own) mine.append(card(S.queue.find((q) => q.key === it.key) || it, it.bytes.length));
}

// ---- names & icons (read from the .nwa itself, no linking needed) ------------------
async function extractMeta(bytes) {
  const app = new NwaApp(bytes);
  const out = {};
  try { out.name = await app.loadName(); } catch { /* ignore */ }
  try { out.icon = await app.loadIcon(); } catch { /* ignore */ }
  return out;
}
function rememberMeta(asset, m) {
  if (!m.icon && !m.name) return;
  meta[metaKey(asset)] = m;
  try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch { /* full */ }
}
let metaRunning = false;
/** Fill in icons for every file we already have on this device (runs in the background). */
async function fillMissingMeta() {
  if (metaRunning || !S.cat || !wasmReady()) return;
  metaRunning = true;
  try {
    for (const a of S.cat.assets) {
      if (meta[metaKey(a)] || !S.stored.has(a.name)) continue;
      const bytes = await getAssetBytes(S.cat, a, { keep: false });
      rememberMeta(a, await extractMeta(bytes));
      renderLists();
      await new Promise((r) => setTimeout(r, 30));
    }
  } catch (e) { log('Icons: ' + errText(e)); } finally { metaRunning = false; }
}

async function refreshStored() {
  if (!S.cat) return;
  S.stored = new Set();
  for (const a of S.cat.assets) if (await isStored(S.cat, a)) S.stored.add(a.name);
  renderLists();
  fillMissingMeta();
}

async function loadLibrary() {
  $('list').replaceChildren(h('li', { class: 'muted' }, 'Loading…'));
  try {
    S.cat = await loadCatalog();
    $('relTag').textContent = S.cat.tag;
    const when = S.cat.published ? new Date(S.cat.published).toLocaleDateString() : '';
    $('relNote').textContent = (S.cat.offline ? 'Offline – showing the last list I saw. ' : '') + (when ? 'Released ' + when + '. ' : '') + `${S.cat.assets.length} apps.`;
    await pruneStored(S.cat);
    const wanted = new Set(JSON.parse(localStorage.getItem(SEL_KEY) || '[]'));
    S.queue = S.queue.filter((q) => q.kind === 'file');
    for (const a of S.cat.assets) if (wanted.has(a.name)) S.queue.push(itemFor('asset', a));
    await refreshStored();
    updateQueueBar();
  } catch (e) {
    $('list').replaceChildren(h('li', { class: 'card warn' }, 'Could not load the NumPlay releases: ' + errText(e) + '. You can still add .nwa files from your device below.'));
  }
}

async function saveAllOffline() {
  if (!S.cat) return;
  const btn = $('saveAll');
  btn.disabled = true;
  const wanted = S.cat.assets.filter((a) => settings.showAll || kindOf(a) !== 'other');
  const todo = wanted.filter((a) => !S.stored.has(a.name));
  let n = 0;
  try {
    for (const a of todo) {
      btn.textContent = `Saving ${++n}/${todo.length}…`;
      await getAssetBytes(S.cat, a, { onProgress: (p) => { btn.textContent = `Saving ${n}/${todo.length} – ${Math.round(p * 100)}%`; } });
      S.stored.add(a.name);
      fillMissingMeta();
    }
    btn.textContent = 'Saved offline ✓';
  } catch (e) {
    btn.textContent = 'Save all offline';
    alert('Saving stopped: ' + errText(e));
  } finally {
    btn.disabled = false;
    setTimeout(() => { btn.textContent = 'Save all offline'; }, 2500);
    renderLists();
  }
}

// ---- queue bar & review sheet ----------------------------------------------------
function updateQueueBar() {
  const n = S.queue.length;
  $('queueBar').hidden = n === 0;
  $('qCount').textContent = n + (n === 1 ? ' app' : ' apps');
  const total = S.queue.reduce((s, q) => s + itemSize(q), 0);
  $('qSize').textContent = '≈ ' + fmtSize(total);
}

function capacity() {
  try { return S.calc && S.calc.infos ? regionFromInfos(S.calc.infos).flashLength : null; } catch { return null; }
}

function renderSheet() {
  const ul = $('qList');
  ul.textContent = '';
  for (const it of S.queue) {
    const size = itemSize(it);
    const status = it.state === 'loading' ? h('span', { class: 'badge' }, it.note || 'Preparing…')
      : it.state === 'error' ? h('span', { class: 'badge bad' }, 'Error')
      : it.app && it.app.needsExternalData ? h('span', { class: 'badge bad' }, 'Needs data file')
      : it.state === 'ready' ? h('span', { class: 'badge ok' }, 'Ready') : h('span', { class: 'badge' }, 'Waiting');
    const icon = it.app && it.app.iconUrl ? h('img', { class: 'ico', src: it.app.iconUrl, alt: '' }) : h('div', { class: 'ico' }, (it.label[0] || '?').toUpperCase());
    const extra = [];
    if (it.state === 'error') extra.push(h('div', { class: 'small', style: 'color:var(--bad);overflow-wrap:anywhere' }, it.error));
    if (it.app && it.app.needsExternalData) {
      extra.push(h('label', { class: 'btn ghost small' }, 'Choose data file',
        h('input', { type: 'file', hidden: true, onchange: async (e) => {
          const f = e.target.files[0]; if (!f) return;
          it.note = 'Linking…'; renderSheet();
          try { await it.app.setExternalData(new Uint8Array(await f.arrayBuffer())); } catch (err) { it.state = 'error'; it.error = errText(err); }
          renderSheet(); refreshButtons();
        } })));
    }
    ul.append(h('li', { class: 'item' }, icon,
      h('div', {}, h('div', { class: 'name' }, (it.app && it.app.name) || it.label),
        h('div', { class: 'meta' }, size ? fmtSize(size) : '', status), ...extra),
      h('button', { class: 'btn small ghost act', type: 'button', disabled: S.busy, onclick: () => { toggle(it); if (!S.queue.length) $('sheet').close(); else renderSheet(); refreshButtons(); } }, 'Remove')));
  }
  const cap = capacity();
  const total = S.queue.reduce((s, q) => s + (q.app && q.app.size ? q.app.size : 0), 0);
  const bar = $('qBar');
  bar.style.width = cap ? Math.min(100, (total / cap) * 100) + '%' : '0';
  bar.className = cap && total > cap ? 'over' : '';
  $('qSpace').textContent = cap ? `${fmtSize(total)} of ${fmtSize(cap)} used` : 'Connect your calculator to see free space.';
}

function refreshButtons() {
  const cap = capacity();
  const total = S.queue.reduce((s, q) => s + (q.app && q.app.size ? q.app.size : 0), 0);
  const ok = !S.busy && S.calc && cap && S.queue.length > 0 && S.queue.every((q) => q.state === 'ready' && q.app && !q.app.needsExternalData) && total <= cap;
  $('install').disabled = !ok;
  $('dry').disabled = !ok;
}

async function prepare(it) {
  if (it.state === 'ready') return;
  it.state = 'loading'; it.error = ''; renderSheet();
  try {
    let bytes = it.bytes;
    if (!bytes) {
      it.note = 'Downloading…'; renderSheet();
      bytes = await getAssetBytes(S.cat, it.asset, { onProgress: (p) => { const n = `Downloading ${Math.round(p * 100)}%`; if (n !== it.note) { it.note = n; renderSheet(); } } });
      S.stored.add(it.asset.name);
    }
    it.note = 'Linking…'; renderSheet();
    const app = new NwaApp(bytes, it.label);
    await app.load();
    it.app = app;
    if (it.kind === 'asset') rememberMeta(it.asset, { name: app.name, icon: app.iconUrl });
    it.state = 'ready';
    log(`Prepared ${app.name || it.label}: ${app.needsExternalData ? 'needs external data' : fmtSize(app.size)}`);
  } catch (e) {
    it.state = 'error'; it.error = errText(e);
    log(`Could not prepare ${it.label}: ${errText(e)}`);
  }
  renderSheet();
}

async function openSheet() {
  if (!wasmReady()) { alert('The linker tools (ld.wasm / objcopy.wasm) are missing – see the setup box at the top.'); window.scrollTo(0, 0); return; }
  $('result').hidden = true; $('progress').hidden = true;
  $('sheet').showModal();
  renderSheet(); refreshButtons();
  if (!S.calc) { await connect(true); renderSheet(); }
  S.busy = true; refreshButtons();
  for (const it of [...S.queue]) { await prepare(it); renderSheet(); }
  S.busy = false;
  renderLists(); updateQueueBar(); renderSheet(); refreshButtons();
}

async function runInstall(dryRun) {
  if (!dryRun && !confirm('This replaces every app currently in the calculator\'s extra-apps area with the ones in this list. Continue?')) return;
  S.busy = true; refreshButtons();
  $('progress').hidden = false; $('result').hidden = true; $('pBar').style.width = '0';
  const apps = S.queue.map((q) => q.app);
  const t0 = performance.now();
  try {
    const res = await installApps(S.calc, apps, {
      dryRun,
      onStage: (t) => { $('stage').textContent = t; log(t); },
      onProgress: (p) => { $('pBar').style.width = (p * 100).toFixed(1) + '%'; $('stage').textContent = `Writing… ${Math.round(p * 100)}%`; },
    });
    const secs = ((performance.now() - t0) / 1000).toFixed(0);
    $('pBar').style.width = '100%';
    if (dryRun) {
      $('stage').textContent = 'Dry run done.';
      showResult(true, `Linked OK: ${fmtSize(res.image.length)} would be written at 0x${res.region.flashStart.toString(16)}. Nothing was changed on the calculator.`);
      log(`Dry run OK, image ${res.image.length} bytes`);
    } else {
      $('stage').textContent = 'Done.';
      showResult(true, `Installed ${apps.length} app${apps.length > 1 ? 's' : ''} in ${secs}s. The calculator is restarting – open the Apps screen to find them.`);
      log(`Installed OK in ${secs}s`);
      S.calc = new Calculator(S.calc.device);        // old session is gone after the restart
      setTimeout(async () => { S.calc = null; $('calcCard').hidden = true; setPill('', 'Connect'); await connect(false); }, 4000);
    }
  } catch (e) {
    showResult(false, errText(e));
    log('FAILED: ' + errText(e) + (e && e.stack ? '\n' + e.stack : ''));
  } finally {
    S.busy = false; refreshButtons();
  }
}
function showResult(ok, text) {
  const r = $('result');
  r.hidden = false; r.className = 'result ' + (ok ? 'ok' : 'bad'); r.textContent = (ok ? '✓ ' : '✗ ') + text;
}
function closeOnBackdrop(dialog, canClose = () => true) {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog && canClose()) dialog.close();
  });
}

// ---- wiring --------------------------------------------------------------------------
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  if (!webUsbAvailable()) $('noUsb').hidden = false;

  $('connect').addEventListener('click', () => { if (!S.busy) connect(true); });
  $('refreshCalc').addEventListener('click', () => S.calc && readCalc());
  $('copyInfo').addEventListener('click', () => copy($('calcInfo').textContent));
  $('copyLog').addEventListener('click', () => copy($('log').textContent));
  $('reload').addEventListener('click', loadLibrary);
  $('optAll').checked = settings.showAll;
  $('openSettings').addEventListener('click', () => $('settings').showModal());
  $('closeSettings').addEventListener('click', () => $('settings').close());
  closeOnBackdrop($('settings'));
  $('optAll').addEventListener('change', (e) => { settings.showAll = e.target.checked; saveSettings(); renderLists(); });
  $('clearStore').addEventListener('click', async () => {
    if (!confirm('Remove all saved .nwa files and icons from this device?')) return;
    await clearStored(); meta = {}; localStorage.removeItem(META_KEY); S.stored = new Set(); renderLists();
  });
  $('saveAll').addEventListener('click', saveAllOffline);
  $('review').addEventListener('click', openSheet);
  $('closeSheet').addEventListener('click', () => { if (!S.busy) $('sheet').close(); });
  closeOnBackdrop($('sheet'), () => !S.busy);
  $('install').addEventListener('click', () => runInstall(false));
  $('dry').addEventListener('click', () => runInstall(true));
  document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
    S.filter = c.dataset.filter;
    document.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
    renderLists();
  }));
  $('pickNwa').addEventListener('change', async (e) => {
    for (const f of e.target.files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const it = itemFor('file', { name: f.name, bytes });
      if (!S.own.some((o) => o.key === it.key)) { S.own.push(it); if (wasmReady()) extractMeta(bytes).then((m) => { it.meta = m; renderLists(); }); }
    }
    e.target.value = '';
    renderLists();
  });
  $('wasmFiles').addEventListener('change', async (e) => {
    const msgs = [];
    for (const f of e.target.files) { try { msgs.push('Saved ' + await importWasmFile(f) + '.wasm'); } catch (err) { msgs.push(errText(err)); } }
    $('setupMsg').textContent = msgs.join(' · ');
    if (wasmReady()) $('setup').hidden = true;
  });

  if (navigator.usb) {
    navigator.usb.addEventListener('connect', () => { if (!S.calc && !S.busy) connect(false); });
    navigator.usb.addEventListener('disconnect', () => {
      if (S.busy) return;
      S.calc = null; $('calcCard').hidden = true; setPill('', 'Connect'); log('Calculator unplugged');
    });
  }

  const missing = await loadWasm();
  if (missing.length) { $('missingList').textContent = missing.map((m) => m + '.wasm').join(' and '); $('setup').hidden = false; }

  await loadLibrary();
  fillMissingMeta();
  connect(false);
}
boot();
