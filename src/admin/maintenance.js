/**
 * src/admin/maintenance.js — clearing test data from the panel.
 *
 * WHAT IS CLEARED is everything a customer or a test run creates: people,
 * vehicles, lookups, conversations, payments, reports, invoices and their PDFs.
 *
 * WHAT IS KEPT is everything that configures the product: panel users and their
 * audit trail, settings, plans, policy text, business details and the block
 * list. The clean itself is written to the audit trail, which is exactly why the
 * trail is not in the list — a wipe that erases the record of the wipe is how a
 * database ends up empty with nobody able to say why.
 *
 * REFUSED IN PRODUCTION unless ALLOW_DB_CLEAN=1 is set deliberately. On a live
 * database this deletes customers' invoices, which the law requires be kept.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db');
const { config } = require('../config');
const { audit } = require('./auth');

/* Order does not matter to TRUNCATE ... CASCADE, but grouping reads better. */
const TABLES = [
  // people and what they did
  'users', 'user_vehicles', 'site_sessions', 'site_otps', 'feedback', 'event_log',
  // vehicles and lookups
  'vehicles', 'vehicle_snapshots', 'vehicle_changes', 'vehicle_verifications', 'api_calls',
  // conversations
  'whatsapp_sessions', 'whatsapp_messages', 'whatsapp_status_logs', 'otp_challenges', 'alerts',
  // money and documents
  'payments', 'subscriptions', 'watches', 'invoices', 'vehicle_reports', 'document_counters',
  // partners
  'partners', 'partner_referrals', 'partner_commissions', 'partner_payouts',
];

const allowed = () => config.env !== 'production' || process.env.ALLOW_DB_CLEAN === '1';

/** Only tables that exist — a table added later must not break the clean. */
async function existing() {
  const { rows } = await db.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`, [TABLES]);
  return rows.map(r => r.tablename);
}

/** What a clean would remove, so the screen can say it before anyone confirms. */
async function preview() {
  const counts = {};
  for (const t of await existing()) {
    counts[t] = (await db.one(`SELECT count(*)::int AS n FROM "${t}"`)).n;
  }
  return { allowed: allowed(), env: config.env, counts,
           total: Object.values(counts).reduce((a, b) => a + b, 0) };
}

async function clean({ adminId, ip }) {
  if (!allowed()) {
    return { ok: false, message: 'Cleaning is switched off on a production server. '
      + 'Customers’ invoices here are statutory records.' };
  }

  const before = await preview();
  const tables = await existing();
  if (tables.length) {
    await db.query(`TRUNCATE ${tables.map(t => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  }

  // The PDFs go too: a file with no row behind it is a document nobody can
  // account for.
  let files = 0;
  for (const dir of ['reports', 'invoices']) {
    const full = path.join(__dirname, '..', 'uploads', dir);
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full)) {
      if (f.endsWith('.pdf')) { fs.unlinkSync(path.join(full, f)); files++; }
    }
  }

  await audit({ adminId, action: 'database_cleaned', ip,
                detail: { rows: before.total, files, tables: before.counts } });

  return { ok: true, rows: before.total, files };
}

module.exports = { preview, clean, allowed };
