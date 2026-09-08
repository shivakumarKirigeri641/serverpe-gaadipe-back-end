const path = require("path");
const fs = require("fs");
const { useFonts, hasUnicodeFonts } = require("./fonts");

/**
 * Shared PDF styling + drawing helpers (pdfkit): embedded Unicode fonts, rounded
 * cards, uppercase micro-labels, right-aligned key/value rows, stat cards and
 * hand-drawn vector icons.
 *
 * Fonts are attached to the document as doc._F = { regular, bold, oblique } by
 * init(), so every helper picks up the embedded family without threading the
 * names through each call.
 *
 * Emoji are never used: PDF fonts cannot render them, so ticks and crosses are
 * drawn as vectors instead.
 */
// GaadiPe document palette: teal brand band, green accent, warm-grey text.
// `blue`/`blueSoft` are kept as aliases (many call sites reference them) but now
// point at the teal brand, so section titles and info chips render teal.
const BRAND = {
  brand: "#075E54", brand2: "#0A7D6E", accent: "#00A884", brandSoft: "#E7F7F2",
  blue: "#075E54", blue2: "#0A7D6E", blueSoft: "#E7F7F2",
  sky: "#00A884",
  green: "#1A7F37", greenSoft: "#E7F7F2",
  amber: "#B8860B", amberSoft: "#FBF3D9",
  red: "#C0392B", redSoft: "#FDECEB",
  ink: "#111B21", body: "#334155", muted: "#667781", faint: "#8A97A0",
  line: "#E2E6E9", soft: "#F6F8F9", white: "#FFFFFF", gold: "#C99700",
};

const M = 40;                                   // page margin
const IMAGES = path.join(__dirname, "..", "images");
const logoMark = () => {
  const p = path.join(IMAGES, "icon-256.png");
  return fs.existsSync(p) ? p : null;
};

/* Attach the embedded fonts. Call once, first thing, on every document. */
const init = (doc) => {
  doc._F = useFonts(doc);
  return doc._F;
};

/* ₹ only when a Unicode font is embedded; "Rs." is the safe fallback. */
const RUPEE = hasUnicodeFonts() ? "₹" : "Rs. ";
const money = (n) =>
  RUPEE + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = (n) => RUPEE + Number(n || 0).toLocaleString("en-IN");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDate = (d) => {
  if (!d) return "—";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "—";
  return `${String(dt.getDate()).padStart(2, "0")} ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
};
const fmtDateTime = (d) => {
  if (!d) return "—";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "—";
  return `${fmtDate(dt)}, ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
};
const titleCase = (s) =>
  String(s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).trim();
const daysUntil = (d) => {
  if (!d) return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return Math.ceil((dt - new Date()) / 86400000);
};

/* ── primitives ── */

const card = (doc, x, y, w, h, { fill = BRAND.white, stroke = BRAND.line, radius = 8 } = {}) => {
  doc.roundedRect(x, y, w, h, radius).fillAndStroke(fill, stroke);
  return { x, y, w, h };
};

/* Uppercase micro-label above a value. */
const label = (doc, text, x, y, color = BRAND.muted, size = 7.5) => {
  doc.fillColor(color).font(doc._F.bold).fontSize(size)
     .text(String(text).toUpperCase(), x, y, { characterSpacing: 0.5, lineBreak: false });
};

/* Content must never be drawn below this line, or pdfkit auto-creates a page. */
const safeBottom = (doc) => doc.page.height - 96;

/* Add a page when `need` pixels will not fit. Returns the y to continue at. */
const ensureSpace = (doc, y, need) => {
  if (y + need <= safeBottom(doc)) return y;
  doc.addPage();
  return 46;
};

/**
 * Key left, value right — split into two fixed columns.
 *
 * The naive version drew the key at x with no width and the value right-aligned
 * across the SAME span, so as soon as key + value exceeded the column the two
 * overlapped ("Generated14 Aug 2026"). Reserving 46% for the key and 54% for the
 * value, both clipped to a single line, makes collision impossible.
 */
const kv = (doc, k, v, x, y, w, { valueColor = BRAND.ink, size = 9 } = {}) => {
  const line = size + 3;
  const key = String(k);
  const val = v === null || v === undefined || v === "" ? "—" : String(v);

  /* Give the key only what it actually needs (capped at 55%) and hand the rest
     to the value — a fixed split truncated long values like the owner address
     while short keys such as "Fuel" left half the column empty. */
  doc.font(doc._F.regular).fontSize(size);
  const keyW = Math.min(doc.widthOfString(key) + 2, w * 0.55);
  const valW = w - keyW - 8;

  doc.fillColor(BRAND.muted)
     .text(key, x, y, { width: keyW, height: line, lineBreak: false, ellipsis: true });
  doc.fillColor(valueColor).font(doc._F.bold).fontSize(size)
     .text(val, x + keyW + 8, y, { width: valW, align: "right", height: line, lineBreak: false, ellipsis: true });
  return y + size + 6;
};

/* Section heading with a coloured rule. Carries its own lead-in space so
   sections never crowd the block above them. */
const sectionTitle = (doc, text, y, color = BRAND.blue) => {
  const top = y + 10;
  doc.rect(M, top + 1, 3, 12).fill(color);
  doc.fillColor(BRAND.ink).font(doc._F.bold).fontSize(10.5)
     .text(String(text).toUpperCase(), M + 9, top, { characterSpacing: 0.4, lineBreak: false });
  return top + 20;
};

/* Row of stat cards: [{ title, big, sub, color }] */
const statCards = (doc, items, y, { h = 62 } = {}) => {
  const W = doc.page.width - M * 2;
  const gap = 10;
  const w = (W - gap * (items.length - 1)) / items.length;
  items.forEach((it, i) => {
    const x = M + i * (w + gap);
    card(doc, x, y, w, h, { fill: it.fill || BRAND.white, stroke: it.stroke || BRAND.line });
    label(doc, it.title, x + 10, y + 9);
    doc.fillColor(it.color || BRAND.ink).font(doc._F.bold).fontSize(it.bigSize || 15)
       .text(String(it.big), x + 10, y + 22, { width: w - 20, ellipsis: true, lineBreak: false });
    if (it.sub) {
      doc.fillColor(BRAND.muted).font(doc._F.regular).fontSize(7.5)
         .text(String(it.sub), x + 10, y + h - 17, { width: w - 20, ellipsis: true, lineBreak: false });
    }
  });
  return y + h + 12;
};

/* Two-column key/value block inside a card. rows = [[k,v], ...] */
const kvCard = (doc, rows, y, { cols = 2, title = null } = {}) => {
  const W = doc.page.width - M * 2;
  const gap = 12;
  const colW = (W - gap * (cols - 1)) / cols;
  const perCol = Math.ceil(rows.length / cols);
  const h = perCol * 17 + 16 + (title ? 16 : 0);

  card(doc, M, y, W, h);
  if (title) label(doc, title, M + 12, y + 10);

  rows.forEach((r, i) => {
    const c = Math.floor(i / perCol);
    const ri = i % perCol;
    const x = M + 12 + c * (colW + gap);
    kv(doc, r[0], r[1], x, y + (title ? 28 : 12) + ri * 17, colW - 24, { valueColor: r[2] || BRAND.ink });
  });
  return y + h + 12;
};

/* Status pill. */
const chip = (doc, text, x, y, kind = "neutral") => {
  const map = {
    ok: [BRAND.green, BRAND.greenSoft], warn: [BRAND.amber, BRAND.amberSoft],
    bad: [BRAND.red, BRAND.redSoft], info: [BRAND.blue, BRAND.blueSoft],
    neutral: [BRAND.muted, BRAND.soft],
  };
  const [fg, bg] = map[kind] || map.neutral;
  doc.font(doc._F.bold).fontSize(7.5);
  const w = doc.widthOfString(text) + 14;
  doc.roundedRect(x, y, w, 14, 7).fill(bg);
  doc.fillColor(fg).text(text, x + 7, y + 3.5, { lineBreak: false });
  return w;
};

/* ── vector icons (PDF fonts cannot render emoji) ── */
const iconCheck = (doc, x, y, s, color = BRAND.green) => {
  doc.save().lineWidth(s * 0.16).strokeColor(color).lineCap("round").lineJoin("round")
     .moveTo(x + s * 0.22, y + s * 0.54).lineTo(x + s * 0.42, y + s * 0.72)
     .lineTo(x + s * 0.78, y + s * 0.28).stroke().restore();
};
const iconLock = (doc, x, y, s, color = BRAND.muted) => {
  doc.save().lineWidth(s * 0.1).strokeColor(color)
     .roundedRect(x + s * 0.22, y + s * 0.45, s * 0.56, s * 0.42, s * 0.08).stroke()
     .moveTo(x + s * 0.34, y + s * 0.45).lineTo(x + s * 0.34, y + s * 0.3)
     .bezierCurveTo(x + s * 0.34, y + s * 0.1, x + s * 0.66, y + s * 0.1, x + s * 0.66, y + s * 0.3)
     .lineTo(x + s * 0.66, y + s * 0.45).stroke().restore();
};

/* ── page furniture ── */

/* Brand header band. Returns the y to continue from. */
const header = (doc, { title, subtitle, docNumber, business = {} }) => {
  const W = doc.page.width;
  doc.rect(0, 0, W, 88).fill(BRAND.brand);
  doc.rect(0, 88, W, 3).fill(BRAND.accent);

  const logo = logoMark();
  if (logo) doc.image(logo, M, 20, { width: 42, height: 42 });

  doc.fillColor(BRAND.white).font(doc._F.bold).fontSize(18)
     .text(business.product_name || "GaadiPe", M + 54, 26, { lineBreak: false });
  doc.fillColor("#CFE9E2").font(doc._F.regular).fontSize(8)
     .text(business.product_tagline || "Har gaadi ki kundli.", M + 54, 48, { lineBreak: false });

  doc.fillColor(BRAND.white).font(doc._F.bold).fontSize(12)
     .text(title, 0, 26, { align: "right", width: W - M, lineBreak: false });
  if (docNumber) {
    doc.fillColor("#CFE9E2").font(doc._F.regular).fontSize(8.5)
       .text(docNumber, 0, 44, { align: "right", width: W - M, lineBreak: false });
  }
  if (subtitle) {
    doc.fillColor("#CFE9E2").font(doc._F.regular).fontSize(8)
       .text(subtitle, 0, 58, { align: "right", width: W - M, lineBreak: false });
  }
  return 106;
};

/* Table. cols = [{label,width,align}], rows = [[...]]
   Breaks across pages and repeats the header, and clips every cell to one line
   (a cell without an explicit height wraps and spills over the row beneath). */
const table = (doc, cols, rows, y, { rowH = 17, maxRows = 100 } = {}) => {
  const W = doc.page.width - M * 2;

  const drawHead = (yy) => {
    doc.rect(M, yy, W, 19).fill(BRAND.brand);
    let x = M;
    doc.fillColor(BRAND.white).font(doc._F.bold).fontSize(7.5);
    cols.forEach((c) => {
      doc.text(c.label.toUpperCase(), x + 7, yy + 6,
               { width: c.width - 14, height: 10, align: c.align || "left", lineBreak: false, ellipsis: true });
      x += c.width;
    });
    return yy + 19;
  };

  y = ensureSpace(doc, y, 19 + rowH * 2);
  y = drawHead(y);

  const shown = rows.slice(0, maxRows);
  shown.forEach((row, ri) => {
    if (y + rowH > safeBottom(doc)) {          // continue on the next page
      doc.addPage();
      y = drawHead(46);
    }
    if (ri % 2 === 1) doc.rect(M, y, W, rowH).fill(BRAND.soft);
    let x = M;
    doc.font(doc._F.regular).fontSize(8).fillColor(BRAND.body);
    cols.forEach((c, ci) => {
      doc.text(row[ci] === null || row[ci] === undefined ? "—" : String(row[ci]),
               x + 7, y + rowH / 2 - 4,
               { width: c.width - 14, height: 11, align: c.align || "left", lineBreak: false, ellipsis: true });
      x += c.width;
    });
    y += rowH;
  });
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.6).stroke(BRAND.line);

  if (rows.length > maxRows) {
    doc.font(doc._F.oblique).fontSize(7.5).fillColor(BRAND.muted)
       .text(`… and ${rows.length - maxRows} more`, M + 7, y + 5, { lineBreak: false });
    y += 15;
  }
  return y + 12;
};

/**
 * Disclaimer + page number + brand strip, painted on every page.
 *
 * MUST NOT OVERFLOW. Drawing a block that doesn't fit makes pdfkit silently
 * append a page — which is what produced a blank page after every real one and
 * pushed the brand strip off the document. The disclaimer is therefore measured
 * first and given an explicit height, so it is clipped rather than flowed.
 */
const pageFurniture = (doc, { page, total, docNumber, generatedAt, business = {}, disclaimer }) => {
  const H = doc.page.height;
  const W = doc.page.width;
  const textW = W - M * 2;

  const stripTop = H - 20;
  const metaY = H - 34;
  const ruleY = H - 76;

  doc.moveTo(M, ruleY).lineTo(W - M, ruleY).lineWidth(0.6).stroke(BRAND.line);

  if (disclaimer) {
    const maxH = metaY - ruleY - 10;                 // room between rule and meta line
    let size = 6.4;
    doc.font(doc._F.regular).fontSize(size);
    // Shrink a little rather than overflow; clip as the final guarantee.
    while (doc.heightOfString(disclaimer, { width: textW }) > maxH && size > 5) {
      size -= 0.2;
      doc.fontSize(size);
    }
    doc.fillColor(BRAND.muted)
       .text(disclaimer, M, ruleY + 6, { width: textW, height: maxH, align: "justify", ellipsis: true });
  }

  doc.font(doc._F.regular).fontSize(6.8).fillColor(BRAND.muted)
     .text(`${docNumber}   ·   ${generatedAt}`, M, metaY, { width: textW / 2, height: 9, lineBreak: false, ellipsis: true });
  doc.text(`Page ${page} of ${total}`, M + textW / 2, metaY,
           { width: textW / 2, align: "right", height: 9, lineBreak: false });

  doc.rect(0, stripTop, W, 20).fill(BRAND.brand);
  const bits = [
    `Powered by: ${business.business_name || "ServerPe App Solutions"}`,
    business.product_support_email || business.support_email || "support@gaadipe.in",
    business.product_website || "gaadipe.in",
  ].filter(Boolean);
  doc.fillColor("#CFE9E2").font(doc._F.regular).fontSize(6.6)
     .text(bits.join("   ·   "), M, stripTop + 6.5, { width: textW, align: "center", height: 9, lineBreak: false });
};

/* Faint diagonal brand watermark, drawn once per page (behind the furniture).
   Low opacity so it never fights the content but discourages tampering/copying. */
const watermark = (doc, text = "GaadiPe") => {
  const W = doc.page.width, H = doc.page.height;
  doc.save();
  doc.opacity(0.05);
  doc.rotate(-32, { origin: [W / 2, H / 2] });
  doc.fillColor(BRAND.brand).font(doc._F.bold).fontSize(96)
     .text(text, W / 2 - 420, H / 2 - 62, { width: 840, align: "center", lineBreak: false });
  doc.restore();   // restores opacity, fill, rotation
};

module.exports = {
  BRAND, M, init, money, money0, fmtDate, fmtDateTime, titleCase, daysUntil, logoMark,
  card, label, kv, kvCard, sectionTitle, statCards, chip, table, header, pageFurniture,
  ensureSpace, safeBottom, watermark,
  iconCheck, iconLock,
};
