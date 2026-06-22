'use strict';

/* ------------------------------------------------------------------ *
 * State + helpers
 * ------------------------------------------------------------------ */
const DEFAULT_LAYOUT = {
  name: { x: 0.18, y: 0.60, w: 0.64, h: 0.055, fontSize: 30, fontKey: 'Times', color: '#1a1a1a', align: 'center' },
  qr:   { x: 0.06, y: 0.05, size: 0.16 },
  rsvp: { enabled: false, x: 0.34, y: 0.90, w: 0.32, h: 0.04, fontSize: 13, label: 'RSVP HERE', bg: '#b8860b', fg: '#ffffff' }
};

const state = {
  token: localStorage.getItem('wm_token') || '',
  authRequired: false,
  pageW: 612, pageH: 792,
  scale: 1, canvasW: 0, canvasH: 0,
  names: [],
  hasTemplate: false,
  layout: JSON.parse(JSON.stringify(DEFAULT_LAYOUT)),
  selected: 'name',
  generatedCount: 0
};

const $ = (id) => document.getElementById(id);

function authFetch(url, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  if (state.token) opts.headers['x-admin-token'] = state.token;
  return fetch(url, opts);
}

let toastTimer;
function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3200);
}

function fontCss(key) {
  if (key === 'Invitation-Script') {
    return { fam: '"Great Vibes", cursive', weight: '400', style: 'normal' };
  }
  const fam = key.startsWith('Times') ? 'Georgia, "Times New Roman", serif'
    : key.startsWith('Courier') ? 'ui-monospace, "Courier New", monospace'
    : 'Helvetica, Arial, sans-serif';
  return {
    fam,
    weight: key.includes('Bold') ? '700' : '400',
    style: key.includes('Italic') ? 'italic' : 'normal'
  };
}

/* ------------------------------------------------------------------ *
 * Auth + boot
 * ------------------------------------------------------------------ */
async function boot() {
  const r = await authFetch('/admin/config');
  if (r.status === 401) { $('login').classList.add('show'); return; }
  const cfg = await r.json();
  state.authRequired = cfg.authRequired;
  state.pageW = cfg.pageWidth || 612;
  state.pageH = cfg.pageHeight || 792;
  state.names = cfg.names || [];
  state.generatedCount = cfg.generatedCount || 0;
  state.hasTemplate = !!cfg.templateName;
  if (cfg.layout) state.layout = Object.assign(JSON.parse(JSON.stringify(DEFAULT_LAYOUT)), cfg.layout);

  $('baseUrl').value = cfg.baseUrl || '';
  $('lock').textContent = cfg.authRequired ? 'Secured' : 'Open access';
  $('lock').className = 'lock' + (cfg.authRequired ? '' : ' open');

  syncControlsFromLayout();
  reflectFiles();
  if (state.hasTemplate) await renderTemplate();
  if (state.generatedCount > 0) $('afterGen').style.display = 'flex';
}

async function doLogin() {
  const password = $('loginPw').value;
  const r = await fetch('/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
  if (!r.ok) { $('loginErr').textContent = 'Incorrect password'; return; }
  const d = await r.json();
  state.token = d.token;
  localStorage.setItem('wm_token', d.token);
  $('login').classList.remove('show');
  boot();
}
$('loginPw') && $('loginPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

/* ------------------------------------------------------------------ *
 * Tabs
 * ------------------------------------------------------------------ */
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('tab-design').classList.toggle('hidden', tab !== 'design');
  $('tab-responses').classList.toggle('hidden', tab !== 'responses');
  if (tab === 'responses') loadResponses();
}

/* ------------------------------------------------------------------ *
 * File uploads
 * ------------------------------------------------------------------ */
function reflectFiles() {
  if (state.hasTemplate) {
    $('tplDrop').classList.add('done');
    $('tplTitle').textContent = 'Template loaded';
    $('tplSub').textContent = 'Click to replace';
  }
  if (state.names.length) {
    $('xlsDrop').classList.add('done');
    $('xlsTitle').textContent = state.names.length + ' names loaded';
    $('xlsSub').textContent = state.names.slice(0, 3).join(', ') + (state.names.length > 3 ? '…' : '');
  }
}

$('tplInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData(); fd.append('template', file);
  const r = await authFetch('/admin/template', { method: 'POST', body: fd });
  const d = await r.json();
  if (!r.ok) { toast(d.error || 'Upload failed', true); return; }
  state.pageW = d.pageWidth; state.pageH = d.pageHeight; state.hasTemplate = true;
  reflectFiles();
  await renderTemplate();
  toast('Template loaded');
});

$('xlsInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData(); fd.append('excel', file);
  const r = await authFetch('/admin/names', { method: 'POST', body: fd });
  const d = await r.json();
  if (!r.ok) { toast(d.error || 'Upload failed', true); return; }
  state.names = []; // refresh from sample preview by reloading config
  const cfg = await (await authFetch('/admin/config')).json();
  state.names = cfg.names || [];
  reflectFiles();
  renderElements(); // update sample name shown on stage
  toast(d.count + ' names loaded');
});

/* ------------------------------------------------------------------ *
 * Template rendering (pdf.js) + positioning overlay
 * ------------------------------------------------------------------ */
async function renderTemplate() {
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';
  const res = await authFetch('/admin/template.pdf');
  const buf = await res.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const page = await pdf.getPage(1);

  const host = $('stageHost');
  const maxW = host.clientWidth || 800;
  const base = page.getViewport({ scale: 1 });
  state.scale = maxW / base.width;
  const viewport = page.getViewport({ scale: state.scale });
  state.canvasW = viewport.width;
  state.canvasH = viewport.height;

  host.innerHTML = '';
  const stage = document.createElement('div');
  stage.className = 'stage';
  stage.id = 'stage';
  stage.style.width = viewport.width + 'px';
  stage.style.height = viewport.height + 'px';

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width; canvas.height = viewport.height;
  const overlay = document.createElement('div');
  overlay.className = 'overlay'; overlay.id = 'overlay';
  stage.appendChild(canvas); stage.appendChild(overlay);
  host.appendChild(stage);

  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  $('dims').textContent = Math.round(state.pageW) + ' × ' + Math.round(state.pageH) + ' pt';
  renderElements();
}

function sampleName() {
  const name = state.names[0] || 'Guest Name';
  return `Dear ${name}`;
}

function renderElements() {
  const overlay = $('overlay');
  if (!overlay) return;
  overlay.innerHTML = '';
  makeNameEl(overlay);
  makeQrEl(overlay);
  if (state.layout.rsvp.enabled) makeRsvpEl(overlay);
}

function px(frac, axis) { return frac * (axis === 'x' ? state.canvasW : state.canvasH); }

function baseEl(overlay, key, tag, color) {
  const el = document.createElement('div');
  el.className = 'el';
  el.dataset.key = key;
  if (state.selected === key) el.classList.add('sel');
  const label = document.createElement('div');
  label.className = 'el-label el-tag-' + tag;
  label.textContent = key === 'name' ? 'NAME' : key === 'qr' ? 'QR' : 'RSVP';
  el.appendChild(label);
  const handle = document.createElement('div');
  handle.className = 'handle';
  el.appendChild(handle);
  attachDrag(el, handle, key);
  overlay.appendChild(el);
  return el;
}

function makeNameEl(overlay) {
  const n = state.layout.name;
  const el = baseEl(overlay, 'name', 'name');
  el.classList.add('el-name');
  el.style.left = px(n.x, 'x') + 'px';
  el.style.top = px(n.y, 'y') + 'px';
  el.style.width = px(n.w, 'x') + 'px';
  el.style.height = px(n.h, 'y') + 'px';
  el.style.justifyContent = n.align === 'left' ? 'flex-start' : n.align === 'right' ? 'flex-end' : 'center';
  const f = fontCss(n.fontKey);
  const span = document.createElement('span');
  span.textContent = sampleName();
  span.style.fontFamily = f.fam;
  span.style.fontWeight = f.weight;
  span.style.fontStyle = f.style;
  span.style.fontSize = (n.fontSize * state.scale) + 'px';
  span.style.color = n.color;
  el.appendChild(span);
}

function makeQrEl(overlay) {
  const q = state.layout.qr;
  const el = baseEl(overlay, 'qr', 'qr');
  el.classList.add('el-qr');
  const size = px(q.size, 'x');
  el.style.left = px(q.x, 'x') + 'px';
  el.style.top = px(q.y, 'y') + 'px';
  el.style.width = size + 'px';
  el.style.height = size + 'px';
  const mark = document.createElement('div');
  mark.className = 'qr-mark'; mark.textContent = 'QR';
  el.appendChild(mark);
}

function makeRsvpEl(overlay) {
  const r = state.layout.rsvp;
  const el = baseEl(overlay, 'rsvp', 'rsvp');
  el.classList.add('el-rsvp');
  el.style.left = px(r.x, 'x') + 'px';
  el.style.top = px(r.y, 'y') + 'px';
  el.style.width = px(r.w, 'x') + 'px';
  el.style.height = px(r.h, 'y') + 'px';
  el.style.background = r.bg;
  el.style.color = r.fg;
  el.style.fontSize = (r.fontSize * state.scale) + 'px';
  el.appendChild(document.createTextNode(r.label || 'RSVP HERE'));
}

/* ---- drag + resize ---- */
function attachDrag(el, handle, key) {
  let mode = null, startX, startY, startLeft, startTop, startW, startH;

  function down(e, m) {
    e.preventDefault(); e.stopPropagation();
    mode = m;
    select(key);
    const p = point(e);
    startX = p.x; startY = p.y;
    startLeft = el.offsetLeft; startTop = el.offsetTop;
    startW = el.offsetWidth; startH = el.offsetHeight;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  function move(e) {
    const p = point(e);
    const dx = p.x - startX, dy = p.y - startY;
    if (mode === 'drag') {
      let l = clamp(startLeft + dx, 0, state.canvasW - startW);
      let t = clamp(startTop + dy, 0, state.canvasH - startH);
      el.style.left = l + 'px'; el.style.top = t + 'px';
    } else { // resize
      if (key === 'qr') {
        let s = clamp(Math.max(startW + dx, startH + dy), 18, Math.min(state.canvasW, state.canvasH));
        s = Math.min(s, state.canvasW - el.offsetLeft, state.canvasH - el.offsetTop);
        el.style.width = s + 'px'; el.style.height = s + 'px';
      } else {
        let w = clamp(startW + dx, 30, state.canvasW - el.offsetLeft);
        let h = clamp(startH + dy, 14, state.canvasH - el.offsetTop);
        el.style.width = w + 'px'; el.style.height = h + 'px';
      }
    }
    commitGeometry(key, el);
  }
  function up() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    mode = null;
    saveLayout();
  }
  el.addEventListener('pointerdown', (e) => { if (e.target !== handle) down(e, 'drag'); });
  handle.addEventListener('pointerdown', (e) => down(e, 'resize'));
}

function point(e) {
  const r = $('stage').getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function commitGeometry(key, el) {
  const L = el.offsetLeft / state.canvasW;
  const T = el.offsetTop / state.canvasH;
  if (key === 'name') {
    Object.assign(state.layout.name, { x: L, y: T, w: el.offsetWidth / state.canvasW, h: el.offsetHeight / state.canvasH });
  } else if (key === 'qr') {
    Object.assign(state.layout.qr, { x: L, y: T, size: el.offsetWidth / state.canvasW });
    $('qrSize').value = Math.round(state.layout.qr.size * 100);
    $('qrSizeVal').textContent = Math.round(state.layout.qr.size * 100) + '%';
  } else {
    Object.assign(state.layout.rsvp, { x: L, y: T, w: el.offsetWidth / state.canvasW, h: el.offsetHeight / state.canvasH });
  }
}

function select(key) {
  state.selected = key;
  $('selName').textContent = key === 'name' ? 'Name' : key === 'qr' ? 'QR code' : 'RSVP button';
  document.querySelectorAll('.el').forEach((e) => e.classList.toggle('sel', e.dataset.key === key));
}

/* ------------------------------------------------------------------ *
 * Controls → layout
 * ------------------------------------------------------------------ */
function syncControlsFromLayout() {
  const n = state.layout.name, r = state.layout.rsvp, q = state.layout.qr;
  $('nameFont').value = n.fontKey;
  $('nameSize').value = n.fontSize;
  $('nameAlign').value = n.align;
  $('nameColor').value = n.color;
  $('qrSize').value = Math.round(q.size * 100);
  $('qrSizeVal').textContent = Math.round(q.size * 100) + '%';
  $('rsvpEnabled').checked = r.enabled;
  $('rsvpControls').classList.toggle('hidden', !r.enabled);
  $('rsvpLabel').value = r.label;
  $('rsvpSize').value = r.fontSize;
  $('rsvpBg').value = r.bg;
  $('rsvpFg').value = r.fg;
}

function bindCtl(id, fn) { $(id).addEventListener('input', () => { fn($(id).value); renderElements(); saveLayout(); }); }

bindCtl('nameFont', (v) => state.layout.name.fontKey = v);
bindCtl('nameSize', (v) => state.layout.name.fontSize = Math.max(8, +v || 8));
bindCtl('nameAlign', (v) => state.layout.name.align = v);
bindCtl('nameColor', (v) => state.layout.name.color = v);
bindCtl('qrSize', (v) => { state.layout.qr.size = (+v) / 100; $('qrSizeVal').textContent = v + '%'; });
bindCtl('rsvpLabel', (v) => state.layout.rsvp.label = v);
bindCtl('rsvpSize', (v) => state.layout.rsvp.fontSize = Math.max(8, +v || 8));
bindCtl('rsvpBg', (v) => state.layout.rsvp.bg = v);
bindCtl('rsvpFg', (v) => state.layout.rsvp.fg = v);
$('rsvpEnabled').addEventListener('change', () => {
  state.layout.rsvp.enabled = $('rsvpEnabled').checked;
  $('rsvpControls').classList.toggle('hidden', !state.layout.rsvp.enabled);
  renderElements(); saveLayout();
});
$('baseUrl').addEventListener('change', saveLayout);

let saveTimer;
function saveLayout() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    authFetch('/admin/layout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout: state.layout, baseUrl: $('baseUrl').value })
    });
  }, 400);
}

/* ------------------------------------------------------------------ *
 * Preview / generate / downloads
 * ------------------------------------------------------------------ */
async function doPreview() {
  if (!state.hasTemplate) { toast('Upload a template first', true); return; }
  $('previewBtn').disabled = true;
  const r = await authFetch('/admin/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ layout: state.layout, baseUrl: $('baseUrl').value })
  });
  $('previewBtn').disabled = false;
  if (!r.ok) { const d = await r.json().catch(() => ({})); toast(d.error || 'Preview failed', true); return; }
  const blob = await r.blob();
  $('previewFrame').src = URL.createObjectURL(blob);
  $('previewScrim').classList.add('show');
}
function closePreview() { $('previewScrim').classList.remove('show'); }

async function doGenerate() {
  if (!state.hasTemplate) { toast('Upload a template first', true); return; }
  if (!state.names.length) { toast('Upload guest names first', true); return; }
  if (!confirm('Generate ' + state.names.length + ' invitations? This replaces any previous batch and its RSVP links.')) return;
  $('genBtn').disabled = true;
  $('genBusy').classList.add('show');
  $('genBusyTxt').textContent = 'Generating ' + state.names.length + ' invitations…';
  try {
    const r = await authFetch('/admin/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout: state.layout, baseUrl: $('baseUrl').value })
    });
    const d = await r.json();
    if (!r.ok) { toast(d.error || 'Generation failed', true); return; }
    state.generatedCount = d.count;
    $('afterGen').style.display = 'flex';
    toast(d.count + ' invitations generated');
  } finally {
    $('genBtn').disabled = false;
    $('genBusy').classList.remove('show');
  }
}

async function saveBlob(url, filename) {
  const r = await authFetch(url);
  if (!r.ok) { toast('Download failed', true); return; }
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename || '';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function downloadZip() { saveBlob('/admin/zip', 'worship-moments-invitations.zip'); }
function downloadPdf(id, name) { saveBlob('/admin/pdf/' + id, name + '.pdf'); }
function exportRsvps() { saveBlob('/admin/rsvps.xlsx', 'worship-moments-rsvps.xlsx'); }

async function doReset() {
  if (!confirm('Reset everything? This deletes all generated invitations and RSVP responses. The template and positions stay.')) return;
  await authFetch('/admin/reset', { method: 'POST' });
  state.generatedCount = 0;
  $('afterGen').style.display = 'none';
  toast('Reset complete');
  loadResponses();
}

/* ------------------------------------------------------------------ *
 * Responses tab
 * ------------------------------------------------------------------ */
async function loadResponses() {
  const r = await authFetch('/admin/invitees');
  const d = await r.json();
  const rows = d.invitees || [];
  const yes = rows.filter((x) => x.status === 'Yes').length;
  const no = rows.filter((x) => x.status === 'No').length;
  const pending = rows.filter((x) => x.status === 'Pending').length;
  const inHouse = rows.filter((x) => x.checkedIn === 'Yes').length;

  $('stats').innerHTML = [
    ['Invitees', rows.length], ['Attending', yes], ['Declined', no], ['Awaiting', pending], ['Checked in', inHouse]
  ].map(([l, n]) => `<div class="stat"><div class="num">${n}</div><div class="lbl">${l}</div></div>`).join('');

  if (!rows.length) {
    $('respTableWrap').innerHTML = '<div class="empty-stage" style="aspect-ratio:auto;padding:40px"><div>No invitations generated yet. Generate a batch on the Design tab.</div></div>';
    return;
  }
  const body = rows.map((x) => `<tr>
    <td>${escapeHtml(x.name)}</td>
    <td class="id">${x.id}</td>
    <td><span class="pill ${x.status}">${x.status}</span></td>
    <td>${x.respondedAt ? new Date(x.respondedAt).toLocaleString() : '—'}</td>
    <td>${x.checkedIn === 'Yes' ? '✓' : '—'}</td>
    <td>${escapeHtml(x.comments || '')}</td>
    <td><a class="linkbtn" href="javascript:void(0)" onclick="downloadPdf('${x.id}', '${escapeAttr(x.name)}')">PDF</a></td>
  </tr>`).join('');
  $('respTableWrap').innerHTML = `<table><thead><tr>
    <th>Invitee name</th><th>ID</th><th>RSVP</th><th>Responded</th><th>In</th><th>Comments</th><th></th>
  </tr></thead><tbody>${body}</tbody></table>`;
}

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s).replace(/_/g, ' '); }

window.addEventListener('resize', () => { if (state.hasTemplate) renderTemplate(); });
boot();
