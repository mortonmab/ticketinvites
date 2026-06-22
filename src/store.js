'use strict';

/**
 * A tiny, dependency-free, file-backed JSON store.
 *
 * Everything lives in one JSON file (data/db.json) that is written
 * atomically (write to a temp file, then rename) so a crash mid-write
 * can never corrupt the database. This keeps the whole app install-anywhere
 * with no native build step. For an event with hundreds — even a few
 * thousand — invitees this is more than fast enough.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TMP_FILE = path.join(DATA_DIR, 'db.json.tmp');

const DEFAULT_DB = {
  // Persisted admin configuration.
  settings: {
    baseUrl: '',          // public URL where this app is reachable (bakes into QR/RSVP links)
    templateName: '',     // original filename of the uploaded template
    pageWidth: 612,       // points
    pageHeight: 792,      // points
    layout: null          // positions of name / qr / rsvp elements
  },
  // One record per generated invitee.
  // { id, name, createdAt, pdfFile, checkedIn, checkedInAt }
  invitees: [],
  // RSVP responses keyed inline. { inviteeId, status, comments, respondedAt }
  rsvps: []
};

let db = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDir();
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      // Merge in any new default keys without clobbering existing data.
      db.settings = Object.assign({}, DEFAULT_DB.settings, db.settings || {});
      db.invitees = db.invitees || [];
      db.rsvps = db.rsvps || [];
    } catch (err) {
      console.error('[store] db.json was unreadable, starting fresh:', err.message);
      db = JSON.parse(JSON.stringify(DEFAULT_DB));
    }
  } else {
    db = JSON.parse(JSON.stringify(DEFAULT_DB));
    save();
  }
  return db;
}

function save() {
  ensureDir();
  fs.writeFileSync(TMP_FILE, JSON.stringify(db, null, 2));
  fs.renameSync(TMP_FILE, DB_FILE); // atomic on the same filesystem
}

function get() {
  if (!db) load();
  return db;
}

// ---- settings -------------------------------------------------------------

function getSettings() {
  return get().settings;
}

function updateSettings(patch) {
  Object.assign(get().settings, patch);
  save();
  return get().settings;
}

// ---- invitees -------------------------------------------------------------

function getInvitees() {
  return get().invitees;
}

function getInvitee(id) {
  return get().invitees.find((i) => i.id === id) || null;
}

function replaceInvitees(list) {
  get().invitees = list;
  save();
}

function clearAll() {
  const d = get();
  d.invitees = [];
  d.rsvps = [];
  save();
}

function setCheckedIn(id, value) {
  const inv = getInvitee(id);
  if (!inv) return null;
  inv.checkedIn = !!value;
  inv.checkedInAt = value ? new Date().toISOString() : null;
  save();
  return inv;
}

// ---- rsvps ----------------------------------------------------------------

function getRsvp(inviteeId) {
  return get().rsvps.find((r) => r.inviteeId === inviteeId) || null;
}

function upsertRsvp(inviteeId, status, comments) {
  const d = get();
  let r = d.rsvps.find((x) => x.inviteeId === inviteeId);
  if (!r) {
    r = { inviteeId, status, comments: comments || '', respondedAt: new Date().toISOString() };
    d.rsvps.push(r);
  } else {
    r.status = status;
    r.comments = comments || '';
    r.respondedAt = new Date().toISOString();
  }
  save();
  return r;
}

function getRsvpRows() {
  const d = get();
  return d.invitees.map((inv) => {
    const r = d.rsvps.find((x) => x.inviteeId === inv.id);
    return {
      name: inv.name,
      id: inv.id,
      status: r ? r.status : 'Pending',
      respondedAt: r ? r.respondedAt : '',
      comments: r ? r.comments : '',
      checkedIn: inv.checkedIn ? 'Yes' : 'No',
      checkedInAt: inv.checkedInAt || ''
    };
  });
}

module.exports = {
  DATA_DIR,
  load,
  save,
  getSettings,
  updateSettings,
  getInvitees,
  getInvitee,
  replaceInvitees,
  clearAll,
  setCheckedIn,
  getRsvp,
  upsertRsvp,
  getRsvpRows
};
