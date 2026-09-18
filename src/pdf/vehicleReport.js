/**
 * src/pdf/vehicleReport.js
 * ---------------------------------------------------------------------------
 * The vehicle report as a document.
 *
 * The WhatsApp report is for reading on a phone in ten seconds. This is for
 * keeping, forwarding to a mechanic, or attaching to a sale — so it carries
 * what a message cannot: every field, laid out, with the requester's details
 * and a declaration attached.
 *
 * THE REQUESTER BLOCK IS THE POINT, not decoration. The Terms say a report is
 * issued to someone who declared a lawful purpose; that declaration means
 * nothing unless it is attached to a person, a number, a moment and a device.
 * If a report is ever misused, "who obtained this and when" must be answerable
 * from the document itself.
 *
 * Masking is identical to the WhatsApp report — chassis and engine never
 * appear, owner and document numbers are masked. A PDF is more forwardable than
 * a chat message, not less, so it gets no extra latitude.
 * ---------------------------------------------------------------------------
 */

const PDFDocument = require('pdfkit');
const T = require('./theme');
const { maskName, maskNumber, titleCase, documentsOf, human } = require('../whatsapp/report');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmt = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v)
    : `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};
const rupees = (paise) => '₹' + Math.round((paise || 0) / 100).toLocaleString('en-IN');

/**
 * Text the embedded font can actually draw.
 *
 * e-Challan returns some offences bilingually — "Failure to use safety belts … /
 * વાહન હંકારતી વખતે …" from Gujarat — and DejaVu Sans has no Gujarati or
 * Devanagari glyphs, so those characters printed as rows of empty boxes that
 * also pushed the row into the next column. Every such offence carries the
 * English wording as well, so the other scripts are dropped, and the separators
 * left dangling behind them ("wheeler / -") are tidied away.
 */
const printable = (v) => {
  if (v === null || v === undefined) return v;
  return String(v)
    // Keep Latin, general punctuation, ₹, bullets; drop everything else.
    .replace(/[^\u0009\u000A\u0020-\u024F\u2010-\u2027\u2030-\u205E\u20B9\u2022]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/(\s*[\/\-–—|,;:]\s*){2,}/g, ' / ')     // "/ -" left between removed words
    .replace(/[\s\/\-–—|,;:]+$/g, '')                 // …and at the end
    .trim();
};

/** "Mumbai Pune Expressway 65/400 KM-MC" — short enough for a table cell. */
const clip = (s, n) => {
  const t = printable(s) || '';
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

const { consentBlock, consentLine } = require('./consent');

const buildVehicleReport = ({ report, business = {}, data, requester = {}, consent = null }) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: T.M, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    T.init(doc);
    const W = doc.page.width - T.M * 2;
    const rc = data.rc || {};
    const generatedAt = T.fmtDateTime(report.created_at || new Date());

    let y = T.header(doc, {
      title: 'VEHICLE REPORT',
      subtitle: `Generated: ${T.fmtDate(report.created_at || new Date())}`,
      docNumber: report.report_number,
      business,
    });

    /*
     * A SAMPLE IS LABELLED AS ONE, on every page and in the file itself.
     *
     * This document exists to be shown on the website, where it will be
     * downloaded, forwarded and screenshotted. A realistic-looking vehicle
     * report with invented contents, passed on without its context, is exactly
     * the thing that must not be mistakable for a real record.
     */
    if (report.sample) {
      doc.rect(T.M, y, W, 22).fill('#fff6e6');
      doc.fillColor('#8f5600').font(doc._F.bold).fontSize(9)
         .text('SAMPLE — an illustration of the GaadiPe report. Not a real vehicle, '
               + 'and not a Government record.', T.M + 10, y + 6.5, { width: W - 20 });
      y += 32;
    }

    /* ── the vehicle ── */
    y = T.sectionTitle(doc, 'Vehicle', y, T.BRAND.brand);
    y = T.kvCard(doc, [
      ['Registration number', report.reg_no],
      ['Make and model', [rc.maker, rc.model].filter(Boolean).map(titleCase).join(' ') || '—'],
      ['Class', titleCase(rc.vehicle_class) || '—'],
      ['Fuel', titleCase(rc.fuel) || '—'],
      ['Colour', titleCase(rc.colour) || '—'],
      ['Manufactured', rc.manufactured || '—'],
      ['Emission norms', rc.norms || '—'],
      ['Engine capacity', rc.cubic_capacity ? `${rc.cubic_capacity} cc` : '—'],
      ['Seating', rc.seats || '—'],
      ['Registered at', titleCase(String(rc.registered_at || '').replace(/\s+/g, ' ').trim()) || '—'],
      ['Registered on', fmt(rc.reg_date)],
      ['RC status', titleCase(rc.status) || '—'],
    ], y, { cols: 2 });

    /* ── ownership ── */
    y = T.ensureSpace(doc, y, 90);
    y = T.sectionTitle(doc, 'Ownership', y, T.BRAND.brand);
    // No owner name, masked or not: the report is sold as everything except
    // personal details, and a PDF is the most forwardable thing we produce.
    y = T.kvCard(doc, [
      ['Owner type', titleCase(rc.owner_type) || '—'],
      ['Ownership serial', rc.owner_serial ? `${rc.owner_serial}` : '—'],
      ['Financer', titleCase(rc.financer) || 'Not financed'],
      ['Blacklist status', rc.blacklist_status && rc.blacklist_status !== '—'
        ? titleCase(rc.blacklist_status) : 'None recorded'],
      ['NOC', rc.noc_details && rc.noc_details !== '—' ? titleCase(rc.noc_details) : 'None recorded'],
    ], y, { cols: 2 });

    /* ── documents, problems first ── */
    const docs = documentsOf(rc);
    y = T.ensureSpace(doc, y, 110);
    y = T.sectionTitle(doc, 'Documents', y, T.BRAND.brand);
    y = T.table(doc, [
      { label: 'Document', width: W * 0.26 },
      { label: 'Valid until', width: W * 0.20, nowrap: true },
      { label: 'Status', width: W * 0.26 },
      { label: 'Reference', width: W * 0.28 },
    ], docs
      .sort((a, b) => a.days - b.days)
      .map(d => [
        d.label,
        fmt(d.date),
        d.days < 0 ? `Expired ${human(d.days)}` : `Valid, expires ${human(d.days)}`,
        d.label === 'Insurance'
          ? [titleCase(rc.insurance_company), maskNumber(rc.insurance_policy)].filter(Boolean).join(' · ')
          : d.label === 'PUC' ? (maskNumber(rc.pucc_number) || '—')
          : d.label === 'Permit' ? [maskNumber(rc.permit_number), rc.permit_type].filter(Boolean).join(' · ')
          : '—',
      ]), y);

    /* ── challans ── */
    const c = data.challans || {};
    y = T.ensureSpace(doc, y, 100);
    y = T.sectionTitle(doc, 'Traffic Challans', y,
      (c.pending_count || 0) > 0 ? T.BRAND.red || T.BRAND.brand : T.BRAND.green);
    y = T.kvCard(doc, [
      ['Pending challans', String(c.pending_count ?? 0)],
      ['Amount pending', rupees(c.pending_amount_paise)],
      ['Already paid', String(c.disposed_count ?? 0)],
      ['Amount paid', rupees(c.disposed_amount_paise)],
    ], y, { cols: 2 });

    /* WHY A SUMMARY OF OFFENCES BEFORE A LIST OF CHALLANS: this bus has 352
       pending challans. Twelve rows of wrapped offence text is a page of noise
       that answers nothing. What an owner actually needs is "what do I keep
       getting caught for, and what is it costing me" — which is four rows —
       followed by the recent ones as compact single lines they can look up. */
    const top = (c.summary?.top_offences || []).slice(0, 5);
    if (top.length) {
      y = T.ensureSpace(doc, y, 80);
      y = T.table(doc, [
        { label: 'Most frequent offence', width: W * 0.56 },
        { label: 'Times', width: W * 0.14, align: 'right', nowrap: true },
        { label: 'Total', width: W * 0.30, align: 'right', nowrap: true },
      ], top.map(o => [
        printable(String(o.offence || '—').split(';')[0].trim()) || '—',
        String(o.count ?? '—'),
        rupees(o.amount_paise),
      ]), y);
    }

    /* EVERY PENDING CHALLAN, with what and where. The paid report promises
       challan details, and a 350-challan bus is exactly who needs them: which
       offence, on which road, for how much. Each row is exactly two lines —
       offence, then place — because the full wording ran 350 rows to 28 pages;
       the complete offence text is in the summary table above. The newest 150
       are listed (about six pages) and the rest are counted, never hidden. */
    const MAX_PENDING = 150;
    const MAX_DISPOSED = 25;
    const challanCols = [
      { label: 'Date', width: W * 0.13, nowrap: true },
      { label: 'Challan number', width: W * 0.28, nowrap: true },
      { label: 'Offence · place', width: W * 0.45 },
      { label: 'Amount', width: W * 0.14, align: 'right', nowrap: true },
    ];
    const challanRow = (p) => {
      const offence = clip(p.offence || (p.offences || []).map(o => o.name).join('; '), 44) || '—';
      const where = [clip(p.place, 34),
                     p.sent_to_court || p.sent_to_virtual_court ? 'In court' : null]
        .filter(Boolean).join(' · ');
      return [
        fmt(p.challan_date),
        p.challan_no || '—',
        where ? `${offence}\n${where}` : offence,
        rupees(p.amount_paise),
      ];
    };
    const note = (text) => {
      doc.fillColor(T.BRAND.muted).font(doc._F.regular).fontSize(7.6)
         .text(text, T.M, y + 4, { width: W });
      y = doc.y + 8;
    };

    const pending = (c.pending || []).slice(0, MAX_PENDING);
    if (pending.length) {
      y = T.ensureSpace(doc, y, 90);
      y = T.sectionTitle(doc, `Pending challans (${c.pending_count ?? pending.length})`, y,
        T.BRAND.red || T.BRAND.brand);
      y = T.table(doc, challanCols, pending.map(challanRow), y, { rowH: 15, maxRows: MAX_PENDING });
      note((c.pending_count || 0) > pending.length
        ? `Showing the ${pending.length} most recent of ${c.pending_count} pending challans. `
          + 'Every challan number is complete and can be searched on the e-Challan portal.'
        : 'Every challan number is complete and can be searched on the e-Challan portal.');
    }

    const disposed = (c.disposed || []).slice(0, MAX_DISPOSED);
    if (disposed.length) {
      y = T.ensureSpace(doc, y, 90);
      y = T.sectionTitle(doc, `Paid / disposed challans (${c.disposed_count ?? disposed.length})`, y,
        T.BRAND.green || T.BRAND.brand);
      y = T.table(doc, challanCols, disposed.map(challanRow), y, { rowH: 15, maxRows: MAX_DISPOSED });
      if ((c.disposed_count || 0) > disposed.length) {
        note(`Showing the ${disposed.length} most recent of ${c.disposed_count} paid or disposed challans.`);
      }
    }

    /* ── fastag ── */
    const tag = (data.fastag?.tags || [])[0];
    if (tag) {
      y = T.ensureSpace(doc, y, 80);
      y = T.sectionTitle(doc, 'FASTag', y, T.BRAND.brand);
      y = T.kvCard(doc, [
        ['Status', titleCase(tag.status) || '—'],
        ['Issued on', fmt(tag.issue_date)],
        ['Vehicle class', tag.vehicle_class || '—'],
        ['Commercial', tag.commercial ? 'Yes' : 'No'],
      ], y, { cols: 2 });
    }

    /* ── who asked for this ── */
    y = T.ensureSpace(doc, y, 120);
    y = T.sectionTitle(doc, 'Requested By', y, T.BRAND.brand);
    y = T.kvCard(doc, [
      ['Name', requester.name || '—'],
      ['Mobile', requester.mobile || '—'],
      ['Requested on', generatedAt],
      ['Channel', titleCase(requester.channel || 'whatsapp')],
      ['Device', requester.device || '—'],
      ['IP address', requester.ip || '—'],
    ], y, { cols: 2 });

    // The recorded consent, when there is one. Documents issued before consent
    // was frozen onto them keep the general declaration below.
    const frozen = consent || report.consent || null;
    if (frozen) y = consentBlock(doc, y + 8, frozen);

    if (!frozen) doc.fillColor(T.BRAND.muted).font(doc._F.regular).fontSize(7.2)
       .text(
         'Declaration: the requester confirmed that this vehicle and its owner are known to them, '
         + 'and that these details were requested for a lawful and legitimate purpose, taking full '
         + 'responsibility for their use. The owner name is not shown, document numbers are masked, '
         + 'and chassis and engine numbers are never disclosed.',
         T.M, y + 4, { width: W, align: 'justify' });

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      T.watermark(doc);
      T.pageFurniture(doc, {
        page: i + 1, total: range.count, docNumber: report.report_number,
        generatedAt, business,
        disclaimer:
          'All particulars are reproduced as received from Government of India sources through the '
          + 'Unified Logistics Interface Platform (VAHAN, e-Challan, NETC FASTag). These replicas are '
          + 'synchronised periodically and may lag behind the live record at the RTO. GaadiPe does not '
          + 'create, alter or verify this data, and this document is not a Government-issued record. '
          + 'Where anything differs from your papers, the RTO record prevails.',
      });
    }
    doc.end();
  });

module.exports = { buildVehicleReport };
