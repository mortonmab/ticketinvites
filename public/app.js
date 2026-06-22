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
  inviteId: null,
  pageW: 612, pageH: 792,
  scale: 1, canvasW: 0, canvasH: 0,
  names: [],
  hasTemplate: false,
  layout: JSON.parse(JSON.stringify(DEFAULT_LAYOUT)),
  selected: 'name',
  generatedCount: 0
};

function api(path) {
  return '/admin/invites/' + state.inviteId + path;
}

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

function showProgress(prefix, label, pct) {
  const bar = $(prefix + 'ProgressBar');
  $(prefix + 'ProgressLbl').textContent = label;
  const pctEl = $(prefix + 'ProgressPct');
  $(prefix + 'Progress').classList.add('show');
  if (pct == null) {
    bar.classList.add('indeterminate');
    bar.style.width = '';
    pctEl.textContent = '';
  } else {
    bar.classList.remove('indeterminate');
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    bar.style.width = p + '%';
    pctEl.textContent = p + '%';
  }
}

function hideProgress(prefix) {
  const bar = $(prefix + 'ProgressBar');
  $(prefix + 'Progress').classList.remove('show');
  bar.classList.remove('indeterminate');
  bar.style.width = '0%';
  $(prefix + 'ProgressPct').textContent = '0%';
}

function xhrUpload(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    if (state.token) xhr.setRequestHeader('x-admin-token', state.token);
    xhr.upload.addEventListener('progress', (e) => {
      onProgress(e.lengthComputable ? (e.loaded / e.total) * 100 : null);
    });
    xhr.addEventListener('load', () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch (_) {}
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, json: async () => data });
    });
    xhr.addEventListener('error', () => reject(new Error('Network error')));
    xhr.send(formData);
  });
}

function xhrDownload(url, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    if (state.token) xhr.setRequestHeader('x-admin-token', state.token);
    xhr.responseType = 'blob';
    xhr.addEventListener('progress', (e) => {
      onProgress(e.lengthComputable ? (e.loaded / e.total) * 100 : null);
    });
    xhr.addEventListener('load', () => {
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, blob: async () => xhr.response });
    });
    xhr.addEventListener('error', () => reject(new Error('Network error')));
    xhr.send();
  });
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
 * Auth + boot + routing
 * ------------------------------------------------------------------ */
async function boot() {
  const r = await authFetch('/admin/config');
  if (r.status === 401) { $('login').classList.add('show'); return; }
  const cfg = await r.json();
  state.authRequired = cfg.authRequired;
  $('baseUrl').value = cfg.baseUrl || '';
  $('lock').textContent = cfg.authRequired ? 'Secured' : 'Open access';
  $('lock').className = 'lock' + (cfg.authRequired ? '' : ' open');
  handleRoute();
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

function parseRoute() {
  const hash = (location.hash || '#/').replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean);
  if (!parts.length || parts[0] === 'home') return { view: 'home' };
  if (parts[0] === 'invite' && parts[1]) {
    return { view: 'editor', id: parts[1], tab: parts[2] === 'responses' ? 'responses' : 'design' };
  }
  return { view: 'home' };
}

function setRoute(view, id, tab) {
  if (view === 'home') location.hash = '#/';
  else location.hash = '#/invite/' + id + (tab === 'responses' ? '/responses' : '');
}

function handleRoute() {
  const route = parseRoute();
  if (route.view === 'home') {
    state.inviteId = null;
    showView('home');
    loadHome();
    return;
  }
  openInvite(route.id, route.tab, true);
}

window.addEventListener('hashchange', () => {
  if (!$('login').classList.contains('show')) handleRoute();
});

function showView(view) {
  const inEditor = view === 'editor';
  $('tab-home').classList.toggle('hidden', inEditor);
  $('tab-design').classList.toggle('hidden', !inEditor);
  $('tab-responses').classList.toggle('hidden', true);
  $('tabDesignBtn').classList.toggle('hidden', !inEditor);
  $('tabResponsesBtn').classList.toggle('hidden', !inEditor);
  $('mainTabs').classList.toggle('hidden', !inEditor);
  const homeTab = document.querySelector('.tab[data-tab="home"]');
  if (homeTab) homeTab.classList.toggle('hidden', inEditor);
  if (!inEditor) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'home'));
  }
}

function goHome() {
  setRoute('home');
}

async function loadHome() {
  const r = await authFetch('/admin/invites');
  if (!r.ok) return;
  const d = await r.json();
  const list = $('inviteList');
  const invites = d.invites || [];
  if (!invites.length) {
    list.innerHTML = '<div class="invite-empty">No invitations yet. Click <b>+ New invitation</b> to create your first project.</div>';
    return;
  }
  list.innerHTML = invites.map((inv) => `<div class="invite-card" onclick="openInvite('${inv.id}')">
    <h3>${escapeHtml(inv.title)}</h3>
    <div class="meta">
      <b>${inv.nameCount || 0}</b> names · <b>${inv.generatedCount || 0}</b> generated
      ${inv.templateName ? '<br>Template: ' + escapeHtml(inv.templateName) : '<br><em>No template yet</em>'}
    </div>
    <div class="actions" onclick="event.stopPropagation()">
      <button class="btn primary sm" onclick="openInvite('${inv.id}')">Open</button>
      <button class="btn ghost sm danger" onclick="deleteInvite('${inv.id}', '${escapeAttr(inv.title)}')">Delete</button>
    </div>
  </div>`).join('');
}

async function createInvite() {
  const title = prompt('Invitation title:', 'New invitation');
  if (title === null) return;
  const r = await authFetch('/admin/invites', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title.trim() || 'Untitled invitation' })
  });
  const d = await r.json();
  if (!r.ok) { toast((d && d.error) || 'Could not create invitation', true); return; }
  openInvite(d.invite.id);
}

async function deleteInvite(id, title) {
  if (!confirm('Delete "' + (title || 'this invitation') + '"? This removes the template, generated PDFs, and all RSVP data.')) return;
  const r = await authFetch('/admin/invites/' + id, { method: 'DELETE' });
  if (!r.ok) { toast('Delete failed', true); return; }
  toast('Invitation deleted');
  if (state.inviteId === id) goHome();
  else loadHome();
}

function deleteCurrentInvite() {
  if (!state.inviteId) return;
  const title = $('inviteTitle').value || 'this invitation';
  deleteInvite(state.inviteId, title);
}

async function openInvite(id, tab, fromRoute) {
  const r = await authFetch('/admin/invites/' + id);
  if (!r.ok) {
    toast('Invitation not found', true);
    if (!fromRoute) goHome();
    return;
  }
  const cfg = await r.json();
  state.inviteId = id;
  state.pageW = cfg.pageWidth || 612;
  state.pageH = cfg.pageHeight || 792;
  state.names = cfg.names || [];
  state.generatedCount = cfg.generatedCount || 0;
  state.hasTemplate = !!cfg.templateName;
  state.layout = cfg.layout
    ? Object.assign(JSON.parse(JSON.stringify(DEFAULT_LAYOUT)), cfg.layout)
    : JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
  if (cfg.baseUrl) $('baseUrl').value = cfg.baseUrl;

  $('inviteTitle').value = cfg.title || '';
  showView('editor');
  syncControlsFromLayout();
  reflectFiles();
  $('afterGen').style.display = state.generatedCount > 0 ? 'flex' : 'none';
  if (state.hasTemplate) await renderTemplate();
  else {
    $('stageHost').innerHTML = '<div class="empty-stage" id="emptyStage"><div>Upload a template to begin positioning</div></div>';
    $('dims').textContent = '';
  }
  if (!fromRoute) setRoute('editor', id, tab || 'design');
  switchTab(tab || 'design', true);
}

async function saveTitle() {
  if (!state.inviteId) return;
  const title = $('inviteTitle').value.trim() || 'Untitled invitation';
  await authFetch('/admin/invites/' + state.inviteId, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title })
  });
}

/* ------------------------------------------------------------------ *
 * Tabs
 * ------------------------------------------------------------------ */
function switchTab(tab, fromRoute) {
  if (tab === 'home') { goHome(); return; }
  if (!state.inviteId) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('tab-design').classList.toggle('hidden', tab !== 'design');
  $('tab-responses').classList.toggle('hidden', tab !== 'responses');
  if (tab === 'responses') loadResponses();
  if (!fromRoute) setRoute('editor', state.inviteId, tab);
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
  const fd = new FormData();
  fd.append('template', file);
  try {
    showProgress('tpl', 'Uploading template…', 0);
    const r = await xhrUpload(api('/template'), fd, (pct) => {
      if (pct != null) showProgress('tpl', 'Uploading template…', pct);
    });
    const d = await r.json();
    if (!r.ok) { toast((d && d.error) || 'Upload failed', true); return; }
    showProgress('tpl', 'Loading preview…', null);
    state.pageW = d.pageWidth;
    state.pageH = d.pageHeight;
    state.hasTemplate = true;
    reflectFiles();
    await renderTemplate();
    toast('Template loaded');
  } catch (_) {
    toast('Upload failed', true);
  } finally {
    hideProgress('tpl');
    e.target.value = '';
  }
});

$('xlsInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData(); fd.append('excel', file);
  const r = await authFetch(api('/names'), { method: 'POST', body: fd });
  const d = await r.json();
  if (!r.ok) { toast(d.error || 'Upload failed', true); return; }
  const cfg = await (await authFetch('/admin/invites/' + state.inviteId)).json();
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
  const res = await authFetch(api('/template.pdf'));
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
    authFetch(api('/layout'), {
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
  const r = await authFetch(api('/preview'), {
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
    const r = await authFetch(api('/generate'), {
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
async function downloadZip() {
  const btn = $('zipBtn');
  try {
    btn.disabled = true;
    showProgress('zip', 'Preparing download…', 0);
    const r = await xhrDownload(api('/zip'), (pct) => {
      showProgress('zip', 'Downloading ZIP…', pct == null ? null : pct);
    });
    if (!r.ok) { toast('Download failed', true); return; }
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'worship-moments-invitations.zip';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    showProgress('zip', 'Download complete', 100);
    setTimeout(() => hideProgress('zip'), 1200);
  } catch (_) {
    toast('Download failed', true);
    hideProgress('zip');
  } finally {
    btn.disabled = false;
  }
}
function downloadPdf(id, name) { saveBlob(api('/pdf/' + id), name + '.pdf'); }
function exportRsvps() { saveBlob(api('/rsvps.xlsx'), 'rsvps.xlsx'); }

async function doReset() {
  if (!confirm('Reset everything? This deletes all generated invitations and RSVP responses. The template and positions stay.')) return;
  await authFetch(api('/reset'), { method: 'POST' });
  state.generatedCount = 0;
  $('afterGen').style.display = 'none';
  toast('Reset complete');
  loadResponses();
}

/* ------------------------------------------------------------------ *
 * Responses tab
 * ------------------------------------------------------------------ */
async function loadResponses() {
  const r = await authFetch(api('/invitees'));
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
