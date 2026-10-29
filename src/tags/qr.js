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

/** One card with its top-left corner at (x, y). */
function drawCard(doc, tag, qr, x, y) {
  const W = CARD_W; const H = CARD_H;
  doc.save().translate(x, y);
  doc.rect(0, 0, W, H).fill('#ffffff');
  doc.roundedRect(8, 8, W - 16, H - 16, 14).lineWidth(2).stroke(GREEN);
  doc.save().roundedRect(8, 8, W - 16, 52, 14).clip().rect(8, 8, W - 16, 52).fill(GREEN).restore();
  if (fs.existsSync(LOGO)) doc.image(LOGO, 20, 16, { width: 36, height: 36 });
  doc.fill('#ffffff').font('b').fontSize(17).text('GaadiPe Tag', 64, 20, { lineBreak: false });
  doc.font('r').fontSize(8.5).text('Contact the owner · numbers stay private', 64, 41, { lineBreak: false });

  doc.fill('#0d1f1a').font('b').fontSize(13).text('Need to reach this vehicle’s owner?', 16, 74, { width: W - 32, align: 'center' });
  const q = 190;
  doc.image(qr, (W - q) / 2, 100, { width: q, height: q });
  doc.font('b').fontSize(12).fill(GREEN).text('Scan → WhatsApp the owner', 16, 298, { width: W - 32, align: 'center', lineBreak: false });
  doc.font('r').fontSize(8.5).fill('#41514e')
    .text('Blocking? Lights on? Window open? Being towed? Tell the owner in one tap. Your number is never shown.',
      24, 316, { width: W - 48, align: 'center' });
  doc.roundedRect(40, 352, W - 80, 30, 8).fill('#eef6f2');
  doc.fill('#0d1f1a').font('b').fontSize(12).text(`${T.masked(tag.reg_no)}   ·   Tag ${tag.code}`, 40, 361, { width: W - 80, align: 'center', lineBreak: false });
  doc.font('r').fontSize(7.5).fill('#6b7c78')
    .text(`No camera? WhatsApp “TAG ${tag.code}” to GaadiPe · gaadipe.in`, 16, 392, { width: W - 32, align: 'center', lineBreak: false });
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
  const file = path.join(DIR, `GaadiPe-Tag-${tag.code}.pdf`);
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
  // A4 is 595 × 842 pt; two A6 cards side by side are 596 wide, so they sit edge to edge with no margin to lose.
  const slots = [[0, 0], [CARD_W - 1, 0], [0, CARD_H + 1], [CARD_W - 1, CARD_H + 1]];
  cards.forEach((t, i) => {
    if (i % 4 === 0) {
      doc.addPage();
      // Cut lines, light grey and dashed, between the four cards.
      doc.save().lineWidth(0.5).dash(4, { space: 4 }).strokeColor('#b8c4c0')
        .moveTo(CARD_W - 0.5, 0).lineTo(CARD_W - 0.5, 842).stroke()
        .moveTo(0, CARD_H + 0.5).lineTo(595, CARD_H + 0.5).stroke().undash().restore();
    }
    const [x, y] = slots[i % 4];
    drawCard(doc, t, qrs.get(t.code), x, y);
  });
  return write(doc, file);
}

module.exports = { cardPdf, sheetPdf, DIR };
