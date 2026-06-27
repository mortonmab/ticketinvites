'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const INVITES_DIR = path.join(DATA_DIR, 'invites');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TMP_FILE = path.join(DATA_DIR, 'db.json.tmp');

const DEFAULT_BASE_URL = 'https://invites.ticketbox.co.zw';

const DEFAULT_DB = {
  settings: { baseUrl: DEFAULT_BASE_URL },
  checkinEvents: [],
  invites: []
};

let db = null;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function newCheckinEventId() {
  let id;
  do {
    id = crypto.randomBytes(4).toString('hex');
  } while (getCheckinEvent(id));
  return id;
}

function defaultCheckinEvent(title, inviteIds) {
  const now = new Date().toISOString();
  return {
    id: newCheckinEventId(),
    title: title || 'Event check-in',
    inviteIds: inviteIds || [],
    seatPool: [],
    seatPlanUpdatedAt: null,
    createdAt: now,
    updatedAt: now
  };
}

function newInviteId() {
  let id;
  do {
    id = crypto.randomBytes(5).toString('hex');
  } while (getInvite(id));
  return id;
}

function defaultInvite(title) {
  const now = new Date().toISOString();
  return {
    id: newInviteId(),
    title: title || 'Untitled invitation',
    createdAt: now,
    updatedAt: now,
    templateName: '',
    pageWidth: 612,
    pageHeight: 792,
    layout: null,
    names: [],
    baseUrl: '',
    invitees: [],
    rsvps: []
  };
}

function inviteDir(id) {
  return path.join(INVITES_DIR, id);
}

function templatePath(id) {
  return path.join(inviteDir(id), 'template.pdf');
}

function outputDir(id) {
  return path.join(inviteDir(id), 'output');
}

function ensureInviteDirs(id) {
  ensureDir(inviteDir(id));
  ensureDir(outputDir(id));
}

function isLocalBaseUrl(url) {
  return !url || /localhost|127\.0\.0\.1/i.test(url);
}

function normalizeBaseUrls() {
  const d = get();
  let changed = false;
  if (isLocalBaseUrl(d.settings.baseUrl)) {
    d.settings.baseUrl = DEFAULT_BASE_URL;
    changed = true;
  }
  for (const inv of d.invites || []) {
    if (isLocalBaseUrl(inv.baseUrl)) {
      inv.baseUrl = DEFAULT_BASE_URL;
      changed = true;
    }
  }
  if (changed) save();
}

function migrateLegacy(d) {
  if (d.invites && d.invites.length) return;

  const legacyTemplate = path.join(DATA_DIR, 'template.pdf');
  const legacyOutput = path.join(DATA_DIR, 'output');
  const hasLegacy = (d.settings && d.settings.templateName)
    || (d.invitees && d.invitees.length)
    || fs.existsSync(legacyTemplate);

  if (!hasLegacy) {
    d.invites = [];
    return;
  }

  const invite = defaultInvite(
    (d.settings && d.settings.templateName)
      ? d.settings.templateName.replace(/\.pdf$/i, '')
      : 'My invitation'
  );

  if (d.settings) {
    invite.templateName = d.settings.templateName || '';
    invite.pageWidth = d.settings.pageWidth || 612;
    invite.pageHeight = d.settings.pageHeight || 792;
    invite.layout = d.settings.layout || null;
    invite.names = d.settings.names || [];
    invite.baseUrl = d.settings.baseUrl || '';
  }
  invite.invitees = d.invitees || [];
  invite.rsvps = d.rsvps || [];

  ensureInviteDirs(invite.id);
  if (fs.existsSync(legacyTemplate)) {
    fs.copyFileSync(legacyTemplate, templatePath(invite.id));
  }
  if (fs.existsSync(legacyOutput)) {
    for (const f of fs.readdirSync(legacyOutput)) {
      const src = path.join(legacyOutput, f);
      const dest = path.join(outputDir(invite.id), f);
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, dest);
    }
  }

  d.invites = [invite];
  delete d.invitees;
  delete d.rsvps;
  if (d.settings) {
    d.settings = { baseUrl: d.settings.baseUrl || DEFAULT_BASE_URL };
  }
}

function load() {
  ensureDir(DATA_DIR);
  ensureDir(INVITES_DIR);
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db.settings = Object.assign({}, DEFAULT_DB.settings, db.settings || {});
      db.invites = db.invites || [];
      db.checkinEvents = db.checkinEvents || [];
      migrateLegacy(db);
    } catch (err) {
      console.error('[store] db.json was unreadable, starting fresh:', err.message);
      db = JSON.parse(JSON.stringify(DEFAULT_DB));
    }
  } else {
    db = JSON.parse(JSON.stringify(DEFAULT_DB));
    save();
  }
  normalizeBaseUrls();
  migrateSeatFields();
  return db;
}

function migrateSeatFields() {
  const d = get();
  let changed = false;
  for (const evt of d.checkinEvents || []) {
    if (!evt.seatPool) {
      if (Array.isArray(evt.seatPlan)) {
        evt.seatPool = evt.seatPlan;
      } else if (evt.seatPlan && typeof evt.seatPlan === 'object') {
        const pool = [];
        for (const val of Object.values(evt.seatPlan)) {
          if (Array.isArray(val)) pool.push(...val);
          else if (val) pool.push(String(val));
        }
        const seen = new Set();
        evt.seatPool = pool.map((s) => String(s).trim()).filter((s) => {
          const k = s.toLowerCase();
          if (!s || seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      } else {
        evt.seatPool = [];
      }
      delete evt.seatPlan;
      changed = true;
    }
  }
  for (const invite of d.invites || []) {
    for (const inv of invite.invitees || []) {
      if (inv.seatNumber != null && !inv.seatNumbers) {
        inv.seatNumbers = [String(inv.seatNumber)];
        delete inv.seatNumber;
        changed = true;
      }
    }
  }
  if (changed) save();
}

function parseSeatsText(raw) {
  if (raw == null || raw === '') return [];
  return String(raw)
    .split(/[,;|/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function formatSeats(seats) {
  if (!seats || !seats.length) return '';
  return seats.join(', ');
}

function inviteeSeats(inv) {
  if (inv.seatNumbers && inv.seatNumbers.length) return inv.seatNumbers;
  if (inv.seatNumber != null) return [String(inv.seatNumber)];
  return [];
}

function save() {
  ensureDir(DATA_DIR);
  fs.writeFileSync(TMP_FILE, JSON.stringify(db, null, 2));
  fs.renameSync(TMP_FILE, DB_FILE);
}

function get() {
  if (!db) load();
  return db;
}

function getSettings() {
  return get().settings;
}

function updateSettings(patch) {
  Object.assign(get().settings, patch);
  save();
  return get().settings;
}

function getInvites() {
  return get().invites;
}

function getInvite(id) {
  return get().invites.find((i) => i.id === id) || null;
}

function touchInvite(invite) {
  invite.updatedAt = new Date().toISOString();
}

function createInvite(title) {
  const invite = defaultInvite(title);
  get().invites.unshift(invite);
  ensureInviteDirs(invite.id);
  save();
  return invite;
}

function updateInvite(id, patch) {
  const invite = getInvite(id);
  if (!invite) return null;
  Object.assign(invite, patch);
  touchInvite(invite);
  save();
  return invite;
}

function deleteInvite(id) {
  const d = get();
  const idx = d.invites.findIndex((i) => i.id === id);
  if (idx < 0) return false;
  d.invites.splice(idx, 1);
  save();
  const dir = inviteDir(id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function previewGuestId(inviteId) {
  return 'pv' + inviteId.slice(0, 8);
}

function ensurePreviewGuest(invite) {
  if (invite.invitees.length && !invite.invitees.every((i) => i.preview)) {
    return invite.invitees.find((i) => !i.preview) || invite.invitees[0];
  }
  const id = previewGuestId(invite.id);
  let guest = invite.invitees.find((i) => i.id === id);
  if (!guest) {
    guest = {
      id,
      name: (invite.names && invite.names[0]) || 'Sample Guest',
      createdAt: new Date().toISOString(),
      pdfFile: '',
      preview: true,
      checkedIn: false,
      checkedInAt: null
    };
    invite.invitees.push(guest);
    touchInvite(invite);
    save();
  } else if (invite.names && invite.names[0] && guest.name !== invite.names[0]) {
    guest.name = invite.names[0];
    touchInvite(invite);
    save();
  }
  return guest;
}

function findInvitee(id) {
  for (const invite of get().invites) {
    const invitee = invite.invitees.find((i) => i.id === id);
    if (invitee) return { invite, invitee };
  }
  return null;
}

function getInvitee(id) {
  const found = findInvitee(id);
  return found ? found.invitee : null;
}

function replaceInvitees(inviteId, list) {
  const invite = getInvite(inviteId);
  if (!invite) return null;
  invite.invitees = list;
  touchInvite(invite);
  save();
  return invite.invitees;
}

function clearInviteBatch(inviteId) {
  const invite = getInvite(inviteId);
  if (!invite) return false;
  invite.invitees = [];
  invite.rsvps = [];
  touchInvite(invite);
  save();
  return true;
}

function setCheckedIn(id, value, opts) {
  const found = findInvitee(id);
  if (!found) return null;
  const options = opts || {};
  found.invitee.checkedIn = !!value;
  found.invitee.checkedInAt = value ? new Date().toISOString() : null;
  if (value) {
    if (options.seatNumbers) found.invitee.seatNumbers = options.seatNumbers;
    else if (options.seatNumber != null) found.invitee.seatNumbers = [String(options.seatNumber)];
    if (options.checkinEventId) found.invitee.checkinEventId = options.checkinEventId;
  } else {
    found.invitee.seatNumbers = null;
    found.invitee.seatNumber = null;
    found.invitee.checkinEventId = null;
  }
  touchInvite(found.invite);
  save();
  return found.invitee;
}

function getCheckinEvents() {
  return get().checkinEvents || [];
}

function getCheckinEvent(id) {
  return getCheckinEvents().find((e) => e.id === id) || null;
}

function touchCheckinEvent(evt) {
  evt.updatedAt = new Date().toISOString();
}

function createCheckinEvent(title, inviteIds) {
  const evt = defaultCheckinEvent(title, inviteIds);
  get().checkinEvents.unshift(evt);
  save();
  return evt;
}

function updateCheckinEvent(id, patch) {
  const evt = getCheckinEvent(id);
  if (!evt) return null;
  if (patch.title != null) evt.title = String(patch.title).trim() || evt.title;
  if (patch.inviteIds) evt.inviteIds = patch.inviteIds;
  touchCheckinEvent(evt);
  save();
  return evt;
}

function deleteCheckinEvent(id) {
  const d = get();
  const idx = d.checkinEvents.findIndex((e) => e.id === id);
  if (idx < 0) return false;
  d.checkinEvents.splice(idx, 1);
  save();
  return true;
}

function normalizeSeatKey(s) {
  return String(s).trim().toLowerCase();
}

function getUsedSeatsForEvent(eventId) {
  const evt = getCheckinEvent(eventId);
  if (!evt) return new Set();
  const used = new Set();
  for (const inviteId of evt.inviteIds || []) {
    const invite = getInvite(inviteId);
    if (!invite) continue;
    for (const inv of invite.invitees) {
      if (inv.checkedIn && inv.checkinEventId === eventId) {
        for (const s of inviteeSeats(inv)) used.add(normalizeSeatKey(s));
      }
    }
  }
  return used;
}

function getAvailableSeats(eventId) {
  const evt = getCheckinEvent(eventId);
  if (!evt || !evt.seatPool) return [];
  const used = getUsedSeatsForEvent(eventId);
  return evt.seatPool.filter((s) => !used.has(normalizeSeatKey(s)));
}

function seatPoolStats(eventId) {
  const evt = getCheckinEvent(eventId);
  const total = evt ? (evt.seatPool || []).length : 0;
  const used = getUsedSeatsForEvent(eventId).size;
  return { total, used, remaining: Math.max(0, total - used) };
}

function findCheckinEventForInvite(inviteId) {
  for (const evt of getCheckinEvents()) {
    if ((evt.inviteIds || []).includes(inviteId)) return evt;
  }
  return null;
}
function checkinEventSummary(evt) {
  let checkedIn = 0;
  for (const inviteId of evt.inviteIds || []) {
    const invite = getInvite(inviteId);
    if (!invite) continue;
    checkedIn += invite.invitees.filter((i) => !i.preview && i.checkedIn && i.checkinEventId === evt.id).length;
  }
  const stats = seatPoolStats(evt.id);
  return {
    id: evt.id,
    title: evt.title,
    inviteIds: evt.inviteIds || [],
    seatPoolCount: stats.total,
    seatsUsed: stats.used,
    seatsRemaining: stats.remaining,
    seatPlanUpdatedAt: evt.seatPlanUpdatedAt || null,
    checkedInCount: checkedIn,
    createdAt: evt.createdAt,
    updatedAt: evt.updatedAt
  };
}

function getSeatPlanRows(eventId) {
  const evt = getCheckinEvent(eventId);
  if (!evt) return [];
  return (evt.seatPool || []).map((seat, i) => ({
    seat,
    section: '',
    index: i + 1
  }));
}

function importSeatPlan(eventId, rows) {
  const evt = getCheckinEvent(eventId);
  if (!evt) return { error: 'Check-in event not found' };

  const pool = [];
  const seen = new Set();
  let skipped = 0;

  for (const row of rows) {
    const raw = row.seat || row.seats || row.name || '';
    const parts = parseSeatsText(raw);
    if (!parts.length) { skipped++; continue; }
    for (const seat of parts) {
      const k = normalizeSeatKey(seat);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      pool.push(String(seat).trim());
    }
  }

  if (!pool.length) return { error: 'No seat numbers found. Use one seat per row in the Seat Number column.' };

  evt.seatPool = pool;
  evt.seatPlanUpdatedAt = new Date().toISOString();
  touchCheckinEvent(evt);
  save();
  return { ok: true, count: pool.length, skipped };
}

function allocateSeatsFromPool(eventId, count) {
  const n = Math.max(1, parseInt(count, 10) || 1);
  const available = getAvailableSeats(eventId);
  if (!available.length) return { error: 'No seats left in the pool.' };
  if (available.length < n) {
    return { error: `Only ${available.length} seat(s) remaining — cannot assign ${n}.` };
  }
  return { seats: available.slice(0, n) };
}

function guestsForInviteIds(inviteIds, eventId) {
  const rows = [];
  for (const inviteId of inviteIds || []) {
    const invite = getInvite(inviteId);
    if (!invite) continue;
    for (const inv of invite.invitees) {
      if (inv.preview) continue;
      const r = invite.rsvps.find((x) => x.inviteeId === inv.id);
      rows.push({
        inviteId: invite.id,
        inviteTitle: invite.title,
        id: inv.id,
        name: inv.name,
        status: r ? r.status : 'Pending',
        checkedIn: !!inv.checkedIn,
        checkedInAt: inv.checkedInAt || '',
        seatNumbers: inviteeSeats(inv),
        checkinEventId: inv.checkinEventId || null
      });
    }
  }
  return rows;
}

function searchCheckinGuests(inviteIds, query, eventId) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  return guestsForInviteIds(inviteIds, eventId).filter((g) =>
    g.id.toLowerCase().includes(q) || g.name.toLowerCase().includes(q)
  ).slice(0, 20);
}

function seatSortKey(seats) {
  if (!seats || !seats.length) return 999999;
  const n = parseInt(String(seats[0]).replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : 999999;
}

function checkInGuest(inviteeId, eventId, seatCount) {
  const found = findInvitee(inviteeId);
  if (!found) return { error: 'Guest not found' };
  const evt = getCheckinEvent(eventId);
  if (!evt) return { error: 'Check-in event not found' };
  if (!(evt.inviteIds || []).includes(found.invite.id)) {
    return { error: 'Guest is not part of this check-in event' };
  }

  if (!evt.seatPool || !evt.seatPool.length) {
    return { error: 'Upload a seat pool Excel file first (list of available seats, not guest names).' };
  }

  if (found.invitee.checkedIn && found.invitee.checkinEventId === eventId) {
    return {
      ok: true,
      already: true,
      invitee: found.invitee,
      inviteTitle: found.invite.title,
      seatNumbers: inviteeSeats(found.invitee)
    };
  }

  const alloc = allocateSeatsFromPool(eventId, seatCount || 1);
  if (alloc.error) return { error: alloc.error };

  setCheckedIn(inviteeId, true, { seatNumbers: alloc.seats, checkinEventId: eventId });

  const updated = getInvitee(inviteeId);
  return {
    ok: true,
    already: false,
    invitee: updated,
    inviteTitle: found.invite.title,
    seatNumbers: inviteeSeats(updated),
    seatsRemaining: seatPoolStats(eventId).remaining
  };
}

function getCheckinRows(eventId) {
  const evt = getCheckinEvent(eventId);
  if (!evt) return [];
  return guestsForInviteIds(evt.inviteIds, eventId)
    .filter((g) => g.checkedIn && g.checkinEventId === eventId)
    .sort((a, b) => seatSortKey(a.seatNumbers) - seatSortKey(b.seatNumbers) || a.name.localeCompare(b.name));
}

function undoCheckin(inviteeId, eventId) {
  const found = findInvitee(inviteeId);
  if (!found) return { error: 'Guest not found' };
  if (!found.invitee.checkedIn || found.invitee.checkinEventId !== eventId) {
    return { error: 'Guest is not checked in for this event' };
  }
  setCheckedIn(inviteeId, false);
  return { ok: true };
}

function getRsvp(inviteId, inviteeId) {
  const invite = getInvite(inviteId);
  if (!invite) return null;
  return invite.rsvps.find((r) => r.inviteeId === inviteeId) || null;
}

function upsertRsvp(inviteeId, status, comments) {
  const found = findInvitee(inviteeId);
  if (!found) return null;
  const invite = found.invite;
  let r = invite.rsvps.find((x) => x.inviteeId === inviteeId);
  if (!r) {
    r = { inviteeId, status, comments: comments || '', respondedAt: new Date().toISOString() };
    invite.rsvps.push(r);
  } else {
    r.status = status;
    r.comments = comments || '';
    r.respondedAt = new Date().toISOString();
  }
  touchInvite(invite);
  save();
  return r;
}

function getRsvpRows(inviteId) {
  const invite = getInvite(inviteId);
  if (!invite) return [];
  return invite.invitees.map((inv) => {
    const r = invite.rsvps.find((x) => x.inviteeId === inv.id);
    return {
      name: inv.name,
      id: inv.id,
      status: r ? r.status : 'Pending',
      respondedAt: r ? r.respondedAt : '',
      comments: r ? r.comments : '',
      checkedIn: inv.checkedIn ? 'Yes' : 'No',
      checkedInAt: inv.checkedInAt || '',
      seatNumbers: formatSeats(inviteeSeats(inv))
    };
  });
}

function inviteSummary(invite) {
  const yes = invite.rsvps.filter((r) => r.status === 'Yes').length;
  return {
    id: invite.id,
    title: invite.title,
    createdAt: invite.createdAt,
    updatedAt: invite.updatedAt,
    templateName: invite.templateName,
    nameCount: (invite.names || []).length,
    generatedCount: (invite.invitees || []).filter((i) => !i.preview).length,
    rsvpYes: yes
  };
}

module.exports = {
  DATA_DIR,
  INVITES_DIR,
  DEFAULT_BASE_URL,
  load,
  save,
  inviteDir,
  templatePath,
  outputDir,
  ensureInviteDirs,
  getSettings,
  updateSettings,
  getInvites,
  getInvite,
  createInvite,
  updateInvite,
  deleteInvite,
  ensurePreviewGuest,
  previewGuestId,
  getInvitee,
  findInvitee,
  replaceInvitees,
  clearInviteBatch,
  setCheckedIn,
  getCheckinEvents,
  getCheckinEvent,
  createCheckinEvent,
  updateCheckinEvent,
  deleteCheckinEvent,
  checkinEventSummary,
  searchCheckinGuests,
  checkInGuest,
  getCheckinRows,
  getSeatPlanRows,
  importSeatPlan,
  allocateSeatsFromPool,
  getAvailableSeats,
  seatPoolStats,
  findCheckinEventForInvite,
  formatSeats,
  inviteeSeats,
  guestsForInviteIds,
  undoCheckin,
  getRsvp,
  upsertRsvp,
  getRsvpRows,
  inviteSummary
};
