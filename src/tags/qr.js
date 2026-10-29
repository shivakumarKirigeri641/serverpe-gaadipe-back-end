/**
 * src/tags/qr.js — THE PRINTED TAG (user, 2026-10-29: free digital + paid delivered; "give me the stickers in PDF, I will
 * print and attach"). A card: the QR (our own /t/<code> link, which opens WhatsApp), what to do with it, the masked vehicle
 * number and the tag code. Stuck on the rear windscreen or a side window — never where it blocks the driver's view.
 *
 *   cardPdf(tag)                      one card, A6 (105 × 148 mm) — what the owner gets on WhatsApp
 *   sheetPdf(tags, { copies = 2 })    A4 sheets, four A6 cards to a page, each tag `copies` times, light cut lines —
 *                                     for printing on A4 sticker paper (two per car: rear windscreen + a side window)
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const T = require('./tags');

const DIR = path.join(__dirname, '..', 'uploads', 'tags');
const FONT = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans-Regular.ttf');
const BOLD = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');
const LOGO = path.join(__dirname, '..', 'images', 'icon-256.png');
const GREEN = '#0b6b4f';
const CARD_W = 298;   // A6 in points (105 × 148 mm)
const CARD_H = 420;

const qrOf = (code) => QRCode.toBuffer(T.tagUrl(code), { errorCorrectionLevel: 'H', margin: 1, width: 900, color: { dark: '#0d1f1a', light: '#ffffff' } });

/**
 * One card with its top-left corner at (x, y). THE LAYOUT (user, 2026-10-29: "logo at the centre of the QR; at the top
 * the vehicle number and tag id, footer gaadipe.in; one simple reason, bigger, so a stranger finds it and scans"):
 *   top band   the vehicle number (in full — the plate beside it shows it anyway, and a copied sticker on another
 *              vehicle is then plain to see) and the tag id
 *   headline   "Is this vehicle blocking you?" — the one reason everyone understands
 *   the QR     with the GaadiPe logo in its centre (error correction H keeps it scannable)
 *   footer     gaadipe.in
 */
function drawCard(doc, tag, qr, x, y) {
  const W = CARD_W; const H = CARD_H;
  const reg = String(tag.reg_no || '').toUpperCase();
  doc.save().translate(x, y);
  doc.rect(0, 0, W, H).fill('#ffffff');
  doc.roundedRect(8, 8, W - 16, H - 16, 14).lineWidth(2).stroke(GREEN);

  // Top band: the vehicle number, and the tag id
  doc.save().roundedRect(8, 8, W - 16, 50, 14).clip().rect(8, 8, W - 16, 50).fill(GREEN).restore();
  doc.fill('#ffffff').font('b').fontSize(reg.length > 10 ? 18 : 20).text(reg, 22, 22, { lineBreak: false });
  doc.roundedRect(W - 108, 20, 86, 26, 13).fill('#ffffff');
  doc.fill(GREEN).font('b').fontSize(10.5).text(`TAG ${tag.code}`, W - 108, 28, { width: 86, align: 'center', lineBreak: false });

  // The one reason, big
  doc.fill('#0d1f1a').font('b').fontSize(19).text('Is this vehicle', 16, 70, { width: W - 32, align: 'center', lineBreak: false });
  doc.fill('#c0392b').font('b').fontSize(19).text('blocking you?', 16, 92, { width: W - 32, align: 'center', lineBreak: false });

  // The QR, with the GaadiPe logo in its centre
  const q = 192; const qx = (W - q) / 2; const qy = 122;
  doc.image(qr, qx, qy, { width: q, height: q });
  if (fs.existsSync(LOGO)) {
    const l = 46; const lx = qx + (q - l) / 2; const ly = qy + (q - l) / 2;
    doc.roundedRect(lx - 4, ly - 4, l + 8, l + 8, 9).fill('#ffffff');
    doc.image(LOGO, lx, ly, { width: l, height: l });
  }

  doc.fill(GREEN).font('b').fontSize(13).text('Scan to message the owner', 16, 322, { width: W - 32, align: 'center', lineBreak: false });
  doc.fill('#41514e').font('r').fontSize(9).text('on WhatsApp · your number stays private', 16, 341, { width: W - 32, align: 'center', lineBreak: false });

  // Footer: the site, who runs it (user, 2026-10-29: "Powered by: ServerPe App Solutions"), and the no-camera way in
  doc.moveTo(40, 362).lineTo(W - 40, 362).lineWidth(0.6).stroke('#d5e3dd');
  doc.fill('#0d1f1a').font('b').fontSize(14).text('gaadipe.in', 16, 368, { width: W - 32, align: 'center', lineBreak: false });
  doc.fill('#41514e').font('r').fontSize(7.5).text('Powered by: ServerPe App Solutions', 16, 386, { width: W - 32, align: 'center', lineBreak: false });
  doc.fill('#8a9a96').font('r').fontSize(6.5).text(`No camera? WhatsApp “TAG ${tag.code}” to GaadiPe`, 16, 398, { width: W - 32, align: 'center', lineBreak: false });
  doc.restore();
}

function newDoc(size, title) {
  const doc = new PDFDocument({ size, margin: 0, autoFirstPage: false, info: { Title: title, Author: 'GaadiPe' } });
  doc.registerFont('r', FONT); doc.registerFont('b', BOLD);
  return doc;
}
async function write(doc, file) {
  const out = fs.createWriteStream(file);
  doc.pipe(out);
  doc.end();
  await new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
  return file;
}

async function cardPdf(tag) {
  fs.mkdirSync(DIR, { recursive: true });
  // -v3: the redesigned card with "Powered by" (2026-10-29) — files of earlier designs are never served again.
  const file = path.join(DIR, `GaadiPe-Tag-${tag.code}-v3.pdf`);
  if (fs.existsSync(file)) return file;
  const doc = newDoc([CARD_W, CARD_H], `GaadiPe Tag ${tag.code}`);
  doc.addPage();
  drawCard(doc, tag, await qrOf(tag.code), 0, 0);
  return write(doc, file);
}

/** A4 print sheets: four cards to a page (2 × 2), each tag `copies` times, with light cut lines. */
async function sheetPdf(tags, { copies = 2 } = {}) {
  fs.mkdirSync(DIR, { recursive: true });
  const n = Math.max(1, Math.min(4, Number(copies) || 2));
  const cards = tags.flatMap((t) => Array(n).fill(t));
  const file = path.join(DIR, `GaadiPe-Tags-${tags.map((t) => t.code).join('-').slice(0, 60)}-x${n}.pdf`);
  const doc = newDoc('A4', 'GaadiPe Tags — print sheet');
  const qrs = new Map();
  for (const t of tags) qrs.set(t.code, await qrOf(t.code));
  /* SAFE MARGINS FOR HOME PRINTERS (user, 2026-10-29: TeQuiero matte vinyl, 21 × 29 cm). A home printer cannot print to
     the edge (3–6 mm lost) and that sheet is 7 mm shorter than A4, so the four cards are drawn at 93% with ~5 mm at the
     sides and ~9 mm at the top and bottom — everything lands on the paper. Cut along the dashed lines. */
  const S = 0.93;
  const cw = CARD_W * S; const ch = CARD_H * S; const gap = 10;
  const ox = (595 - (2 * cw + gap)) / 2; const oy = (842 - (2 * ch + gap)) / 2;
  const slots = [[ox, oy], [ox + cw + gap, oy], [ox, oy + ch + gap], [ox + cw + gap, oy + ch + gap]];
  cards.forEach((t, i) => {
    if (i % 4 === 0) {
      doc.addPage();
      // Cut lines, light grey and dashed, through the gaps between the four cards.
      doc.save().lineWidth(0.5).dash(4, { space: 4 }).strokeColor('#b8c4c0')
        .moveTo(ox + cw + gap / 2, oy - 6).lineTo(ox + cw + gap / 2, oy + 2 * ch + gap + 6).stroke()
        .moveTo(ox - 6, oy + ch + gap / 2).lineTo(ox + 2 * cw + gap + 6, oy + ch + gap / 2).stroke().undash().restore();
    }
    const [x, y] = slots[i % 4];
    doc.save().translate(x, y).scale(S);
    drawCard(doc, t, qrs.get(t.code), 0, 0);
    doc.restore();
  });
  return write(doc, file);
}

module.exports = { cardPdf, sheetPdf, DIR };
