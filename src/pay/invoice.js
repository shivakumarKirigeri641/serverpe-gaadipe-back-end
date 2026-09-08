/**
 * src/pay/invoice.js
 * ---------------------------------------------------------------------------
 * The GST tax invoice for a payment.
 *
 * This is a statutory document, not a receipt, and three rules follow from that:
 *
 *   * The NUMBER is sequential and never reused, allocated inside the same
 *     transaction that claims it. Two payments arriving in the same second must
 *     not be able to take the same number.
 *
 *   * The ROW is the invoice; the PDF is a rendering of it. A lost file is
 *     regenerated from the row with the same number — which is exactly how
 *     INV20260818GP1 was recovered once already.
 *
 *   * Prices are GST-INCLUSIVE, so the taxable value is backed out of the gross
 *     rather than added to it: Rs.59 is Rs.50.00 + Rs.9.00, not Rs.59 + Rs.10.62.
 *     Place of supply decides CGST+SGST (Karnataka) or IGST (elsewhere).
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { buildInvoice } = require('../pdf/invoice');

const DIR = path.join(__dirname, '..', 'uploads', 'invoices');

/** GST state codes, for the place-of-supply line an invoice must carry. */
const STATES = {
  '01':'Jammu & Kashmir','02':'Himachal Pradesh','03':'Punjab','04':'Chandigarh',
  '05':'Uttarakhand','06':'Haryana','07':'Delhi','08':'Rajasthan','09':'Uttar Pradesh',
  '10':'Bihar','11':'Sikkim','12':'Arunachal Pradesh','13':'Nagaland','14':'Manipur',
  '15':'Mizoram','16':'Tripura','17':'Meghalaya','18':'Assam','19':'West Bengal',
  '20':'Jharkhand','21':'Odisha','22':'Chhattisgarh','23':'Madhya Pradesh','24':'Gujarat',
  '27':'Maharashtra','29':'Karnataka','30':'Goa','32':'Kerala','33':'Tamil Nadu',
  '34':'Puducherry','35':'Andaman & Nicobar','36':'Telangana','37':'Andhra Pradesh',
};

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtDate = (d) => {
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? null
    : `${String(x.getDate()).padStart(2,'0')} ${MONTHS[x.getMonth()]} ${x.getFullYear()}`;
};

/**
 * Next number in the series: INV20260908GP1, GP2, …
 *
 * Allocated with a row lock so concurrent payments cannot collide. document_counters
 * exists for this; if it is empty the sequence starts from what is already issued,
 * so a fresh deployment never reissues a number.
 */
async function nextNumber(c) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  // The counter is per DAY, matching the number format. Postgres does the
  // increment and returns the claimed value in one statement, so two payments
  // landing in the same millisecond get different numbers without any locking
  // of our own.
  const { rows } = await c.query(
    `INSERT INTO document_counters (key, next_value)
          VALUES ($1, 2)
     ON CONFLICT (key) DO UPDATE
            SET next_value = document_counters.next_value + 1,
                modified_at = now()
      RETURNING next_value - 1 AS claimed`, [`invoice:${stamp}`]);

  return `INV${stamp}GP${rows[0].claimed}`;
}

/**
 * Create the invoice row and render the PDF.
 * Idempotent: a payment already invoiced returns the existing one.
 */
async function forPayment(paymentId) {
  const existing = await db.one(
    `SELECT * FROM invoices WHERE payment_id = $1`, [paymentId]);
  if (existing) return { invoice: existing, created: false };

  const pay = await db.one(
    `SELECT p.*, u.mobile, u.wa_profile_name, u.state_code, u.email,
            v.reg_no, s.ends_on, s.starts_on
       FROM payments p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN subscriptions s ON s.id = p.subscription_id
       LEFT JOIN vehicles v ON v.id = s.vehicle_id
      WHERE p.id = $1`, [paymentId]);
  if (!pay) throw new Error(`no payment ${paymentId}`);

  const business = await db.one(
    `SELECT * FROM business_details WHERE is_active ORDER BY id DESC LIMIT 1`) || {};

  const gstPercent = 18;
  const gross = pay.amount_paise;
  const base = Math.round(gross / (1 + gstPercent / 100));
  const tax = gross - base;

  // Place of supply decides the split. Unknown state is treated as home state:
  // GaadiPe sells to consumers, and an unregistered buyer's supply is where the
  // supplier is.
  const home = String(business.home_state_code || '29');
  const buyerState = pay.state_code || home;
  const interstate = String(buyerState) !== home;

  const cgst = interstate ? 0 : Math.round(tax / 2);
  const sgst = interstate ? 0 : tax - cgst;
  const igst = interstate ? tax : 0;

  const row = await db.tx(async (c) => {
    const number = await nextNumber(c);
    const token = crypto.randomBytes(16).toString('hex');
    const { rows } = await c.query(
      `INSERT INTO invoices
         (user_id, subscription_id, payment_id, invoice_number, base_paise,
          gst_percent, cgst_paise, sgst_paise, igst_paise, total_paise,
          place_of_supply, buyer_name, access_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [pay.user_id, pay.subscription_id, pay.id, number, base, gstPercent,
       cgst, sgst, igst, gross, buyerState,
       pay.wa_profile_name || pay.mobile, token]);
    return rows[0];
  });

  // The renderer reads every amount from `invoice`, in RUPEES. Passing them in
  // a separate `gst` object printed a correct invoice with every figure zero —
  // the worst kind of bug in a statutory document, because it looks finished.
  const pdf = await buildInvoice({
    invoice: {
      invoice_number: row.invoice_number,
      invoice_date: row.invoice_date,
      customer_name: row.buyer_name,
      customer_mobile: pay.mobile,
      customer_email: pay.email || null,
      place_of_supply: STATES[buyerState] || 'Karnataka',
      place_of_supply_code: buyerState,
      is_interstate: interstate,
      sac_code: '998319',

      taxable_amount: base / 100,
      cgst_amount: cgst / 100,
      sgst_amount: sgst / 100,
      igst_amount: igst / 100,
      total_tax: tax / 100,
      gross_amount: gross / 100,
    },
    business,
    gst: { cgst_percent: 9, sgst_percent: 9, igst_percent: 18, sac_code: '998319' },
    lineItem: {
      reg_no: pay.reg_no || null,
      // What the money bought, stated as dates rather than "28 days": the
      // question a customer opens an invoice to answer is "until when?"
      description: [
        pay.reg_no ? `GaadiPe Watch — ${pay.reg_no}` : 'GaadiPe Watch',
        pay.starts_on && pay.ends_on
          ? `Monitoring from ${fmtDate(pay.starts_on)} to ${fmtDate(pay.ends_on)}`
          : '28 days monitoring',
        pay.ends_on ? `Renewal due on ${fmtDate(pay.ends_on)}` : null,
      ].filter(Boolean).join('\n'),
      amount: gross / 100,
      // Shown on the invoice so a customer querying a charge on their statement
      // can match it without asking us.
      payment_id: pay.payment_id,
      order_id: pay.order_id,
      method: 'ONLINE',
      paid_at: pay.paid_at,
    },
  });

  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${row.invoice_number}.pdf`);
  fs.writeFileSync(file, pdf);
  await db.query(`UPDATE invoices SET pdf_path = $2 WHERE id = $1`, [row.id, file]);

  console.log('[invoice] %s for payment %d (%d bytes)', row.invoice_number, pay.id, pdf.length);
  return { invoice: { ...row, pdf_path: file }, created: true, pdf, pay };
}

module.exports = { forPayment, nextNumber };
