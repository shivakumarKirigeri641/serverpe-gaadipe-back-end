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
  return { regular: "body", bold: "bodyBold", oblique: "bodyOblique", unicode: true };
};

const hasUnicodeFonts = () => fs.existsSync(path.join(DIR, "DejaVuSans-Regular.ttf"));

module.exports = { useFonts, hasUnicodeFonts, DIR };
