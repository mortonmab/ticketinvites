'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const archiver = require('archiver');
const ExcelJS = require('exceljs');
const { PDFDocument } = require('pdf-lib');

const store = require('./store');
const { generateInvitation } = require('./generate');
const pages = require('./pages');

store.load();

// If a BASE_URL is provided via env and the admin hasn't set one yet,
// seed it so QR codes and RSVP links resolve to the public address.
if (process.env.BASE_URL && !store.getSettings().baseUrl) {
  store.updateSettings({ baseUrl: process.env.BASE_URL.replace(/\/$/, '') });
}

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''; // empty => open mode
const AUTH_REQUIRED = ADMIN_PASSWORD.length > 0;

const DATA_DIR = store.DATA_DIR;
const TEMPLATE_PATH = path.join(DATA_DIR, 'template.pdf');
const OUTPUT_DIR = path.join(DATA_DIR, 'output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
const validTokens = new Set();

function requireAdmin(req, res, next) {
  if (!AUTH_REQUIRED) return next();
  const token = req.get('x-admin-token');
  if (token && validTokens.has(token)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

app.post('/admin/login', (req, res) => {
  if (!AUTH_REQUIRED) return res.json({ token: 'open', authRequired: false });
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(24).toString('hex');
    validTokens.add(token);
    return res.json({ token, authRequired: true });
  }
  return res.status(401).json({ error: 'Incorrect password' });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function baseUrlFrom(req, override) {
  const s = store.getSettings();
  return (override || s.baseUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function safeFileName(name) {
  return String(name).replace(/[^a-z0-9 _-]/gi, '').replace(/\s+/g, '_').slice(0, 60) || 'guest';
}

function newId() {
  // Short, URL-safe, collision-checked unique id.
  let id;
  do {
    id = crypto.randomBytes(5).toString('hex'); // 10 hex chars
  } while (store.getInvitee(id));
  return id;
}

async function parseNames(file) {
  const lower = (file.originalname || '').toLowerCase();
  const names = [];
  if (lower.endsWith('.csv')) {
    const lines = file.buffer.toString('utf8').split(/\r?\n/);
    for (const line of lines) {
      const cell = line.split(',')[0].replace(/^"|"$/g, '').trim();
      if (cell) names.push(cell);
    }
  } else {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer);
    const ws = wb.worksheets[0];
    if (ws) {
      ws.eachRow((row) => {
        const cell = row.getCell(1).value;
        let text = '';
        if (cell && typeof cell === 'object' && cell.richText) {
          text = cell.richText.map((t) => t.text).join('');
        } else if (cell != null) {
          text = String(cell);
        }
        text = text.trim();
        if (text) names.push(text);
      });
    }
  }
  // Drop a header cell if present.
  if (names.length && /^(invitee\s*)?name$/i.test(names[0])) names.shift();
  return names;
}

// ---------------------------------------------------------------------------
// Admin: configuration
// ---------------------------------------------------------------------------
app.get('/admin/config', requireAdmin, (req, res) => {
  const s = store.getSettings();
  res.json({
    authRequired: AUTH_REQUIRED,
    templateName: s.templateName,
    pageWidth: s.pageWidth,
    pageHeight: s.pageHeight,
    layout: s.layout,
    baseUrl: s.baseUrl || `${req.protocol}://${req.get('host')}`,
    names: s.names || [],
    nameCount: (s.names || []).length,
    generatedCount: store.getInvitees().length
  });
});

app.post('/admin/template', requireAdmin, upload.single('template'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const bytes = req.file.buffer;
    const doc = await PDFDocument.load(bytes);
    const page = doc.getPages()[0];
    const { width, height } = page.getSize();
    fs.writeFileSync(TEMPLATE_PATH, bytes);
    store.updateSettings({
      templateName: req.file.originalname,
      pageWidth: Math.round(width),
      pageHeight: Math.round(height)
    });
    res.json({ templateName: req.file.originalname, pageWidth: width, pageHeight: height });
  } catch (err) {
    res.status(400).json({ error: 'Could not read PDF: ' + err.message });
  }
});

app.get('/admin/template.pdf', requireAdmin, (req, res) => {
  if (!fs.existsSync(TEMPLATE_PATH)) return res.status(404).end();
  res.type('application/pdf');
  fs.createReadStream(TEMPLATE_PATH).pipe(res);
});

app.post('/admin/names', requireAdmin, upload.single('excel'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const names = await parseNames(req.file);
    if (!names.length) return res.status(400).json({ error: 'No names found in the file.' });
    store.updateSettings({ names });
    res.json({ count: names.length, sample: names.slice(0, 5) });
  } catch (err) {
    res.status(400).json({ error: 'Could not read spreadsheet: ' + err.message });
  }
});

app.post('/admin/layout', requireAdmin, (req, res) => {
  const { layout, baseUrl } = req.body || {};
  const patch = {};
  if (layout) patch.layout = layout;
  if (typeof baseUrl === 'string') patch.baseUrl = baseUrl.trim();
  store.updateSettings(patch);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Admin: preview + generation
// ---------------------------------------------------------------------------
app.post('/admin/preview', requireAdmin, async (req, res) => {
  try {
    if (!fs.existsSync(TEMPLATE_PATH)) return res.status(400).json({ error: 'Upload a template first.' });
    const s = store.getSettings();
    const layout = (req.body && req.body.layout) || s.layout;
    if (!layout) return res.status(400).json({ error: 'Position the elements first.' });
    const sampleName = (s.names && s.names[0]) || 'Sample Guest';
    const bytes = await generateInvitation({
      templateBytes: fs.readFileSync(TEMPLATE_PATH),
      name: sampleName,
      id: 'SAMPLE0000',
      baseUrl: baseUrlFrom(req, req.body && req.body.baseUrl),
      layout
    });
    res.type('application/pdf').send(Buffer.from(bytes));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/generate', requireAdmin, async (req, res) => {
  try {
    if (!fs.existsSync(TEMPLATE_PATH)) return res.status(400).json({ error: 'Upload a template first.' });
    const s = store.getSettings();
    const layout = (req.body && req.body.layout) || s.layout;
    const names = s.names || [];
    if (!layout) return res.status(400).json({ error: 'Position the elements first.' });
    if (!names.length) return res.status(400).json({ error: 'Upload an Excel file with names first.' });

    if (req.body && typeof req.body.baseUrl === 'string') {
      store.updateSettings({ baseUrl: req.body.baseUrl.trim(), layout });
    } else {
      store.updateSettings({ layout });
    }
    const baseUrl = baseUrlFrom(req, req.body && req.body.baseUrl);

    // Fresh batch: clear old invitees, rsvps, and output files.
    for (const f of fs.readdirSync(OUTPUT_DIR)) fs.unlinkSync(path.join(OUTPUT_DIR, f));
    store.clearAll();

    const templateBytes = fs.readFileSync(TEMPLATE_PATH);
    const invitees = [];
    for (const name of names) {
      const id = newId();
      const bytes = await generateInvitation({ templateBytes, name, id, baseUrl, layout });
      const file = `${safeFileName(name)}_${id}.pdf`;
      fs.writeFileSync(path.join(OUTPUT_DIR, file), Buffer.from(bytes));
      const inv = { id, name, createdAt: new Date().toISOString(), pdfFile: file, checkedIn: false, checkedInAt: null };
      invitees.push(inv);
    }
    store.replaceInvitees(invitees);
    res.json({ count: invitees.length, baseUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Admin: downloads + RSVP dashboard
// ---------------------------------------------------------------------------
app.get('/admin/invitees', requireAdmin, (req, res) => {
  res.json({ invitees: store.getRsvpRows() });
});

app.get('/admin/pdf/:id', requireAdmin, (req, res) => {
  const inv = store.getInvitee(req.params.id);
  if (!inv) return res.status(404).end();
  const fp = path.join(OUTPUT_DIR, inv.pdfFile);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.download(fp, inv.pdfFile);
});

app.get('/admin/zip', requireAdmin, (req, res) => {
  const invitees = store.getInvitees();
  if (!invitees.length) return res.status(400).json({ error: 'Nothing generated yet.' });
  res.attachment('worship-moments-invitations.zip');
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', () => res.status(500).end());
  archive.pipe(res);
  for (const inv of invitees) {
    const fp = path.join(OUTPUT_DIR, inv.pdfFile);
    if (fs.existsSync(fp)) archive.file(fp, { name: inv.pdfFile });
  }
  archive.finalize();
});

app.get('/admin/rsvps.xlsx', requireAdmin, async (req, res) => {
  const rows = store.getRsvpRows();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('RSVP Responses');
  ws.columns = [
    { header: 'Invitee Name', key: 'name', width: 30 },
    { header: 'Invitee ID', key: 'id', width: 16 },
    { header: 'RSVP Status', key: 'status', width: 14 },
    { header: 'RSVP Date & Time', key: 'respondedAt', width: 24 },
    { header: 'Comments', key: 'comments', width: 40 },
    { header: 'Checked In', key: 'checkedIn', width: 12 },
    { header: 'Check-in Time', key: 'checkedInAt', width: 24 }
  ];
  ws.getRow(1).font = { bold: true };
  rows.forEach((r) => ws.addRow(r));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="worship-moments-rsvps.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

app.post('/admin/reset', requireAdmin, (req, res) => {
  for (const f of fs.readdirSync(OUTPUT_DIR)) fs.unlinkSync(path.join(OUTPUT_DIR, f));
  store.clearAll();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Public: RSVP form + verification (reachable by anyone with the link/QR)
// ---------------------------------------------------------------------------
app.get('/r/:id', (req, res) => {
  const inv = store.getInvitee(req.params.id);
  if (!inv) return res.status(404).send(pages.notFound());
  const rsvp = store.getRsvp(inv.id);
  res.send(pages.rsvpForm(inv, rsvp));
});

app.post('/r/:id', (req, res) => {
  const inv = store.getInvitee(req.params.id);
  if (!inv) return res.status(404).send(pages.notFound());
  const status = req.body.status === 'Yes' ? 'Yes' : (req.body.status === 'No' ? 'No' : null);
  if (!status) return res.status(400).send(pages.rsvpForm(inv, store.getRsvp(inv.id), 'Please choose Yes or No.'));
  store.upsertRsvp(inv.id, status, (req.body.comments || '').slice(0, 1000));
  res.send(pages.rsvpThanks(inv, status));
});

app.get('/v/:id', (req, res) => {
  const inv = store.getInvitee(req.params.id);
  if (!inv) return res.status(404).send(pages.notFound());
  const rsvp = store.getRsvp(inv.id);
  res.send(pages.verifyPage(inv, rsvp, AUTH_REQUIRED));
});

app.post('/v/:id/checkin', (req, res) => {
  const inv = store.getInvitee(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  if (AUTH_REQUIRED && (req.body.pin || '') !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect gate PIN' });
  }
  store.setCheckedIn(inv.id, true);
  res.json({ ok: true, checkedInAt: store.getInvitee(inv.id).checkedInAt });
});

// ---------------------------------------------------------------------------
// Static admin dashboard
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log('\n  Worship Moments — Invitation Studio');
  console.log('  ───────────────────────────────────');
  console.log(`  Admin dashboard : http://localhost:${PORT}/`);
  console.log(`  Auth            : ${AUTH_REQUIRED ? 'password protected' : 'OPEN (set ADMIN_PASSWORD to lock)'}`);
  const bu = store.getSettings().baseUrl || process.env.BASE_URL || '(not set — using request host)';
  console.log(`  Public base URL : ${bu}`);
  console.log('');
});
