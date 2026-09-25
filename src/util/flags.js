/**
 * src/util/flags.js — GaadiPe's feature switches (user, 2026-09-25,
 * operations module phase 6). Each is a setting, changed from Feature Flags
 * in the admin panel (confirmed, audited), and read here — cached a few
 * seconds, so a switch takes effect within a quarter of a minute.
 *
 *   whatsapp_flow      the bot answers on WhatsApp (STOP / START always work)
 *   website_flow       the website's customer actions (checks, sign-in, buying)
 *   payments           new checkouts can be opened (paid ones still complete)
 *   vehicle_api        lookups reach the Government records
 *   report_generation  paid reports are issued (a paid customer is told it is
 *                      coming and can ask again; the admin sees an alert)
 *   maintenance_mode   customers are told GaadiPe is under maintenance on
 *                      WhatsApp and the website, and no new checkout opens.
 *                      The admin panel keeps working.
 *
 * Referral is not here: the programme is off (user, 2026-09-25).
 */

const settings = require('./settings');

const FLAGS = {
  whatsapp_flow: { key: 'flag_whatsapp_flow', default: true, label: 'WhatsApp flow', danger: true,
    about: 'The WhatsApp bot answers customers. Off: customers get a short “back soon” reply (at most every 30 minutes); STOP and START still work.' },
  website_flow: { key: 'flag_website_flow', default: true, label: 'Website flow', danger: true,
    about: 'Customer actions on the website — vehicle checks, sign-in, buying. Off: they are refused with a “back soon” message; pages still load.' },
  payments: { key: 'flag_payments', default: true, label: 'Payments', danger: true,
    about: 'New checkouts can be opened. Off: no new payment starts; payments already made still complete and deliver.' },
  vehicle_api: { key: 'flag_vehicle_api', default: true, label: 'Vehicle API', danger: true,
    about: 'Lookups reach the Government records. Off: every lookup answers “service temporarily unavailable” — including the panel’s own checks.' },
  report_generation: { key: 'flag_report_generation', default: true, label: 'Report generation', danger: true,
    about: 'Paid reports are issued. Off: a paying customer is told the report is not ready and can ask again; “Paid reports not generated” alerts will fire.' },
  maintenance_mode: { key: 'maintenance_mode', default: false, label: 'Maintenance mode', danger: true, inverted: true,
    about: 'On: customers are told GaadiPe is under maintenance on WhatsApp and the website, and no new checkout opens. The admin panel keeps working.' },
};

const MESSAGE = 'GaadiPe is under brief maintenance. Please try again in a little while — nothing you have paid for is affected.';

let cache = { at: 0, v: null };
async function all() {
  if (cache.v && Date.now() - cache.at < 15000) return cache.v;
  const v = {};
  for (const [name, f] of Object.entries(FLAGS)) {
    const raw = await settings.get(f.key, null);
    v[name] = raw == null || raw === '' ? f.default : String(raw) === 'true';
  }
  cache = { at: Date.now(), v };
  return v;
}
const forget = () => { cache.at = 0; };

/** Is this part of GaadiPe working for customers right now? */
async function on(name) {
  const v = await all();
  if (name === 'maintenance_mode') return v.maintenance_mode;
  if (['whatsapp_flow', 'website_flow', 'payments'].includes(name) && v.maintenance_mode) return false;
  return v[name] !== false;
}

module.exports = { FLAGS, all, on, forget, MESSAGE };
