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
  invites: []
};

let db = null;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
  return db;
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

function setCheckedIn(id, value) {
  const found = findInvitee(id);
  if (!found) return null;
  found.invitee.checkedIn = !!value;
  found.invitee.checkedInAt = value ? new Date().toISOString() : null;
  touchInvite(found.invite);
  save();
  return found.invitee;
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
      checkedInAt: inv.checkedInAt || ''
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
  getRsvp,
  upsertRsvp,
  getRsvpRows,
  inviteSummary
};
