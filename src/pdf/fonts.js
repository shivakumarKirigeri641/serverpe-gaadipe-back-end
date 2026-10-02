const fs = require("fs");
const path = require("path");

/**
 * PDF font registration.
 *
 * WHY THIS EXISTS: pdfkit's built-in Helvetica is WinAnsi-encoded and has no
 * glyph for ₹ (U+20B9). Every amount had to be written "Rs. 49", which looks
 * amateurish on an invoice. Worse, an unsupported glyph fails SILENTLY — the PDF
 * renders, the send succeeds, and the customer opens a document with a blank or
 * garbled character.
 *
 * DejaVu Sans covers ₹ along with the arrows, bullets and dashes used in the
 * reports, and is freely embeddable (Bitstream Vera licence). Bundled in
 * src/assets/fonts rather than relying on system fonts, because the production
 * Linux box will not have Windows' Arial.
 */
const DIR = path.join(__dirname, "..", "assets", "fonts");

const LATIN = { regular: "Helvetica", bold: "Helvetica-Bold", oblique: "Helvetica-Oblique", unicode: false };

/* Register the embedded family on a document and return the font names to use.
   Falls back to Helvetica (and warns) if the files are missing, so a deployment
   that forgot the assets still produces a readable document. */
const useFonts = (doc) => {
  const reg = path.join(DIR, "DejaVuSans-Regular.ttf");
  const bold = path.join(DIR, "DejaVuSans-Bold.ttf");
  const obl = path.join(DIR, "DejaVuSans-Oblique.ttf");

  if (!fs.existsSync(reg)) {
    console.error("[pdf] DejaVuSans not bundled in src/assets/fonts — falling back to Helvetica; ₹ WILL NOT render");
    return LATIN;
  }
  doc.registerFont("body", reg);
  doc.registerFont("bodyBold", fs.existsSync(bold) ? bold : reg);
  doc.registerFont("bodyOblique", fs.existsSync(obl) ? obl : reg);
  indic(doc);
  return { regular: "body", bold: "bodyBold", oblique: "bodyOblique", unicode: true };
};

/*
 * INDIAN SCRIPTS (user, 2026-10-02: a Tamil customer's report had their Tamil
 * text missing). DejaVu Sans has no Indian scripts, so a name or a challan
 * offence written in Tamil came out blank. Noto Sans for each script is
 * bundled (SIL Open Font License, OFL-Noto.txt), and text is drawn in runs: a
 * Tamil run in Noto Sans Tamil, the rest in the document's own font. Shaping
 * (joined letters, vowel signs) is done by fontkit, inside pdfkit.
 */
const SCRIPTS = [
  ["Devanagari", 0x0900, 0x097f], ["Bengali", 0x0980, 0x09ff], ["Gurmukhi", 0x0a00, 0x0a7f],
  ["Gujarati", 0x0a80, 0x0aff], ["Oriya", 0x0b00, 0x0b7f], ["Tamil", 0x0b80, 0x0bff],
  ["Telugu", 0x0c00, 0x0c7f], ["Kannada", 0x0c80, 0x0cff], ["Malayalam", 0x0d00, 0x0d7f],
];
const INDIC = /[\u0900-\u0D7F]/;
// Joiners, danda and the like belong to the script around them.
const NEUTRAL = /[\u200C\u200D\u0964\u0965]/;

const scriptOf = (ch) => {
  const c = ch.codePointAt(0);
  const s = SCRIPTS.find(([, a, b]) => c >= a && c <= b);
  return s ? s[0] : null;
};

/** "Ravi முருகன் KA" -> [["Ravi ", null], ["முருகன்", "Tamil"], [" KA", null]]. Spaces stay with the run before. */
function runs(text) {
  const out = [];
  for (const ch of text) {
    let s = scriptOf(ch);
    const last = out[out.length - 1];
    if (!s && last && (NEUTRAL.test(ch) || (ch === " " && last[1]))) s = last[1];
    if (last && last[1] === s) last[0] += ch; else out.push([ch, s]);
  }
  return out;
}

const available = () => Object.fromEntries(SCRIPTS
  .map(([s]) => [s, { regular: path.join(DIR, `NotoSans${s}-Regular.ttf`), bold: path.join(DIR, `NotoSans${s}-Bold.ttf`) }])
  .filter(([, f]) => fs.existsSync(f.regular)));

function indic(doc) {
  const fonts = available();
  if (!Object.keys(fonts).length || doc._indic) return;
  doc._indic = true;
  for (const [s, f] of Object.entries(fonts)) {
    doc.registerFont(`noto${s}`, f.regular);
    doc.registerFont(`noto${s}Bold`, fs.existsSync(f.bold) ? f.bold : f.regular);
  }
  const fontFor = (script, base) => (fonts[script]
    ? `noto${script}${/bold/i.test(base?.name || base?.font?.postscriptName || "") ? "Bold" : ""}` : null);

  const text = doc.text.bind(doc);
  const width = doc.widthOfString.bind(doc);

  doc.widthOfString = function (str, options) {
    const s = String(str ?? "");
    if (!INDIC.test(s)) return width(s, options);
    const base = this._font;
    let w = 0;
    for (const [part, script] of runs(s)) {
      const f = fontFor(script, base);
      if (f) this.font(f);
      w += width(part, options);
      this._font = base;
    }
    return w;
  };

  /*
   * Mixed text on one line — a table cell, a name, the diagonal watermark — is
   * measured run by run and each run placed at its own x, so right and centre
   * alignment, ellipsis and rotation all hold. (pdfkit's "continued" text
   * cannot right-align runs, and overlapped them.) Text too long for one line
   * that is allowed to wrap is drawn in continued runs instead, left-aligned.
   */
  doc.text = function (str, x, y, options) {
    if (str == null || !INDIC.test(String(str))) return text(str, x, y, options);
    let opts = options;
    if (x && typeof x === "object") { opts = x; x = undefined; y = undefined; }
    opts = { ...(opts || {}) };
    const base = this._font;
    const X = x ?? this.x, Y = y ?? this.y;
    let parts = runs(String(str)).map(([part, script]) => ({ part, font: fontFor(script, base) }));
    const measure = (p) => { if (p.font) this.font(p.font); const w = width(p.part, opts); this._font = base; return w; };
    let total = parts.reduce((a, p) => a + measure(p), 0);
    const room = opts.width ?? (this.page.width - this.page.margins.right - X);
    const oneLine = opts.lineBreak === false || opts.ellipsis || total <= room;

    if (!oneLine) {
      parts.forEach((p, i) => {
        if (p.font) this.font(p.font); else this._font = base;
        const o = { ...opts, align: "left", continued: i < parts.length - 1 ? true : Boolean(opts.continued) };
        if (i === 0) text(p.part, X, Y, o); else text(p.part, o);
      });
      this._font = base;
      return this;
    }

    // Too wide for the cell: cut from the end and add an ellipsis.
    if (total > room && opts.width != null) {
      const dots = { part: "…", font: null };
      while (parts.length && total + measure(dots) > room) {
        const last = parts[parts.length - 1];
        const chars = Array.from(last.part);
        chars.pop();
        if (chars.length) last.part = chars.join(""); else parts.pop();
        total = parts.reduce((a, p) => a + measure(p), 0);
      }
      parts.push(dots);
      total += measure(dots);
    }

    let cx = X;
    if (opts.width != null && opts.align === "right") cx = X + opts.width - total;
    else if (opts.width != null && opts.align === "center") cx = X + (opts.width - total) / 2;
    for (const p of parts) {
      if (p.font) this.font(p.font); else this._font = base;
      text(p.part, cx, Y, { lineBreak: false, characterSpacing: opts.characterSpacing });
      cx += width(p.part, opts);
    }
    this._font = base;
    this.x = X;
    this.y = Y + this.currentLineHeight(true);
    return this;
  };
}

const hasUnicodeFonts = () => fs.existsSync(path.join(DIR, "DejaVuSans-Regular.ttf"));

module.exports = { useFonts, hasUnicodeFonts, DIR, INDIC, runs };
