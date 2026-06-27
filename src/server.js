'use strict';

const path = require('path');
const fs = require('fs');

// Load .env from project root (optional — does not override existing env vars).
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const archiver = require('archiver');
const ExcelJS = require('exceljs');
const { PDFDocument } = require('pdf-lib');

const store = require('./store');
const { DEFAULT_BASE_URL } = store;
const { generateInvitation } = require('./generate');
const pages = require('./pages');

store.load();

if (process.env.BASE_URL && isLocalBaseUrl(store.getSettings().baseUrl)) {
  store.updateSettings({ baseUrl: process.env.BASE_URL.replace(/\/$/, '') });
}

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const AUTH_REQUIRED = ADMIN_PASSWORD.length > 0;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const validTokens = new Set();

function isLocalBaseUrl(url) {
  return !url || /localhost|127\.0\.0\.1/i.test(url);
}

function requireAdmin(req, res, next) {
  if (!AUTH_REQUIRED) return next();
  const token = req.get('x-admin-token');
  if (token && validTokens.has(token)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

function requireInvite(req, res, next) {
  const invite = store.getInvite(req.params.id);
  if (!invite) return res.status(404).json({ error: 'Invitation not found' });
  req.invite = invite;
  next();
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

function baseUrlFrom(req, invite, override) {
  const global = store.getSettings().baseUrl;
  return (override || invite.baseUrl || global || DEFAULT_BASE_URL).replace(/\/$/, '');
}

function safeFileName(name) {
  return String(name).replace(/[^a-z0-9 _-]/gi, '').replace(/\s+/g, '_').slice(0, 60) || 'guest';
}

function newId() {
  let id;
  do {
    id = crypto.randomBytes(5).toString('hex');
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
  if (names.length && /^(invitee\s*)?name$/i.test(names[0])) names.shift();
  return names;
}

function cellText(cell) {
  if (cell == null) return '';
  if (typeof cell === 'object' && cell.richText) {
    return cell.richText.map((t) => t.text).join('').trim();
  }
  return String(cell).trim();
}

async function parseSeatPlan(file) {
  const lower = (file.originalname || '').toLowerCase();
  const rows = [];
  if (lower.endsWith('.csv')) {
    const lines = file.buffer.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].split(',').map((c) => c.replace(/^"|"$/g, '').trim());
      if (!parts.some(Boolean)) continue;
      if (i === 0 && /seat|section/i.test(parts[0])) continue;
      rows.push({ seat: parts[0] || '', section: parts[1] || '' });
    }
  } else {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer);
    const ws = wb.worksheets[0];
    if (!ws) return rows;
    let seatCol = 1;
    let sectionCol = 2;
    const headerRow = ws.getRow(1);
    headerRow.eachCell((cell, col) => {
      const h = cellText(cell.value).toLowerCase();
      if (/seat/.test(h)) seatCol = col;
      else if (/section|area|zone|notes/.test(h)) sectionCol = col;
    });
    ws.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const seat = cellText(row.getCell(seatCol).value);
      const section = cellText(row.getCell(sectionCol).value);
      if (!seat && !section) return;
      rows.push({ seat, section });
    });
  }
  return rows;
}

function inviteConfig(req, invite) {
  return {
    id: invite.id,
    title: invite.title,
    templateName: invite.templateName,
    pageWidth: invite.pageWidth,
    pageHeight: invite.pageHeight,
    layout: invite.layout,
    baseUrl: invite.baseUrl || store.getSettings().baseUrl || DEFAULT_BASE_URL,
    names: invite.names || [],
    nameCount: (invite.names || []).length,
    generatedCount: (invite.invitees || []).filter((i) => !i.preview).length
  };
}

app.get('/admin/config', requireAdmin, (req, res) => {
  res.json({ authRequired: AUTH_REQUIRED, baseUrl: store.getSettings().baseUrl || DEFAULT_BASE_URL });
});

app.get('/admin/invites', requireAdmin, (req, res) => {
  res.json({ invites: store.getInvites().map(store.inviteSummary) });
});

app.post('/admin/invites', requireAdmin, (req, res) => {
  const title = (req.body && req.body.title) ? String(req.body.title).trim() : '';
  const invite = store.createInvite(title || 'Untitled invitation');
  res.json({ invite: store.inviteSummary(invite) });
});

app.get('/admin/invites/:id', requireAdmin, requireInvite, (req, res) => {
  res.json(inviteConfig(req, req.invite));
});

app.patch('/admin/invites/:id', requireAdmin, requireInvite, (req, res) => {
  const patch = {};
  if (req.body && typeof req.body.title === 'string') {
    patch.title = req.body.title.trim() || 'Untitled invitation';
  }
  const invite = store.updateInvite(req.params.id, patch);
  res.json({ invite: store.inviteSummary(invite) });
});

app.delete('/admin/invites/:id', requireAdmin, requireInvite, (req, res) => {
  store.deleteInvite(req.params.id);
  res.json({ ok: true });
});

app.post('/admin/invites/:id/template', requireAdmin, requireInvite, upload.single('template'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const bytes = req.file.buffer;
    const doc = await PDFDocument.load(bytes);
    const page = doc.getPages()[0];
    const { width, height } = page.getSize();
    const inviteId = req.params.id;
    store.ensureInviteDirs(inviteId);
    fs.writeFileSync(store.templatePath(inviteId), bytes);
    store.updateInvite(inviteId, {
      templateName: req.file.originalname,
      pageWidth: Math.round(width),
      pageHeight: Math.round(height)
    });
    res.json({ templateName: req.file.originalname, pageWidth: width, pageHeight: height });
  } catch (err) {
    res.status(400).json({ error: 'Could not read PDF: ' + err.message });
  }
});

app.get('/admin/invites/:id/template.pdf', requireAdmin, requireInvite, (req, res) => {
  const fp = store.templatePath(req.params.id);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.type('application/pdf');
  fs.createReadStream(fp).pipe(res);
});

app.post('/admin/invites/:id/names', requireAdmin, requireInvite, upload.single('excel'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const names = await parseNames(req.file);
    if (!names.length) return res.status(400).json({ error: 'No names found in the file.' });
    store.updateInvite(req.params.id, { names });
    res.json({ count: names.length, sample: names.slice(0, 5) });
  } catch (err) {
    res.status(400).json({ error: 'Could not read spreadsheet: ' + err.message });
  }
});

app.post('/admin/invites/:id/layout', requireAdmin, requireInvite, (req, res) => {
  const { layout, baseUrl } = req.body || {};
  const patch = {};
  if (layout) patch.layout = layout;
  if (typeof baseUrl === 'string') patch.baseUrl = baseUrl.trim();
  store.updateInvite(req.params.id, patch);
  res.json({ ok: true });
});

app.post('/admin/invites/:id/preview', requireAdmin, requireInvite, async (req, res) => {
  try {
    const tplPath = store.templatePath(req.params.id);
    if (!fs.existsSync(tplPath)) return res.status(400).json({ error: 'Upload a template first.' });
    const invite = req.invite;
    const layout = (req.body && req.body.layout) || invite.layout;
    if (!layout) return res.status(400).json({ error: 'Position the elements first.' });
    const guest = store.ensurePreviewGuest(invite);
    const bytes = await generateInvitation({
      templateBytes: fs.readFileSync(tplPath),
      name: guest.name,
      id: guest.id,
      baseUrl: baseUrlFrom(req, invite, req.body && req.body.baseUrl),
      layout
    });
    res.type('application/pdf').send(Buffer.from(bytes));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/invites/:id/generate', requireAdmin, requireInvite, async (req, res) => {
  try {
    const inviteId = req.params.id;
    const tplPath = store.templatePath(inviteId);
    if (!fs.existsSync(tplPath)) return res.status(400).json({ error: 'Upload a template first.' });
    const invite = req.invite;
    const layout = (req.body && req.body.layout) || invite.layout;
    const names = invite.names || [];
    if (!layout) return res.status(400).json({ error: 'Position the elements first.' });
    if (!names.length) return res.status(400).json({ error: 'Upload an Excel file with names first.' });

    const patch = { layout };
    if (req.body && typeof req.body.baseUrl === 'string') patch.baseUrl = req.body.baseUrl.trim();
    store.updateInvite(inviteId, patch);
    const updated = store.getInvite(inviteId);
    const baseUrl = baseUrlFrom(req, updated, req.body && req.body.baseUrl);

    const outDir = store.outputDir(inviteId);
    store.ensureInviteDirs(inviteId);
    for (const f of fs.readdirSync(outDir)) fs.unlinkSync(path.join(outDir, f));
    store.clearInviteBatch(inviteId);

    const templateBytes = fs.readFileSync(tplPath);
    const invitees = [];
    for (const name of names) {
      const id = newId();
      const bytes = await generateInvitation({ templateBytes, name, id, baseUrl, layout });
      const file = `${safeFileName(name)}_${id}.pdf`;
      fs.writeFileSync(path.join(outDir, file), Buffer.from(bytes));
      invitees.push({
        id, name, createdAt: new Date().toISOString(), pdfFile: file,
        checkedIn: false, checkedInAt: null, seatNumbers: null, checkinEventId: null
      });
    }
    store.replaceInvitees(inviteId, invitees);
    res.json({ count: invitees.length, baseUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/invites/:id/invitees', requireAdmin, requireInvite, (req, res) => {
  res.json({ invitees: store.getRsvpRows(req.params.id) });
});

app.get('/admin/invites/:id/pdf/:inviteeId', requireAdmin, requireInvite, (req, res) => {
  const inv = req.invite.invitees.find((i) => i.id === req.params.inviteeId);
  if (!inv) return res.status(404).end();
  const fp = path.join(store.outputDir(req.params.id), inv.pdfFile);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.download(fp, inv.pdfFile);
});

app.get('/admin/invites/:id/zip', requireAdmin, requireInvite, (req, res) => {
  const invitees = (req.invite.invitees || []).filter((i) => !i.preview);
  if (!invitees.length) return res.status(400).json({ error: 'Nothing generated yet.' });
  const safeTitle = safeFileName(req.invite.title) || 'invitations';
  res.attachment(`${safeTitle}.zip`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', () => res.status(500).end());
  archive.pipe(res);
  const outDir = store.outputDir(req.params.id);
  for (const inv of invitees) {
    const fp = path.join(outDir, inv.pdfFile);
    if (fs.existsSync(fp)) archive.file(fp, { name: inv.pdfFile });
  }
  archive.finalize();
});

app.get('/admin/invites/:id/rsvps.xlsx', requireAdmin, requireInvite, async (req, res) => {
  const rows = store.getRsvpRows(req.params.id);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('RSVP Responses');
  ws.columns = [
    { header: 'Invitee Name', key: 'name', width: 30 },
    { header: 'Invitee ID', key: 'id', width: 16 },
    { header: 'RSVP Status', key: 'status', width: 14 },
    { header: 'RSVP Date & Time', key: 'respondedAt', width: 24 },
    { header: 'Comments', key: 'comments', width: 40 },
    { header: 'Checked In', key: 'checkedIn', width: 12 },
    { header: 'Check-in Time', key: 'checkedInAt', width: 24 },
    { header: 'Seats', key: 'seatNumbers', width: 18 }
  ];
  ws.getRow(1).font = { bold: true };
  rows.forEach((r) => ws.addRow(r));
  const safeTitle = safeFileName(req.invite.title) || 'rsvps';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}-rsvps.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

app.post('/admin/invites/:id/reset', requireAdmin, requireInvite, (req, res) => {
  const outDir = store.outputDir(req.params.id);
  if (fs.existsSync(outDir)) {
    for (const f of fs.readdirSync(outDir)) fs.unlinkSync(path.join(outDir, f));
  }
  store.clearInviteBatch(req.params.id);
  res.json({ ok: true });
});

app.get('/admin/checkin/events', requireAdmin, (req, res) => {
  res.json({ events: store.getCheckinEvents().map(store.checkinEventSummary) });
});

app.post('/admin/checkin/events', requireAdmin, (req, res) => {
  const { title, inviteIds } = req.body || {};
  const ids = Array.isArray(inviteIds) ? inviteIds.filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'Select at least one invitation.' });
  const evt = store.createCheckinEvent(
    title ? String(title).trim() : 'Event check-in',
    ids
  );
  res.json({ event: store.checkinEventSummary(evt) });
});

app.patch('/admin/checkin/events/:id', requireAdmin, (req, res) => {
  const evt = store.updateCheckinEvent(req.params.id, req.body || {});
  if (!evt) return res.status(404).json({ error: 'Event not found' });
  res.json({ event: store.checkinEventSummary(evt) });
});

app.delete('/admin/checkin/events/:id', requireAdmin, (req, res) => {
  if (!store.deleteCheckinEvent(req.params.id)) {
    return res.status(404).json({ error: 'Event not found' });
  }
  res.json({ ok: true });
});

app.get('/admin/checkin/events/:id/guests', requireAdmin, (req, res) => {
  const evt = store.getCheckinEvent(req.params.id);
  if (!evt) return res.status(404).json({ error: 'Event not found' });
  res.json({
    event: store.checkinEventSummary(evt),
    guests: store.getCheckinRows(req.params.id)
  });
});

app.get('/admin/checkin/search', requireAdmin, (req, res) => {
  const inviteIds = String(req.query.inviteIds || '').split(',').filter(Boolean);
  const eventId = req.query.eventId || '';
  const q = req.query.q || '';
  if (!inviteIds.length) return res.status(400).json({ error: 'No invitations selected.' });
  res.json({ results: store.searchCheckinGuests(inviteIds, q, eventId || null) });
});

app.get('/admin/checkin/events/:id/seats-template', requireAdmin, async (req, res) => {
  const evt = store.getCheckinEvent(req.params.id);
  if (!evt) return res.status(404).json({ error: 'Event not found' });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Available Seats');
  ws.columns = [
    { header: 'Seat Number', key: 'seat', width: 16 },
    { header: 'Section (optional)', key: 'section', width: 22 }
  ];
  ws.getRow(1).font = { bold: true };
  ws.getCell('A1').note = 'List every available seat — one per row. Seats are assigned when guests check in, not before.';
  const existing = evt.seatPool || [];
  if (existing.length) {
    for (const seat of existing) ws.addRow({ seat, section: '' });
  } else {
    for (let i = 1; i <= 50; i++) ws.addRow({ seat: String(i), section: '' });
  }
  const safeTitle = safeFileName(evt.title) || 'seat-pool';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}-seats-template.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

app.post('/admin/checkin/events/:id/seats', requireAdmin, upload.single('excel'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const rows = await parseSeatPlan(req.file);
    if (!rows.length) return res.status(400).json({ error: 'No seat rows found in the file.' });
    const result = store.importSeatPlan(req.params.id, rows);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: 'Could not read spreadsheet: ' + err.message });
  }
});

app.post('/admin/checkin/checkin', requireAdmin, (req, res) => {
  const { inviteeId, eventId, seatCount } = req.body || {};
  if (!inviteeId || !eventId) {
    return res.status(400).json({ error: 'Guest and event are required.' });
  }
  const result = store.checkInGuest(inviteeId, eventId, seatCount);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

app.post('/admin/checkin/undo', requireAdmin, (req, res) => {
  const { inviteeId, eventId } = req.body || {};
  if (!inviteeId || !eventId) {
    return res.status(400).json({ error: 'Guest and event are required.' });
  }
  const result = store.undoCheckin(inviteeId, eventId);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

app.get('/r/:id', (req, res) => {
  const found = store.findInvitee(req.params.id);
  if (!found) return res.status(404).send(pages.notFound());
  const rsvp = store.getRsvp(found.invite.id, found.invitee.id);
  res.send(pages.rsvpForm(found.invitee, rsvp));
});

app.post('/r/:id', (req, res) => {
  const found = store.findInvitee(req.params.id);
  if (!found) return res.status(404).send(pages.notFound());
  const status = req.body.status === 'Yes' ? 'Yes' : (req.body.status === 'No' ? 'No' : null);
  if (!status) {
    const rsvp = store.getRsvp(found.invite.id, found.invitee.id);
    return res.status(400).send(pages.rsvpForm(found.invitee, rsvp, 'Please choose Yes or No.'));
  }
  store.upsertRsvp(found.invitee.id, status, (req.body.comments || '').slice(0, 1000));
  res.send(pages.rsvpThanks(found.invitee, status));
});

app.get('/v/:id', (req, res) => {
  const found = store.findInvitee(req.params.id);
  if (!found) return res.status(404).send(pages.notFound());
  const rsvp = store.getRsvp(found.invite.id, found.invitee.id);
  res.send(pages.verifyPage(found.invitee, rsvp, AUTH_REQUIRED));
});

app.post('/v/:id/checkin', (req, res) => {
  const found = store.findInvitee(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });
  if (AUTH_REQUIRED && (req.body.pin || '') !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect gate PIN' });
  }
  const evt = store.findCheckinEventForInvite(found.invite.id);
  if (evt && evt.seatPool && evt.seatPool.length) {
    const result = store.checkInGuest(found.invitee.id, evt.id, 1);
    if (result.error) return res.status(400).json({ error: result.error });
  } else {
    store.setCheckedIn(found.invitee.id, true);
  }
  const inv = store.getInvitee(found.invitee.id);
  res.json({
    ok: true,
    checkedInAt: inv.checkedInAt,
    seatNumbers: store.inviteeSeats(inv)
  });
});

app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.webmanifest')) {
      res.setHeader('Content-Type', 'application/manifest+json');
    }
  }
}));

app.listen(PORT, () => {
  console.log('\n  Worship Moments — Invitation Studio');
  console.log('  ───────────────────────────────────');
  console.log(`  Admin dashboard : http://localhost:${PORT}/`);
  console.log(`  Auth            : ${AUTH_REQUIRED ? 'password protected' : 'OPEN (set ADMIN_PASSWORD to lock)'}`);
  const bu = store.getSettings().baseUrl || process.env.BASE_URL || DEFAULT_BASE_URL;
  console.log(`  Public base URL : ${bu}`);
  console.log('');
});
