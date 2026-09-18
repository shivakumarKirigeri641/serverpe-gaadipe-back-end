const PDFDocument = require("pdfkit");
const T = require("./theme");

/**
 * GST tax invoice PDF: branded header with number and date, seller/buyer cards,
 * a line-item table, a right-aligned totals block, payment reference and a
 * grievance strip.
 *
 * The price is tax-INCLUSIVE, so taxable value is backed out of the gross and
 * split by place of supply — CGST+SGST within Karnataka, IGST elsewhere.
 *
 * Returns a Promise<Buffer>.
 */
const { consentBlock, consentLine } = require('./consent');

const buildInvoice = ({ invoice, business, gst = {}, lineItem = {}, lineItems = null, consent = null }) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: T.M, bufferPages: true });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    T.init(doc);
    const W = doc.page.width - T.M * 2;
    const invDate = invoice.invoice_date || new Date();
    const generatedAt = T.fmtDateTime(invDate);

    let y = T.header(doc, {
      title: "TAX INVOICE",
      subtitle: `Date: ${T.fmtDate(invDate)}`,
      docNumber: invoice.invoice_number,
      business,
    });

    /* ── seller / buyer cards ──
       MEASURED, THEN DRAWN (user, 2026-09-18): a fixed-height card let a long
       address run out of the bottom and made the two cards disagree. Each card's
       lines are measured first, both cards take the taller height, and every
       line sits on the same 7.6pt rhythm with the same gap.
       What is shown is deliberately short: the GSTIN (no PAN — the GSTIN
       already carries it), the support email and website, and the proprietor
       by first name. No phone number: support is by email. */
    const colW = (W - 12) / 2;
    const pad = 12;
    const innerW = colW - pad * 2;
    const firstName = String(business.proprietor_name || "").trim().split(/\s+/)[0] || null;

    const sellerLines = [
      business.registered_address,
      business.gstin ? `GSTIN: ${business.gstin}` : null,
      business.product_support_email || business.support_email,
      business.product_website,
      firstName ? `Proprietor: ${firstName}` : null,
    ].filter(Boolean);

    const buyerLines = [
      invoice.customer_gstin ? `GSTIN: ${invoice.customer_gstin}` : null,
      invoice.customer_mobile ? `Mobile: ${invoice.customer_mobile}` : null,
      invoice.customer_email,
      invoice.place_of_supply
        ? `State / UT: ${invoice.place_of_supply}${invoice.place_of_supply_code ? ` (${invoice.place_of_supply_code})` : ""}`
        : null,
      invoice.is_interstate ? "Inter-state supply — IGST" : "Intra-state supply — CGST + SGST",
    ].filter(Boolean);

    const LINE_GAP = 2.5;
    const measure = (lines) => {
      doc.font(doc._F.regular).fontSize(7.6);
      return lines.reduce((h, l) => h + doc.heightOfString(l, { width: innerW }) + LINE_GAP, 0);
    };
    const bodyTop = 40;                      // label at +10, name at +22, lines from +40
    const boxH = Math.max(96, bodyTop + Math.max(measure(sellerLines), measure(buyerLines)) + 10);

    const drawCard = (x, label, name, lines) => {
      T.card(doc, x, y, colW, boxH, { fill: T.BRAND.soft });
      T.label(doc, label, x + pad, y + 10);
      doc.fillColor(T.BRAND.ink).font(doc._F.bold).fontSize(10.5)
         .text(name, x + pad, y + 22, { width: innerW, height: 14, ellipsis: true, lineBreak: false });
      doc.fillColor(T.BRAND.body).font(doc._F.regular).fontSize(7.6);
      let ly = y + bodyTop;
      for (const l of lines) {
        doc.text(l, x + pad, ly, { width: innerW, lineGap: 0 });
        ly = doc.y + LINE_GAP;
      }
    };
    drawCard(T.M, "Billed by", business.business_name || "ServerPe App Solutions", sellerLines);
    drawCard(T.M + colW + 12, "Billed to", invoice.customer_name || "Customer", buyerLines);

    y += boxH + 14;

    /* ── line items — one row per vehicle in the cart ── */
    const sac = invoice.sac_code || gst.sac_code || "—";
    const lineRows = (Array.isArray(lineItems) && lineItems.length)
      ? lineItems
      : [{ reg_no: lineItem.reg_no, report_number: lineItem.report_number,
           description: lineItem.description, taxable: Number(invoice.taxable_amount) }];

    y = T.sectionTitle(doc, "Particulars", y);
    y = T.table(doc, [
      // A little under the page width, so the right-aligned figures in the
      // last column do not touch the edge.
      { label: "Description", width: 284 },
      { label: "SAC", width: 56, nowrap: true },
      { label: "Qty", width: 34, align: "center", nowrap: true },
      { label: "Rate", width: 70, align: "right", nowrap: true },
      { label: "Taxable", width: 76, align: "right", nowrap: true },
    ], lineRows.map((it) => [
      it.description || `Full Vehicle Report${it.reg_no ? ` — ${it.reg_no}` : ""}`,
      sac, "1", T.money(it.taxable), T.money(it.taxable),
    ]), y);

    /* Report numbers for traceability, under the table. */
    const refs = lineRows.filter((it) => it.report_number)
      .map((it) => `${it.reg_no || ""} · ${it.report_number}`.trim());
    if (refs.length) {
      doc.fillColor(T.BRAND.muted).font(doc._F.regular).fontSize(7.6)
         .text(`Reports: ${refs.join("     ")}`, T.M + 2, y, { width: W - 4 });
      y = doc.y + 8;
    }

    /* ── totals ── */
    const boxW = 236;
    const boxX = T.M + W - boxW;
    const rows = [["Taxable value", T.money(invoice.taxable_amount)]];
    if (invoice.is_interstate) {
      rows.push([`IGST @ ${gst.igst_percent || 18}%`, T.money(invoice.igst_amount)]);
    } else {
      rows.push([`CGST @ ${gst.cgst_percent || 9}%`, T.money(invoice.cgst_amount)]);
      rows.push([`SGST @ ${gst.sgst_percent || 9}%`, T.money(invoice.sgst_amount)]);
    }
    rows.push(["Total tax", T.money(invoice.total_tax)]);

    const totalsH = rows.length * 18 + 36;
    T.card(doc, boxX, y, boxW, totalsH, { fill: T.BRAND.soft });
    let ty = y + 12;
    rows.forEach(([k, v]) => { ty = T.kv(doc, k, v, boxX + 12, ty, boxW - 24, { size: 8.5 }); ty -= 1.5; });
    doc.moveTo(boxX + 12, ty + 2).lineTo(boxX + boxW - 12, ty + 2).lineWidth(0.7).stroke(T.BRAND.line);
    doc.fillColor(T.BRAND.ink).font(doc._F.bold).fontSize(10)
       .text("Total paid", boxX + 12, ty + 12, { lineBreak: false });
    doc.fillColor(T.BRAND.green).font(doc._F.bold).fontSize(13)
       .text(T.money(invoice.gross_amount), boxX + 12, ty + 9, { width: boxW - 24, align: "right", lineBreak: false });

    /* notes beside the totals block */
    doc.fillColor(T.BRAND.muted).font(doc._F.regular).fontSize(7.4)
       .text(
         `Amounts are inclusive of GST. ${invoice.is_interstate
           ? "Inter-state supply — IGST charged."
           : "Intra-state supply — CGST + SGST charged."}\n` +
         "This is a computer-generated invoice and does not require a signature.",
         T.M, y + 4, { width: W - boxW - 20 }
       );
    y += totalsH + 16;

    /* ── what the money bought, and until when ──
       A table cell is clipped to one line, so the service period cannot live in
       the description: it ends up as an ellipsis. It also happens to be the
       first thing a customer looks for, which is reason enough for it to have a
       block of its own. */
    /* One card, not two (user, 2026-09-18): the separate Service Period card
       pushed the consent record onto a second page. The vehicle is already in
       the table above. No "renewal" line — nothing renews; a new purchase is a
       new invoice. */
    if (lineItem.payment_id || lineItem.order_id || lineItem.period_from || lineItem.period_to) {
      const monitoring = (lineItem.period_from || lineItem.period_to)
        ? [["Monitoring", `${T.fmtDate(lineItem.period_from)} – ${T.fmtDate(lineItem.period_to)}`]] : [];
      y = T.sectionTitle(doc, "Payment & service", y, T.BRAND.green);
      y = T.kvCard(doc, [
        ["Payment ID", lineItem.payment_id || "—"],
        ["Paid at", T.fmtDateTime(lineItem.paid_at)],
        ["Order ID", lineItem.order_id || "—"],
        ["Status", "PAID", T.BRAND.green],
        ["Method", lineItem.method ? String(lineItem.method).toUpperCase() : "Online · Razorpay"],
        ...monitoring,
      ], y, { cols: 2 });
    }

    /* ── what was agreed to ── */
    if (consent) y = consentBlock(doc, y, consent, { compact: true });

    /* ── grievance strip ── */
    if (business.grievance_officer_name && consent) {
      // One line when the consent record is on the page — a whole card for a
      // single sentence is what pushed the invoice onto a second, empty page.
      y = T.ensureSpace(doc, y, 18);
      doc.fillColor(T.BRAND.body).font(doc._F.regular).fontSize(7.6)
         .text(`Support & grievance: ${business.grievance_officer_name}`
               + `${business.grievance_officer_designation ? `, ${business.grievance_officer_designation}` : ''}`
               + `  ·  ${business.grievance_officer_email || business.support_email || ''}`
               + `${business.grievance_response_hours ? `  ·  response within ${business.grievance_response_hours}h` : ''}`,
               T.M, y, { width: W });
      y = doc.y + 8;
    } else if (business.grievance_officer_name) {
      y = T.ensureSpace(doc, y, 52);
      T.card(doc, T.M, y, W, 40, { fill: T.BRAND.soft });
      T.label(doc, "Support & grievance", T.M + 12, y + 9);
      doc.fillColor(T.BRAND.body).font(doc._F.regular).fontSize(7.8)
         .text(
           `${business.grievance_officer_name}` +
           `${business.grievance_officer_designation ? `, ${business.grievance_officer_designation}` : ""}` +
           `   ·   ${business.grievance_officer_email || business.support_email || ""}` +
           `${business.grievance_response_hours ? `   ·   Response within ${business.grievance_response_hours}h` : ""}` +
           ``,
           T.M + 12, y + 23, { width: W - 24 }
         );
      y += 52;
    }

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      T.watermark(doc);
      T.pageFurniture(doc, {
        page: i + 1, total: range.count, docNumber: invoice.invoice_number,
        generatedAt, business,
        disclaimer: "GaadiPe is a product of ServerPe App Solutions. Reports supplied against this invoice are " +
                    "informative in nature and relate to vehicle particulars only. ServerPe App Solutions is NOT " +
                    "RESPONSIBLE for any misleading activity, or for any misuse of the content supplied. Please read " +
                    "and understand the Terms, Consents and Policies carefully before proceeding. " +
                    (consentLine(consent) || business?.purpose_declaration_doc ||
                     "Requester's declaration: the requester confirmed that the vehicle(s) and their owner(s) are known to them and that these details were requested for a lawful, legitimate purpose, taking full responsibility for their use."),
      });
    }
    doc.end();
  });

module.exports = { buildInvoice };
