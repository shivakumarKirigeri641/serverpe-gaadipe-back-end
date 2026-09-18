/**
 * src/pay/consent.js — the evidence that a purchase was agreed to, in one shape.
 *
 * WHY THIS IS PRINTED ON THE DOCUMENTS, not only kept in a table: a report or an
 * invoice travels. It is forwarded to a seller, shown to a bank, attached to a
 * complaint. If its use is ever questioned, the document itself should answer
 * who asked for it, what they declared, which terms they accepted and when —
 * without anybody having to trust that our database says the same.
 *
 * FROZEN AT ISSUE. The evidence is copied onto the report and invoice rows when
 * they are created, and the PDF is drawn from that copy. A regenerated document
 * must say exactly what the original said; re-reading the log later could pick
 * up a newer record and quietly change a numbered document.
 */

const db = require('../db');
const { describeDevice } = require('./report');

/** The version of each customer-facing policy in force right now. */
async function policyVersions() {
  const row = await db.one(
    `SELECT
       (SELECT max(version) FROM terms_and_conditions WHERE is_active) AS terms,
       (SELECT max(version) FROM privacy_policy       WHERE is_active) AS privacy,
       (SELECT max(version) FROM refund_policy        WHERE is_active) AS refund`);
  return { terms: row?.terms || null, privacy: row?.privacy || null, refund: row?.refund || null };
}

/**
 * Everything on record for one payment, ready to print.
 *
 * The purchase declaration is found by the payment row it covers; a purchase
 * made on WhatsApp before declarations were tied to payments falls back to the
 * latest one for that customer and vehicle. The terms acceptance is the latest
 * one before the payment — which is the agreement the purchase was made under.
 */
async function forPayment({ paymentRowId, userId, vehicleId }) {
  let purchase = paymentRowId ? await db.one(
    `SELECT id, created_at, detail FROM event_log
      WHERE kind = 'purchase_consent' AND detail->>'payment_row' = $1
      ORDER BY id DESC LIMIT 1`, [String(paymentRowId)]) : null;

  if (!purchase && userId) {
    purchase = await db.one(
      `SELECT id, created_at, detail FROM event_log
        WHERE kind = 'purchase_consent' AND user_id = $1
          AND ($2::bigint IS NULL OR vehicle_id = $2)
        ORDER BY id DESC LIMIT 1`, [userId, vehicleId || null]);
  }

  const terms = userId ? await db.one(
    `SELECT id, created_at, detail FROM event_log
      WHERE kind = 'consent_accepted' AND user_id = $1
      ORDER BY id DESC LIMIT 1`, [userId]) : null;

  const d = purchase?.detail || {};
  const versions = await policyVersions();

  return {
    // The declaration of purpose, exactly as it was shown and ticked.
    declaration: d.declaration || null,
    declared: d.declared === true,
    declared_at: purchase?.created_at || d.at || null,
    declaration_ref: purchase ? `C-${purchase.id}` : null,
    channel: d.channel || 'whatsapp',
    ip: d.ip || null,
    device: describeDevice(d.user_agent) || null,

    // The agreement the purchase was made under.
    terms_accepted_at: terms?.created_at || null,
    terms_ref: terms ? `C-${terms.id}` : null,
    documents: d.documents || terms?.detail?.documents || ['terms', 'privacy', 'refund'],
    versions: {
      terms: terms?.detail?.policy_version || versions.terms,
      privacy: versions.privacy,
      refund: versions.refund,
    },
  };
}

module.exports = { forPayment, policyVersions };
