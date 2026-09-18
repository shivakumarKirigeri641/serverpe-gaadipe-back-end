/**
 * src/pdf/consent.js — the consent record, drawn the same way on every document.
 *
 * One function for the report and the invoice, so the two can never disagree
 * about what the customer agreed to. Everything it prints was recorded at the
 * time: the declaration in the words shown, when it was ticked, from where,
 * the policy versions in force, and a reference back to the log entry.
 *
 * If a value was not recorded it is left out, not filled in. A consent record
 * that invents a missing IP address is worse than one that admits it has none.
 */

const T = require('./theme');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* Written in IST whatever the server's own zone, and spelt the way every other
   date in these documents is — the locale's own format writes "Sept", and a
   document that disagrees with itself about the month looks edited. */
const IST = (v) => {
  if (!v) return null;
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) return null;
  const d = new Date(t + 5.5 * 60 * 60 * 1000);           // shift to IST, read as UTC
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} IST`;
};

/**
 * Draw the block. Returns the y to continue from.
 * `compact` is for the invoice, where the record sits under the totals.
 */
function consentBlock(doc, y, consent, { compact = false } = {}) {
  if (!consent) return y;
  const W = doc.page.width - T.M * 2;
  const v = consent.versions || {};

  y = T.ensureSpace(doc, y, compact ? 120 : 170);
  y = T.sectionTitle(doc, compact ? 'Consent on record' : 'Declaration & consent', y, T.BRAND.brand);

  /* The invoice has one page to hold everything a tax invoice must, so its
     copy of the record keeps the evidence and drops what is evident: the
     channel (the IP and device already say where), and the three policy
     versions on one line instead of two. */
  const policies = [v.terms && `T ${v.terms}`, v.privacy && `P ${v.privacy}`, v.refund && `R ${v.refund}`]
    .filter(Boolean).join(' · ') || null;
  const rows = compact ? [
    ['Purpose declared', consent.declared ? 'Yes, ticked' : 'On purchase'],
    ['Declared at', IST(consent.declared_at)],
    ['From IP', consent.ip],
    ['Device', consent.device],
    ['Record reference', consent.declaration_ref],
    ['Policy versions', policies],
  ].filter(([, value]) => value) : [
    ['Purpose declared', consent.declared ? 'Yes, ticked' : 'On purchase'],
    ['Declared at', IST(consent.declared_at)],
    ['Channel', consent.channel === 'web' ? 'gaadipe.in (web)' : 'WhatsApp'],
    ['From IP', consent.ip],
    ['Device', consent.device],
    ['Record reference', consent.declaration_ref],
    ['Terms accepted', IST(consent.terms_accepted_at)],
    ['Terms · Privacy', [v.terms && `v${v.terms}`, v.privacy && `v${v.privacy}`].filter(Boolean).join(' · ') || null],
    ['Refund policy', v.refund ? `v${v.refund} (sales final)` : null],
  ].filter(([, value]) => value);

  y = T.kvCard(doc, rows, y, { cols: 2 });

  // The declaration itself, in the words the requester ticked.
  const words = consent.declaration
    || 'The requester confirmed that this vehicle and its owner are known to them, and that these '
       + 'details were requested for a lawful and legitimate purpose, taking full responsibility for their use.';

  if (!compact) {
    doc.fillColor(T.BRAND.ink).font(doc._F.bold).fontSize(7.8)
       .text('Declaration by the requester', T.M, y + 2, { width: W });
  }
  doc.fillColor(T.BRAND.body).font(doc._F.oblique).fontSize(7.8)
     .text(`${compact ? 'Declared: ' : ''}“${words}”`, T.M, compact ? y + 2 : doc.y + 2,
       { width: W, align: 'justify' });

  // What the purchase meant, stated once, in plain terms. The invoice carries
  // the same terms in its footer already, so there the paragraph is left out
  // rather than repeated — a one-page invoice is worth more than a second copy.
  if (compact) return doc.y + 10;

  doc.fillColor(T.BRAND.muted).font(doc._F.regular).fontSize(7.2)
     .text(
       'This document was supplied on that declaration. It is a reproduction of Government records '
       + '(VAHAN, e-Challan, NETC FASTag) for the stated purpose only; it is not a Government-issued '
       + 'record. The owner’s name, chassis and engine numbers are not disclosed and document numbers '
       + 'are masked. The requester is solely responsible for any use of this content. The report is a '
       + 'digital supply delivered on payment, and the purchase is final and non-refundable under the '
       + `Refund Policy${v.refund ? ` v${v.refund}` : ''}. ServerPe App Solutions is not responsible for `
       + 'any misuse, or for decisions made on the basis of this document.',
       T.M, doc.y + 5, { width: W, align: 'justify' });

  return doc.y + 10;
}

/** One line for a page footer, where there is no room for the block. */
function consentLine(consent) {
  if (!consent) return null;
  const parts = [
    consent.declared ? 'Purpose declared and consent recorded' : 'Consent recorded',
    IST(consent.declared_at) && `on ${IST(consent.declared_at)}`,
    consent.ip && `from ${consent.ip}`,
    consent.declaration_ref && `(ref ${consent.declaration_ref})`,
  ].filter(Boolean);
  return `${parts.join(' ')}. Sales are final; the requester is responsible for any use of this document.`;
}

module.exports = { consentBlock, consentLine, IST };
