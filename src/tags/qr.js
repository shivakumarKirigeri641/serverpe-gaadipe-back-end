/**
 * src/tags/qr.js — THE DIGITAL TAG (user, 2026-10-29: free digital + paid delivered). A print-ready PDF card: the QR
 * (our own /t/<code> link, which opens WhatsApp), what to do with it, the masked vehicle number and the tag code. The
 * owner prints it at any shop and puts it on the rear windscreen or a side window — never where it blocks the view.
 *
 *   cardPdf(tag)  -> the file path (made once per code, then reused)
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

async function cardPdf(tag) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `GaadiPe-Tag-${tag.code}.pdf`);
  if (fs.existsSync(file)) return file;

  const qr = await QRCode.toBuffer(T.tagUrl(tag.code), { errorCorrectionLevel: 'H', margin: 1, width: 900, color: { dark: '#0d1f1a', light: '#ffffff' } });
  // A6 portrait (105 × 148 mm): prints well on its own, or four to an A4 sheet.
  const W = 298; const H = 420;
  const doc = new PDFDocument({ size: [W, H], margin: 0, info: { Title: `GaadiPe Tag ${tag.code}`, Author: 'GaadiPe' } });
  doc.registerFont('r', FONT); doc.registerFont('b', BOLD);
  const out = fs.createWriteStream(file);
  doc.pipe(out);

  doc.rect(0, 0, W, H).fill('#ffffff');
  doc.roundedRect(8, 8, W - 16, H - 16, 14).lineWidth(2).stroke(GREEN);
  // Brand band
  doc.save().roundedRect(8, 8, W - 16, 52, 14).clip().rect(8, 8, W - 16, 52).fill(GREEN).restore();
  if (fs.existsSync(LOGO)) doc.image(LOGO, 20, 16, { width: 36, height: 36 });
  doc.fill('#ffffff').font('b').fontSize(17).text('GaadiPe Tag', 64, 20);
  doc.font('r').fontSize(8.5).text('Contact the owner · numbers stay private', 64, 41);

  doc.fill('#0d1f1a').font('b').fontSize(13).text('Need to reach this vehicle’s owner?', 16, 74, { width: W - 32, align: 'center' });
  // The QR, large and centred
  const q = 190;
  doc.image(qr, (W - q) / 2, 100, { width: q, height: q });
  doc.font('b').fontSize(12).fill(GREEN).text('Scan → WhatsApp the owner', 16, 298, { width: W - 32, align: 'center', lineBreak: false });
  doc.font('r').fontSize(8.5).fill('#41514e')
    .text('Blocking? Lights on? Window open? Being towed? Tell the owner in one tap. Your number is never shown.',
      24, 316, { width: W - 48, align: 'center' });
  // The vehicle (masked) and the tag code, for anyone who cannot scan
  doc.roundedRect(40, 352, W - 80, 30, 8).fill('#eef6f2');
  doc.fill('#0d1f1a').font('b').fontSize(12).text(`${T.masked(tag.reg_no)}   ·   Tag ${tag.code}`, 40, 361, { width: W - 80, align: 'center' });
  doc.font('r').fontSize(7.5).fill('#6b7c78')
    .text(`No camera? WhatsApp “TAG ${tag.code}” to GaadiPe · gaadipe.in`, 16, 392, { width: W - 32, align: 'center' });

  doc.end();
  await new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
  return file;
}

module.exports = { cardPdf, DIR };
