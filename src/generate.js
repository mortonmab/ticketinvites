'use strict';

const fs = require('fs');
const path = require('path');
const {
  PDFDocument,
  StandardFonts,
  rgb,
  PDFName,
  PDFString
} = require('pdf-lib');
const QRCode = require('qrcode');
const fontkit = require('@pdf-lib/fontkit');

// Map the admin's font choice to a pdf-lib standard font.
// Standard fonts need no embedding and keep generated files small.
const FONT_MAP = {
  'Times': StandardFonts.TimesRoman,
  'Times-Bold': StandardFonts.TimesRomanBold,
  'Times-Italic': StandardFonts.TimesRomanItalic,
  'Times-BoldItalic': StandardFonts.TimesRomanBoldItalic,
  'Helvetica': StandardFonts.Helvetica,
  'Helvetica-Bold': StandardFonts.HelveticaBold,
  'Helvetica-Italic': StandardFonts.HelveticaOblique,
  'Helvetica-BoldItalic': StandardFonts.HelveticaBoldOblique,
  'Courier': StandardFonts.Courier,
  'Courier-Bold': StandardFonts.CourierBold
};

// Elegant invitation script (Great Vibes) — closest match to the template style.
const CUSTOM_FONT_FILES = {
  'Invitation-Script': path.join(__dirname, '..', 'fonts', 'GreatVibes-Regular.ttf')
};
const customFontBytes = new Map();
for (const [key, filePath] of Object.entries(CUSTOM_FONT_FILES)) {
  customFontBytes.set(key, fs.readFileSync(filePath));
}

function hexToRgb(hex) {
  if (!hex) return rgb(0, 0, 0);
  const m = String(hex).replace('#', '').trim();
  const n = m.length === 3
    ? m.split('').map((c) => c + c).join('')
    : m.padEnd(6, '0').slice(0, 6);
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  return rgb(
    Number.isFinite(r) ? r : 0,
    Number.isFinite(g) ? g : 0,
    Number.isFinite(b) ? b : 0
  );
}

// Standard PDF fonts use WinAnsi encoding. Fold accented Latin characters
// down to plain ASCII so names like "José" or "Tendaí" render instead of
// throwing. Anything still unrepresentable becomes a space.
function sanitizeForStandardFont(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatInviteeName(name, preserveUnicode = false) {
  const clean = preserveUnicode
    ? (String(name || '').trim() || 'Guest')
    : (sanitizeForStandardFont(name) || 'Guest');
  return `Dear ${clean}`;
}

async function resolveNameFont(doc, fontKey) {
  const customBytes = customFontBytes.get(fontKey);
  if (customBytes) {
    return { font: await doc.embedFont(customBytes), useUnicode: true, isScript: true };
  }
  const fontName = FONT_MAP[fontKey] || StandardFonts.TimesRoman;
  return { font: await doc.embedFont(fontName), useUnicode: false, isScript: false };
}
function fitFontSize(font, text, requestedSize, maxWidth) {
  let size = requestedSize;
  while (size > 6 && font.widthOfTextAtSize(text, size) > maxWidth) {
    size -= 0.5;
  }
  return size;
}

function addLinkAnnotation(doc, page, rect, url) {
  const annot = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: rect, // [x1, y1, x2, y2] in PDF points
    Border: [0, 0, 0],
    A: doc.context.obj({
      Type: 'Action',
      S: 'URI',
      URI: PDFString.of(url)
    })
  });
  const ref = doc.context.register(annot);
  const existing = page.node.Annots();
  if (existing) {
    existing.push(ref);
  } else {
    page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
  }
}

/**
 * Generate one personalized invitation PDF.
 *
 * @param {Object} opts
 * @param {Buffer|Uint8Array} opts.templateBytes - the uploaded template PDF
 * @param {string} opts.name        - invitee display name
 * @param {string} opts.id          - unique invitee id
 * @param {string} opts.baseUrl     - public base url (for QR + RSVP links)
 * @param {Object} opts.layout      - normalized element positions
 * @returns {Promise<Uint8Array>}
 */
async function generateInvitation(opts) {
  const { templateBytes, name, id, baseUrl, layout } = opts;

  const doc = await PDFDocument.load(templateBytes);
  doc.registerFontkit(fontkit);
  const page = doc.getPages()[0];
  const { width: W, height: H } = page.getSize();

  // ---- Invitee name ----
  if (layout && layout.name) {
    const n = layout.name;
    const { font, useUnicode, isScript } = await resolveNameFont(doc, n.fontKey);
    const text = formatInviteeName(name, useUnicode);

    const boxLeft = n.x * W;
    const boxWidth = n.w * W;
    const boxTopFromTop = n.y * H;
    const boxHeight = n.h * H;

    const size = fitFontSize(font, text, n.fontSize || 24, boxWidth);
    const textWidth = font.widthOfTextAtSize(text, size);

    let textX;
    if (n.align === 'left') textX = boxLeft;
    else if (n.align === 'right') textX = boxLeft + boxWidth - textWidth;
    else textX = boxLeft + (boxWidth - textWidth) / 2; // center

    // Vertically center the text band within the box.
    const boxCenterYFromTop = boxTopFromTop + boxHeight / 2;
    const boxCenterYpdf = H - boxCenterYFromTop;
    const baselineY = boxCenterYpdf - size * (isScript ? 0.38 : 0.32);

    page.drawText(text, {
      x: textX,
      y: baselineY,
      size,
      font,
      color: hexToRgb(n.color || '#1a1a1a')
    });
  }

  // ---- QR code ----
  if (layout && layout.qr) {
    const q = layout.qr;
    const sizePt = q.size * W; // size is a fraction of page width
    const leftPt = q.x * W;
    const topFromTop = q.y * H;
    const bottomYpdf = H - (topFromTop + sizePt);

    const qrUrl = `${baseUrl.replace(/\/$/, '')}/v/${id}`;
    // Render the QR larger than needed, then place it scaled down for sharpness.
    const pngBuffer = await QRCode.toBuffer(qrUrl, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: Math.max(256, Math.round(sizePt * 4)),
      color: { dark: '#000000ff', light: '#ffffffff' }
    });
    const qrImage = await doc.embedPng(pngBuffer);
    page.drawImage(qrImage, {
      x: leftPt,
      y: bottomYpdf,
      width: sizePt,
      height: sizePt
    });
  }

  // ---- RSVP button (clickable link) ----
  if (layout && layout.rsvp && layout.rsvp.enabled) {
    const r = layout.rsvp;
    const boxLeft = r.x * W;
    const boxWidth = r.w * W;
    const boxTopFromTop = r.y * H;
    const boxHeight = r.h * H;
    const bottomYpdf = H - (boxTopFromTop + boxHeight);

    // Button fill
    page.drawRectangle({
      x: boxLeft,
      y: bottomYpdf,
      width: boxWidth,
      height: boxHeight,
      color: hexToRgb(r.bg || '#b8860b')
    });

    const label = sanitizeForStandardFont(r.label || 'RSVP HERE') || 'RSVP HERE';
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const labelSize = fitFontSize(font, label, r.fontSize || 14, boxWidth - 10);
    const labelWidth = font.widthOfTextAtSize(label, labelSize);
    page.drawText(label, {
      x: boxLeft + (boxWidth - labelWidth) / 2,
      y: bottomYpdf + boxHeight / 2 - labelSize * 0.32,
      size: labelSize,
      font,
      color: hexToRgb(r.fg || '#ffffff')
    });

    const rsvpUrl = `${baseUrl.replace(/\/$/, '')}/r/${id}`;
    addLinkAnnotation(doc, page, [boxLeft, bottomYpdf, boxLeft + boxWidth, bottomYpdf + boxHeight], rsvpUrl);
  }

  return doc.save();
}

module.exports = { generateInvitation, sanitizeForStandardFont };
