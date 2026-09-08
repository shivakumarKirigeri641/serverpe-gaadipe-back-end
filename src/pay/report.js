/**
 * src/pay/report.js
 * ---------------------------------------------------------------------------
 * Issue a vehicle report as a numbered document, and remember who asked.
 *
 * Same shape as an invoice, for the same reasons: the ROW is the record, the
 * PDF is a rendering of it, and the number is sequential and never reused. A
 * lost file is regenerated identically from the stored snapshot — not from
 * today's data, which would quietly produce a different document under the same
 * number.
 *
 * The requester's details are the part that matters legally. The Terms say a
 * report is issued to someone who declared a lawful purpose; that declaration
 * is worth nothing unless it is attached to a person, a moment and a device.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { buildVehicleReport } = require('../pdf/vehicleReport');

const DIR = path.join(__dirname, '..', 'uploads', 'reports');

/**
 * "Android 13 · Chrome 128" from a user-agent string.
 *
 * Deliberately a few regexes rather than a dependency: this is written to a
 * record for a human to read later, not parsed by anything, and a wrong guess
 * costs nothing while a supply-chain dependency costs plenty.
 */
function describeDevice(ua) {
  if (!ua) return null;
  const s = String(ua);

  const os = /Android\s+([\d.]+)/.exec(s) ? `Android ${/Android\s+([\d.]+)/.exec(s)[1]}`
    : /iPhone OS ([\d_]+)/.exec(s) ? `iOS ${/iPhone OS ([\d_]+)/.exec(s)[1].replace(/_/g, '.')}`
    : /Windows NT ([\d.]+)/.test(s) ? 'Windows'
    : /Mac OS X/.test(s) ? 'macOS'
    : /Linux/.test(s) ? 'Linux' : null;

  const browser = /Edg\/([\d.]+)/.exec(s) ? `Edge ${/Edg\/(\d+)/.exec(s)[1]}`
    : /OPR\/([\d.]+)/.exec(s) ? `Opera ${/OPR\/(\d+)/.exec(s)[1]}`
    : /Chrome\/([\d.]+)/.exec(s) ? `Chrome ${/Chrome\/(\d+)/.exec(s)[1]}`
    : /Version\/([\d.]+).*Safari/.exec(s) ? `Safari ${/Version\/(\d+)/.exec(s)[1]}`
    : /Firefox\/([\d.]+)/.exec(s) ? `Firefox ${/Firefox\/(\d+)/.exec(s)[1]}`
    : null;

  const kind = /Mobile|Android|iPhone/.test(s) ? 'Mobile'
    : /iPad|Tablet/.test(s) ? 'Tablet' : 'Desktop';

  return [kind, os, browser].filter(Boolean).join(' · ');
}

/** RPT20260908GP1, RPT20260908GP2, … — same scheme as invoices. */
async function nextNumber(c) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const { rows } = await c.query(
    `INSERT INTO document_counters (key, next_value)
          VALUES ($1, 2)
     ON CONFLICT (key) DO UPDATE
            SET next_value = document_counters.next_value + 1, modified_at = now()
      RETURNING next_value - 1 AS claimed`, [`report:${stamp}`]);
  return `RPT${stamp}GP${rows[0].claimed}`;
}

/**
 * Issue a report for a vehicle.
 *
 * @param {object} data       a gateway /vehicle/:regNo response
 * @param {object} requester  { mobile, name, ip, userAgent, channel }
 */
async function issue({ userId, vehicleId, paymentId, subscriptionId, regNo, data, requester = {} }) {
  const business = await db.one(
    `SELECT * FROM business_details WHERE is_active ORDER BY id DESC LIMIT 1`) || {};

  const device = describeDevice(requester.userAgent);

  const row = await db.tx(async (c) => {
    const number = await nextNumber(c);
    const { rows } = await c.query(
      `INSERT INTO vehicle_reports
         (report_number, user_id, vehicle_id, payment_id, subscription_id, reg_no,
          requested_by, requester_name, ip, user_agent, device, channel,
          snapshot, access_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [number, userId || null, vehicleId || null, paymentId || null, subscriptionId || null,
       regNo, requester.mobile || null, requester.name || null,
       requester.ip || null, requester.userAgent || null, device,
       requester.channel || 'whatsapp',
       JSON.stringify(data), crypto.randomBytes(16).toString('hex')]);
    return rows[0];
  });

  const pdf = await buildVehicleReport({
    report: row,
    business,
    data,
    requester: {
      name: requester.name, mobile: requester.mobile,
      ip: requester.ip, device, channel: requester.channel || 'whatsapp',
    },
  });

  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${row.report_number}.pdf`);
  fs.writeFileSync(file, pdf);
  await db.query(`UPDATE vehicle_reports SET pdf_path = $2 WHERE id = $1`, [row.id, file]);

  console.log('[report] %s for %s (%d bytes)', row.report_number, regNo, pdf.length);
  return { report: { ...row, pdf_path: file }, pdf };
}

/** The latest report for a vehicle this person can see. */
const latestFor = (userId, regNo) => db.one(
  `SELECT * FROM vehicle_reports
    WHERE user_id = $1 AND reg_no = $2
    ORDER BY id DESC LIMIT 1`, [userId, regNo]);

module.exports = { issue, latestFor, describeDevice, nextNumber };
