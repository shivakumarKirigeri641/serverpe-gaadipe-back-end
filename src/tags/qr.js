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

/*
 * A4 PRINT SHEETS, two sizes (user, 2026-10-29: "4 stickers per sheet — don't you think it's big?"):
 *   small  9 a sheet (3 × 3), each ~6.1 × 8.6 cm, QR ~4 cm — bikes, scooters, side glass, most cars (the default)
 *   large  4 a sheet (2 × 2), each ~9.8 × 13.8 cm — a big rear windscreen
 * SAFE MARGINS FOR HOME PRINTERS (TeQuiero matte vinyl, 21 × 29 cm): nothing within ~5 mm of the sides or ~9 mm of the
 * top and bottom, so nothing is lost at the printer's edge. Dashed cut lines run through the gaps.
 */
const SIZES = { small: { cols: 3, rows: 3 }, large: { cols: 2, rows: 2 } };

async function sheetPdf(tags, { copies = 2, size = 'small' } = {}) {
  fs.mkdirSync(DIR, { recursive: true });
  const L = SIZES[size] || SIZES.small;
  const n = Math.max(1, Math.min(9, Number(copies) || 2));
  const cards = tags.flatMap((t) => Array(n).fill(t));
  const file = path.join(DIR, `GaadiPe-Tags-${tags.map((t) => t.code).join('-').slice(0, 60)}-x${n}-${size === 'large' ? 'large' : 'small'}.pdf`);
  const doc = newDoc('A4', 'GaadiPe Tags — print sheet');
  const qrs = new Map();
  for (const t of tags) qrs.set(t.code, await qrOf(t.code));

  const gap = 10; const maxW = 595 - 2 * 16; const maxH = 822 - 2 * 26;   // printable area on a 21 × 29 cm sheet
  const S = Math.min((maxW - (L.cols - 1) * gap) / (L.cols * CARD_W), (maxH - (L.rows - 1) * gap) / (L.rows * CARD_H));
  const cw = CARD_W * S; const ch = CARD_H * S;
  const ox = (595 - (L.cols * cw + (L.cols - 1) * gap)) / 2; const oy = (822 - (L.rows * ch + (L.rows - 1) * gap)) / 2;
  const per = L.cols * L.rows;
  cards.forEach((t, i) => {
    if (i % per === 0) {
      doc.addPage();
      const dash = doc.save().lineWidth(0.5).dash(4, { space: 4 }).strokeColor('#b8c4c0');
      for (let c = 1; c < L.cols; c += 1) {
        const x = ox + c * cw + (c - 0.5) * gap;
        dash.moveTo(x, oy - 6).lineTo(x, oy + L.rows * ch + (L.rows - 1) * gap + 6).stroke();
      }
      for (let r = 1; r < L.rows; r += 1) {
        const y = oy + r * ch + (r - 0.5) * gap;
        dash.moveTo(ox - 6, y).lineTo(ox + L.cols * cw + (L.cols - 1) * gap + 6, y).stroke();
      }
      dash.undash().restore();
    }
    const k = i % per;
    const x = ox + (k % L.cols) * (cw + gap); const y = oy + Math.floor(k / L.cols) * (ch + gap);
    doc.save().translate(x, y).scale(S);
    drawCard(doc, t, qrs.get(t.code), 0, 0);
    doc.restore();
  });
  return write(doc, file);
}

module.exports = { cardPdf, sheetPdf, DIR };
