import { Calculator, webUsbAvailable, getKnownCalculators, requestCalculator } from './usb/calculator.js';
import { readStorageRecords, writeStorageRecords, mergeRecords } from './usb/storage.js';
import { NwaApp, wasmReady, regionFromInfos } from './nwa/linker.js';
import { installApps } from './nwa/installer.js';
import { loadWasm, importWasmFile } from './wasm-loader.js';
import { loadCatalog, clearStored, getAssetBytes, isStored, pruneStored, fmtSize } from './catalog.js';
import { BIG_BYTES, TAGLINES, VARIANT_INFO, isNumPlayVariant, roleOf, homeBig, saveInfo } from './apps-meta.js';
import * as saves from './saves.js';

const $ = (id) => document.getElementById(id);
const SEL_KEY = 'numflash.selection.v2';
const SET_KEY = 'numflash.settings.v1';
const META_KEY = 'numflash.meta.v1';      // icons/names read from files that are not in data/apps.json

const settings = (() => { const d = { backup: true }; try { return { ...d, ...JSON.parse(localStorage.getItem(SET_KEY) || '{}') }; } catch { return d; } })();
const saveSettings = () => { try { localStorage.setItem(SET_KEY, JSON.stringify(settings)); } catch { /* ignore */ } };
let meta = {};
try { meta = JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch { /* ignore */ }

const S = {
  calc: null, cat: null,
  apps: {},               // data/apps.json: real name + icon of every NumPlay file, read at build time
  big: null,              // the one big app that goes on the calculator
  smalls: [],             // small apps installed next to it
  own: [],                // files picked from this device
  stored: new Set(),      // asset names kept offline
  installed: null,        // names of the apps on the calculator right now (null = unknown)
  doneSig: '',            // queue that was installed last
  dismissed: new Set(),   // restore offers the person said "not now" to
  openInfo: new Set(),
  busy: false,
};

// ---- helpers -------------------------------------------------------------------------------------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
}
const logLines = [];
function log(msg) {
  logLines.push(new Date().toISOString().slice(11, 19) + '  ' + msg);
  $('log').textContent = logLines.join('\n');
  $('log').scrollTop = 1e9;
}
const errText = (e) => (typeof e === 'string' ? e : (e && e.message) || String(e));
const copy = async (text) => { try { await navigator.clipboard.writeText(text); } catch { /* ignore */ } };
const stripExt = (n) => n.replace(/\.nwa$/i, '');
const fmtDate = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
let toastTimer;
function toast(text, bad = false) {
  const t = $('toast');
  t.textContent = text; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}
function closeOnBackdrop(dialog, canClose = () => true) {
  dialog.addEventListener('click', (e) => { if (e.target === dialog && canClose()) dialog.close(); });
}

// ---- names, icons, sizes -----------------------------------------------------------------------------
const metaKey = (a) => `${S.cat ? S.cat.tag : ''}/${a.name}:${a.size}`;
const queue = () => [S.big, ...S.smalls].filter(Boolean);
const itemSize = (it) => it.app && it.app.size ? it.app.size : (it.kind === 'asset' ? it.asset.size : it.bytes.length);
const roleOfItem = (it) => (it.kind === 'asset' ? roleOf(it.asset) : (it.bytes.length >= BIG_BYTES ? 'big' : 'small'));
const fileName = (it) => (it.kind === 'asset' ? it.asset.name : it.label + '.nwa');

/** { name, icon } for an item: what we linked now, else what we read from the file, else the build-time data. */
function look(it) {
  const pre = it.kind === 'asset' ? S.apps[it.asset.name] : null;
  const m = (it.kind === 'asset' ? meta[metaKey(it.asset)] : it.meta) || null;
  return {
    name: (it.app && it.app.name) || (m && m.name) || (pre && pre.name) || '',
    icon: (it.app && it.app.iconUrl) || (m && m.icon) || (pre && pre.icon) || '',
  };
}
function titleOf(it) {
  const f = fileName(it);
  if (isNumPlayVariant(f)) return stripExt(f).replace(/-/g, ' ');          // "NumPlay Matrices"
  return look(it).name.trim() || it.label;
}
function iconEl(it, cls = 'ico') {
  const { icon } = look(it);
  return icon ? h('img', { class: cls, src: icon, alt: '', width: 52, height: 52 }) : h('div', { class: cls }, (titleOf(it)[0] || '?').toUpperCase());
}

/** Asset names that are on the calculator now, matched by the name each app shows there. */
function onCalcSet() {
  const out = new Set();
  if (!S.installed || !S.cat) return out;
  for (const name of S.installed.map((a) => a.name.trim())) {
    const cands = S.cat.assets.filter((a) => S.apps[a.name] && S.apps[a.name].name.trim() === name);
    if (cands.length === 1) out.add(cands[0].name);
    else if (cands.length > 1) { const base = cands.find((a) => a.name === 'NumPlay.nwa'); if (base) out.add(base.name); }
  }
  return out;
}
function queueMatchesCalc() {
  if (!S.installed || !S.big) return false;
  const want = queue().map((q) => look(q).name.trim()).sort().join('|');
  return want === S.installed.map((a) => a.name.trim()).sort().join('|');
}
const queueSig = () => queue().map((q) => q.key).join('|');

// ---- calculator connection -----------------------------------------------------------------------------
const calcLabel = (infos) => (infos.model.displayed_name || infos.model.name) + ' · …' + saves.lastFour(infos.displayedSerialNumber);

function setPill(state, text) {
  $('connect').className = 'pill ' + state;
  $('connectLabel').textContent = text;
}

function renderCalc() {
  const calc = S.calc, i = calc && calc.infos;
  $('connectBig').hidden = !!i;
  $('refreshCalc').hidden = !i;
  $('calcDetails').hidden = !i;
  $('spaceBox').hidden = !i;
  if (!i) {
    $('calcName').textContent = 'No calculator connected';
    $('calcSub').textContent = 'Plug it in, turn it on, then tap Connect.';
    $('nowOn').hidden = true;
    return;
  }
  const fw = i.firmware;
  $('calcName').textContent = 'NumWorks ' + calcLabel(i);
  $('calcSub').textContent = `Software ${fw.version}${fw.patch && fw.patch !== '0000000' ? ' (' + fw.patch + ')' : ''}`;
  const now = $('nowOn');
  if (S.installed) {
    const on = onCalcSet();
    const names = S.installed.map((a) => {
      const hit = S.cat && S.cat.assets.find((x) => on.has(x.name) && S.apps[x.name] && S.apps[x.name].name.trim() === a.name.trim());
      return hit ? titleOf(itemFor('asset', hit)) : (a.name.trim() || 'a hidden app');
    });
    now.replaceChildren('On it now: ', h('b', {}, names.length ? names.join(', ') : 'no extra apps'));
    now.hidden = false;
  } else now.hidden = true;
  try {
    const r = regionFromInfos(i);
    $('spaceText').textContent = `Extra-apps space: ${fmtSize(r.flashLength)}`;
  } catch (e) { $('spaceText').textContent = errText(e); }
}

async function readCalc(interactive = true) {
  const calc = S.calc;
  setPill('busy', 'Reading…');
  try {
    calc.infos = false;
    S.installed = null;
    await calc.process(async (c) => {
      await c.extractInfos();
      try { S.installed = await c.readInstalledApps(); } catch (e) { log('Could not list installed apps: ' + errText(e)); S.installed = null; }
    });
    const i = calc.infos, fw = i.firmware;
    log(`Connected: ${calcLabel(i)}, Epsilon ${fw.version}${S.installed ? ', installed: ' + (S.installed.map((a) => JSON.stringify(a.name)).join(', ') || 'none') : ''}`);
    $('calcInfo').textContent = JSON.stringify({
      model: i.model.name, serial: i.displayedSerialNumber, firmware: fw,
      installed: S.installed,
      layout: i.memoryLayout.map((l) => `${l.name} 0x${l.address.toString(16)} ${l.nbPage}x${l.pageSize}`),
    }, (k, v) => (typeof v === 'number' && v > 0xffff ? '0x' + v.toString(16) : v), 2);
    setPill('on', calcLabel(i));
    renderCalc(); renderLists(); updateQueueBar();
    if (!S.busy) await syncSaves(true);
  } catch (e) {
    S.calc = null;
    setPill('', 'Connect');
    renderCalc();
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

// ---- saves: back up to this device, offer to restore -------------------------------------------------------
const serialOf = () => (S.calc && S.calc.infos ? S.calc.infos.displayedSerialNumber : null);

/** Read the calculator's scripts, remember new versions here, and offer to restore missing ones. */
async function syncSaves(offerRestore) {
  if (!S.calc || !S.calc.infos) return { ok: false, error: 'not connected' };
  const serial = serialOf(), model = S.calc.infos.model.displayed_name || S.calc.infos.model.name;
  try {
    const records = await readStorageRecords(S.calc);
    const changed = await saves.rememberRecords(serial, model, records);
    log(`Saves: ${records.length} record(s) on the calculator, ${changed.length} new backup(s)${changed.length ? ': ' + changed.join(', ') : ''}`);
    await renderSavesSummary();
    if (offerRestore) {
      const missing = (await saves.missingOnCalculator(serial, records)).filter((f) => !S.dismissed.has(serial + '|' + f.name));
      if (missing.length) showRestore(missing);
    }
    return { ok: true, records, changed };
  } catch (e) {
    log('Saves: ' + errText(e));
    return { ok: false, error: errText(e) };
  }
}

function saveRow(entry, versionIdx = 0) {
  const info = saveInfo(entry.name);
  const asset = info && S.cat && S.cat.assets.find((a) => a.name === info.asset);
  const pre = info && S.apps[info.asset];
  const icon = (asset && look(itemFor('asset', asset)).icon) || (pre && pre.icon) || '';
  return {
    title: info ? info.title : entry.name.replace(/\.py$/i, ''),
    sub: info ? entry.name : 'Python script',
    icon,
    version: entry.versions[versionIdx],
  };
}
const saveIcon = (icon, title, cls) => (icon ? h('img', { class: cls, src: icon, alt: '', width: 52, height: 52 }) : h('div', { class: cls }, 'py'));

function showRestore(missing) {
  const serial = serialOf();
  $('restoreWho').textContent = 'NUMWORKS ' + calcLabel(S.calc.infos).toUpperCase();
  $('restoreMsg').textContent = '';
  const list = $('restoreList');
  list.textContent = '';
  const boxes = [];
  for (const entry of missing) {
    const r = saveRow(entry);
    const box = h('input', { type: 'checkbox', checked: true });
    boxes.push({ box, entry });
    list.append(h('label', { class: 'pick' }, box, saveIcon(r.icon, r.title, 'ico'),
      h('div', {}, h('div', { class: 'name' }, r.title), h('div', { class: 'meta' }, `${r.sub} · ${fmtSize(r.version.bytes.length)} · backed up ${fmtDate(r.version.ts)}`))));
  }
  const dlg = $('restoreDlg');
  $('restoreNo').onclick = () => { for (const { entry } of boxes) S.dismissed.add(serial + '|' + entry.name); dlg.close(); };
  $('restoreGo').onclick = async () => {
    const chosen = boxes.filter((b) => b.box.checked).map((b) => b.entry);
    if (!chosen.length) { dlg.close(); return; }
    $('restoreGo').disabled = true; $('restoreMsg').textContent = 'Restoring…';
    try {
      const n = await restoreToCalc(chosen.map((e) => ({ name: e.name, bytes: e.versions[0].bytes })));
      dlg.close();
      toast(`Restored ${n} file${n > 1 ? 's' : ''} to the calculator.`);
    } catch (e) { $('restoreMsg').textContent = 'Could not restore: ' + errText(e); }
    $('restoreGo').disabled = false;
  };
  if (!dlg.open) dlg.showModal();
}

/** Put scripts back on the calculator (keeps everything else already there), then check they arrived. */
async function restoreToCalc(files) {
  if (!S.calc) throw new Error('The calculator is not connected');
  S.busy = true;
  try {
    const current = await readStorageRecords(S.calc);
    const merged = mergeRecords(current, files.map((f) => ({ name: f.name, value: f.bytes })));
    await writeStorageRecords(S.calc, merged);
    const after = await readStorageRecords(S.calc);
    const missing = files.filter((f) => !after.some((r) => r.name === f.name));
    if (missing.length) throw new Error('The calculator did not keep ' + missing.map((m) => m.name).join(', '));
    log('Restored ' + files.map((f) => f.name).join(', '));
    return files.length;
  } finally { S.busy = false; }
}

async function renderSavesSummary() {
  const serial = serialOf();
  const calcs = await saves.listCalculators();
  const files = serial ? await saves.listSaves(serial) : (calcs[0] ? await saves.listSaves(calcs[0].serial) : []);
  const who = serial ? calcLabel(S.calc.infos) : (calcs[0] ? calcs[0].model + ' · …' + saves.lastFour(calcs[0].serial) : '');
  $('savesSummary').textContent = files.length
    ? `${files.length} backed up for ${who}: ${files.map((f) => (saveInfo(f.name) || { title: f.name }).title).join(', ')}.`
    : 'Your game saves and Python scripts are copied to this device each time you connect, so a crash or reset can’t take them.';
}

async function openSaves() {
  const body = $('savesBody');
  body.textContent = '';
  const calcs = await saves.listCalculators();
  const connected = serialOf();
  if (!calcs.length) body.append(h('p', { class: 'muted' }, 'Nothing backed up yet. Connect your calculator and NumFlash copies your saves and scripts here.'));
  for (const c of calcs) {
    const files = await saves.listSaves(c.serial);
    const isNow = c.serial === connected;
    body.append(h('div', { class: 'calc-group' }, h('b', {}, `${c.model || 'Calculator'} · …${saves.lastFour(c.serial)}`),
      isNow ? h('span', { class: 'badge ok' }, 'connected') : h('span', { class: 'badge' }, 'last seen ' + fmtDate(c.lastSeen))));
    if (!files.length) body.append(h('p', { class: 'muted small' }, 'No saves or scripts backed up for this calculator.'));
    files.sort((a, b) => (!!saveInfo(b.name) - !!saveInfo(a.name)) || a.name.localeCompare(b.name));
    for (const f of files) {
      let idx = 0;
      const r0 = saveRow(f);
      const meta1 = h('div', { class: 'meta' });
      const setMeta = () => { const v = f.versions[idx]; meta1.textContent = `${r0.sub} · ${fmtSize(v.bytes.length)} · ${fmtDate(v.ts)}`; };
      setMeta();
      const acts = h('div', { class: 'acts' });
      if (f.versions.length > 1) {
        const sel = h('select', { 'aria-label': 'Version' }, f.versions.map((v, i) => h('option', { value: i }, (i === 0 ? 'Latest · ' : 'Older · ') + fmtDate(v.ts) + ' · ' + fmtSize(v.bytes.length))));
        sel.addEventListener('change', () => { idx = +sel.value; setMeta(); });
        acts.append(sel);
      }
      const restoreBtn = h('button', { class: 'btn small primary', type: 'button', disabled: !isNow || S.busy, title: isNow ? '' : 'Connect this calculator to restore', onclick: async (e) => {
        const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Restoring…';
        try { await restoreToCalc([{ name: f.name, bytes: f.versions[idx].bytes }]); toast('Restored ' + r0.title + '.'); }
        catch (err) { toast('Could not restore: ' + errText(err), true); }
        btn.textContent = 'Restore'; btn.disabled = false;
      } }, 'Restore');
      acts.append(
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => saves.exportFile(f.name, f.versions[idx].bytes) }, 'Export'),
        restoreBtn,
        h('button', { class: 'link danger', type: 'button', onclick: async () => {
          if (!confirm(`Delete the backup of ${r0.title} from this device?`)) return;
          await saves.forgetSave(c.serial, f.name); await openSaves(); renderSavesSummary();
        } }, 'Delete'));
      body.append(h('div', { class: 'file' }, saveIcon(r0.icon, r0.title, 'ico'), h('div', {}, h('div', { class: 'name' }, r0.title), meta1), acts));
    }
  }
  $('backupNow').disabled = !S.calc;
  if (!$('savesDlg').open) $('savesDlg').showModal();
}

// ---- library --------------------------------------------------------------------------------------------
const keyOfAsset = (a) => 'asset:' + a.name;
function itemFor(kind, data) {
  return kind === 'asset'
    ? { key: keyOfAsset(data), kind, label: stripExt(data.name), asset: data, state: 'idle' }
    : { key: 'file:' + data.name + ':' + data.bytes.length, kind, label: stripExt(data.name), bytes: data.bytes, state: 'idle' };
}
/** The queued copy of an item if there is one (it carries the linked app), else a fresh one. */
const live = (it) => queue().find((q) => q.key === it.key) || it;
const inQueue = (key) => queue().some((q) => q.key === key);

function persistSelection() {
  try {
    localStorage.setItem(SEL_KEY, JSON.stringify({
      big: S.big && S.big.kind === 'asset' ? S.big.asset.name : null,
      smalls: S.smalls.filter((q) => q.kind === 'asset').map((q) => q.asset.name),
    }));
  } catch { /* ignore */ }
}

function switchTo(it) {
  S.big = live(it);
  persistSelection(); renderLists(); updateQueueBar();
  openSheet();
}
function toggleSmall(it) {
  const i = S.smalls.findIndex((q) => q.key === it.key);
  if (i >= 0) S.smalls.splice(i, 1); else S.smalls.push(it);
  persistSelection(); renderLists(); updateQueueBar();
}
function removeFromQueue(it) {
  if (S.big && S.big.key === it.key) S.big = null;
  S.smalls = S.smalls.filter((q) => q.key !== it.key);
  persistSelection(); renderLists(); updateQueueBar();
}

function card(it0, { tagline = false } = {}) {
  const it = live(it0);
  const role = roleOfItem(it);
  const sel = inQueue(it.key);
  const onCalc = it.kind === 'asset' && onCalcSet().has(it.asset.name);
  const stored = it.kind === 'asset' && S.stored.has(it.asset.name);
  const file = fileName(it);
  const infoText = VARIANT_INFO[file];
  const open = S.openInfo.has(file);
  const size = it.kind === 'asset' ? it.asset.size : it.bytes.length;
  const tag = tagline && TAGLINES[file];

  const infoBtn = infoText ? h('button', { class: 'info', type: 'button', 'aria-expanded': open, 'aria-label': 'What is this?', onclick: () => {
    if (S.openInfo.has(file)) S.openInfo.delete(file); else S.openInfo.add(file);
    renderLists();
  } }, 'i') : null;

  let action;
  if (role === 'big') {
    action = h('button', { class: 'btn small act switch' + (onCalc ? ' again' : ''), type: 'button', onclick: () => switchTo(it) }, onCalc ? 'Reinstall' : 'Switch');
  } else {
    action = h('button', { class: 'btn small act ' + (sel ? 'ghost' : 'primary'), type: 'button', onclick: () => toggleSmall(it) }, sel ? 'Remove' : 'Add');
  }
  return h('li', { class: 'item' + (sel ? ' sel' : '') + (onCalc ? ' on-calc' : '') },
    iconEl(it),
    h('div', {},
      h('div', { class: 'name' }, titleOf(it)),
      tag ? h('div', { class: 'tagline' }, tag) : null,
      h('div', { class: 'meta' }, fmtSize(size),
        onCalc ? h('span', { class: 'badge ok' }, 'on calculator') : null,
        sel && role === 'big' ? h('span', { class: 'badge accent' }, 'selected') : null,
        stored ? h('span', { class: 'badge ok' }, 'offline') : null,
        it.kind === 'file' ? h('span', { class: 'badge' }, 'this device') : null,
        infoBtn)),
    action,
    infoText && open ? h('div', { class: 'note' }, infoText) : null);
}

function renderLists() {
  const list = $('list');
  list.textContent = '';
  for (const id of ['smallList', 'variantList', 'mineList']) $(id).textContent = '';
  if (!S.cat) return;
  const assets = S.cat.assets;
  const home = homeBig(assets);
  home.forEach((a) => list.append(card(itemFor('asset', a), { tagline: true })));
  if (!home.length) list.append(h('li', { class: 'muted small' }, 'No big apps found in this release. Use “More apps & versions”.'));

  const byName = (a, b) => a.name.localeCompare(b.name);
  assets.filter((a) => roleOf(a) === 'small').sort(byName).forEach((a) => $('smallList').append(card(itemFor('asset', a))));
  assets.filter((a) => isNumPlayVariant(a.name) && !home.includes(a)).sort(byName).forEach((a) => $('variantList').append(card(itemFor('asset', a))));
  for (const it of S.own) $('mineList').append(card(it));
}

// ---- names & icons for files that data/apps.json doesn't know (new releases, other sources) -------------------
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
async function fillMissingMeta() {
  if (metaRunning || !S.cat || !wasmReady()) return;
  metaRunning = true;
  try {
    for (const a of S.cat.assets) {
      if ((S.apps[a.name] && S.apps[a.name].icon) || meta[metaKey(a)] || !S.stored.has(a.name)) continue;
      rememberMeta(a, await extractMeta(await getAssetBytes(S.cat, a, { keep: false })));
      renderLists();
      await new Promise((r) => setTimeout(r, 30));
    }
  } catch (e) { log('Icons: ' + errText(e)); } finally { metaRunning = false; }
}

async function refreshStored() {
  if (!S.cat) return;
  S.stored = new Set();
  for (const a of S.cat.assets) if (await isStored(S.cat, a)) S.stored.add(a.name);
  renderLists(); renderOfflineNote();
  fillMissingMeta();
}
function renderOfflineNote() {
  if (!S.cat) return;
  const big = homeBig(S.cat.assets);
  const n = big.filter((a) => S.stored.has(a.name)).length;
  $('offlineNote').textContent = `${n} of ${big.length} saved`;
}

async function loadAppData() {
  try {
    const res = await fetch('data/apps.json');
    if (res.ok) S.apps = (await res.json()).apps || {};
  } catch { /* offline first run: icons fall back to what is read from files */ }
}

async function loadLibrary() {
  $('list').replaceChildren(h('li', { class: 'muted' }, 'Loading…'));
  try {
    S.cat = await loadCatalog();
    const when = S.cat.published ? new Date(S.cat.published).toLocaleDateString() : '';
    $('relNote').textContent = `NumPlay ${S.cat.tag}${when ? ', released ' + when : ''}${S.cat.offline ? ' (offline: last list I saw)' : ''}.`;
    await pruneStored(S.cat);
    // bring back the last selection
    let sel = {};
    try { sel = JSON.parse(localStorage.getItem(SEL_KEY) || '{}'); } catch { /* ignore */ }
    const find = (n) => S.cat.assets.find((a) => a.name === n);
    S.big = sel.big && find(sel.big) ? itemFor('asset', find(sel.big)) : null;
    S.smalls = (sel.smalls || []).filter(find).map((n) => itemFor('asset', find(n)));
    renderLists();
    await refreshStored();
    updateQueueBar();
  } catch (e) {
    $('list').replaceChildren(h('li', { class: 'card warn' }, 'Could not load the NumPlay releases: ' + errText(e) + '. You can still add .nwa files from your device under “More apps & versions”.'));
  }
}

async function saveAllOffline() {
  if (!S.cat) return;
  const btn = $('saveAll');
  btn.disabled = true;
  const todo = homeBig(S.cat.assets).filter((a) => !S.stored.has(a.name));
  let n = 0;
  try {
    for (const a of todo) {
      btn.textContent = `Saving ${++n}/${todo.length}…`;
      await getAssetBytes(S.cat, a, { onProgress: (p) => { btn.textContent = `Saving ${n}/${todo.length} – ${Math.round(p * 100)}%`; } });
      S.stored.add(a.name);
      renderLists(); renderOfflineNote();
    }
    btn.textContent = todo.length ? 'Saved offline ✓' : 'Already saved ✓';
  } catch (e) {
    btn.textContent = 'Save big apps offline';
    alert('Saving stopped: ' + errText(e));
  } finally {
    btn.disabled = false;
    setTimeout(() => { btn.textContent = 'Save big apps offline'; }, 2500);
    renderLists(); renderOfflineNote(); fillMissingMeta();
  }
}

// ---- queue bar & install sheet -----------------------------------------------------------------------------
function updateQueueBar() {
  const q = queue();
  const show = q.length > 0 && !queueMatchesCalc() && queueSig() !== S.doneSig;
  $('queueBar').hidden = !show;
  const smalls = S.smalls.length;
  $('qCount').textContent = S.big
    ? titleOf(S.big) + (smalls ? ` + ${smalls} small app${smalls > 1 ? 's' : ''}` : '')
    : `${smalls} small app${smalls === 1 ? '' : 's'}`;
  $('qSize').textContent = ' · ≈ ' + fmtSize(q.reduce((s, it) => s + itemSize(it), 0));
}

function capacity() {
  try { return S.calc && S.calc.infos ? regionFromInfos(S.calc.infos).flashLength : null; } catch { return null; }
}

function renderSheet() {
  const ul = $('qList');
  ul.textContent = '';
  for (const it of queue()) {
    const size = itemSize(it);
    const status = it.state === 'loading' ? h('span', { class: 'badge' }, it.note || 'Preparing…')
      : it.state === 'error' ? h('span', { class: 'badge bad' }, 'Error')
      : it.app && it.app.needsExternalData ? h('span', { class: 'badge bad' }, 'Needs data file')
      : it.state === 'ready' ? h('span', { class: 'badge ok' }, 'Ready') : h('span', { class: 'badge' }, 'Waiting');
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
    ul.append(h('li', { class: 'item' }, iconEl(it),
      h('div', {}, h('div', { class: 'name' }, titleOf(it)),
        h('div', { class: 'meta' }, size ? fmtSize(size) : '', roleOfItem(it) === 'big' ? h('span', { class: 'badge accent' }, 'main app') : null, status), ...extra),
      h('button', { class: 'btn small ghost act', type: 'button', disabled: S.busy, onclick: () => {
        removeFromQueue(it);
        if (!queue().length) $('sheet').close(); else renderSheet();
        refreshButtons();
      } }, 'Remove')));
  }
  const cap = capacity();
  const total = queue().reduce((s, q) => s + (q.app && q.app.size ? q.app.size : 0), 0);
  const bar = $('qBar');
  bar.style.width = cap ? Math.min(100, (total / cap) * 100) + '%' : '0';
  bar.className = cap && total > cap ? 'over' : '';
  $('qSpace').textContent = cap ? `${fmtSize(total)} of ${fmtSize(cap)} used${total > cap ? ' – too much: remove a small app' : ''}` : 'Connect your calculator to see free space.';
}

function refreshButtons() {
  const cap = capacity();
  const q = queue();
  const total = q.reduce((s, it) => s + (it.app && it.app.size ? it.app.size : 0), 0);
  const ok = !S.busy && S.calc && cap && q.length > 0 && q.every((it) => it.state === 'ready' && it.app && !it.app.needsExternalData) && total <= cap;
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
    if (it.kind === 'asset' && !(S.apps[it.asset.name] && S.apps[it.asset.name].icon)) rememberMeta(it.asset, { name: app.name, icon: app.iconUrl });
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
  for (const it of [...queue()]) { await prepare(it); renderSheet(); }
  S.busy = false;
  renderLists(); updateQueueBar(); renderSheet(); refreshButtons();
}

async function runInstall(dryRun) {
  if (!dryRun && !confirm('This replaces every app currently in the calculator\'s extra-apps area with the ones in this list. Continue?')) return;
  S.busy = true; refreshButtons();
  $('progress').hidden = false; $('result').hidden = true; $('pBar').style.width = '0';
  const items = queue();
  const apps = items.map((q) => q.app);
  const t0 = performance.now();
  try {
    if (!dryRun && settings.backup) {
      $('stage').textContent = 'Backing up saves…'; log('Backing up saves before installing…');
      const b = await syncSaves(false);
      if (!b.ok && !confirm('Could not back up your saves and Python scripts:\n\n' + b.error + '\n\nInstall anyway? Anything stored on the calculator might be lost.')) {
        $('stage').textContent = 'Cancelled.';
        showResult(false, 'Cancelled before anything was written. ' + b.error);
        return;
      }
    }
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
      S.doneSig = queueSig();
      showResult(true, `Installed ${titleOf(items[0])}${items.length > 1 ? ' and ' + (items.length - 1) + ' more' : ''} in ${secs}s. The calculator is restarting – open the Apps screen to find it.`);
      log(`Installed OK in ${secs}s`);
      updateQueueBar();
      S.calc = new Calculator(S.calc.device);        // old session is gone after the restart
      const tryReconnect = async (attemptsLeft) => {
        S.calc = null; S.installed = null;
        renderCalc(); setPill('', 'Connect');
        const ok = await connect(false);
        if (!ok && attemptsLeft > 0) setTimeout(() => tryReconnect(attemptsLeft - 1), 2000);
      };
      setTimeout(() => tryReconnect(3), 3500);
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

// ---- wiring ------------------------------------------------------------------------------------------------
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!webUsbAvailable()) $('noUsb').hidden = false;

  const doConnect = () => { if (!S.busy) connect(true); };
  $('connect').addEventListener('click', doConnect);
  $('connectBig').addEventListener('click', doConnect);
  $('refreshCalc').addEventListener('click', () => S.calc && !S.busy && readCalc());
  $('copyInfo').addEventListener('click', () => copy($('calcInfo').textContent));
  $('copyLog').addEventListener('click', () => copy($('log').textContent));
  $('reload').addEventListener('click', loadLibrary);
  $('moreBtn').addEventListener('click', () => {
    const more = $('more'); more.hidden = !more.hidden;
    $('moreBtn').setAttribute('aria-expanded', String(!more.hidden));
    $('moreBtn').textContent = more.hidden ? 'More apps & versions' : 'Fewer apps';
  });
  $('saveAll').addEventListener('click', saveAllOffline);
  $('review').addEventListener('click', openSheet);
  $('closeSheet').addEventListener('click', () => { if (!S.busy) $('sheet').close(); });
  closeOnBackdrop($('sheet'), () => !S.busy);
  $('install').addEventListener('click', () => runInstall(false));
  $('dry').addEventListener('click', () => runInstall(true));

  // settings
  $('optBackup').checked = settings.backup;
  $('optBackup').addEventListener('change', (e) => { settings.backup = e.target.checked; saveSettings(); });
  $('openSettings').addEventListener('click', () => $('settings').showModal());
  $('closeSettings').addEventListener('click', () => $('settings').close());
  closeOnBackdrop($('settings'));
  $('clearStore').addEventListener('click', async () => {
    if (!confirm('Remove all saved .nwa files from this device?')) return;
    await clearStored(); meta = {}; try { localStorage.removeItem(META_KEY); } catch { /* ignore */ }
    S.stored = new Set(); renderLists(); renderOfflineNote();
  });
  $('clearSaves').addEventListener('click', async () => {
    if (!confirm('Delete every saved-game backup from this device? Saves still on a calculator are not touched.')) return;
    await saves.clearSaves(); await renderSavesSummary(); toast('Backups deleted.');
  });

  // saves
  $('openSaves').addEventListener('click', openSaves);
  $('closeSaves').addEventListener('click', () => $('savesDlg').close());
  closeOnBackdrop($('savesDlg'));
  $('backupNow').addEventListener('click', async () => {
    if (!S.calc || S.busy) return;
    $('backupNow').disabled = true; $('backupMsg').textContent = 'Backing up…';
    const r = await syncSaves(false);
    $('backupMsg').textContent = r.ok ? (r.changed.length ? `Saved ${r.changed.length} new backup${r.changed.length > 1 ? 's' : ''}.` : 'Everything is already backed up.') : 'Could not read: ' + r.error;
    $('backupNow').disabled = false;
    await openSaves();
  });
  closeOnBackdrop($('restoreDlg'));

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
      S.calc = null; S.installed = null; setPill('', 'Connect'); renderCalc(); renderLists(); log('Calculator unplugged');
    });
  }

  renderCalc();
  await loadAppData();
  const missing = await loadWasm();
  if (missing.length) { $('missingList').textContent = missing.map((m) => m + '.wasm').join(' and '); $('setup').hidden = false; }

  await loadLibrary();
  renderSavesSummary();
  connect(false);
}
boot();
