/**
 * src/owners/checkAlerts.js — "someone checked your vehicle" (user, 2026-10-04).
 *
 * When a person checks a vehicle on WhatsApp or the website, and that
 * vehicle has a VERIFIED OWNER on GaadiPe (owners/photo.js) who — by default —
 * holds a report for it that is still running, the owner is told:
 *
 *   🔔 KA31N8147 was checked on GaadiPe today at 4:12 pm,
 *      by a number ending ••••1234.
 *
 * Never told: the owner checking their own vehicle; the same number checking
 * the same vehicle again within 24 hours. Only the last four digits of the
 * checker's number ever reach the owner — never the number, name or anything
 * else — and the checker is told, on the result, that the owner is informed
 * (owner_check_alert_tell_checker), so nobody is watched without knowing.
 *
 * HOW IT REACHES THEM
 *   window open      a WhatsApp message with "Hide from others" — free
 *   window shut      the approved utility template, if switched on
 *   otherwise        kept, and summarised the next time they write
 *                    ("while you were away, 3 people checked KA31N8147")
 * owner_check_alert_per_day caps the alerts one owner gets in a day; the rest
 * go into that summary.
 *
 * Off until owner_check_alert_on is switched on (Verify owners → settings).
 */

const crypto = require('crypto');
const db = require('../db');
const settings = require('../util/settings');

const SETTINGS = {
  owner_check_alert_on: 'false',
  owner_check_alert_need_report: 'true',
  owner_check_alert_per_day: '10',
  owner_check_alert_tell_checker: 'true',
  owner_check_alert_template_on: 'false',
  owner_check_alert_template_name: 'gp_vehicle_check_alert_v1',
  owner_check_alert_template_language: 'en',
  // Other numbers whose checks never alert anyone (test phones, family)
  owner_check_alert_ignore_numbers: '',
};

const ten = (m) => String(m || '').replace(/\D/g, '').slice(-10);

/**
 * Checks by these numbers never alert an owner: every admin login's mobile
 * (admin_users — active or not), the admin WhatsApp numbers (Settings →
 * admin_whatsapp_numbers), and owner_check_alert_ignore_numbers. A number
 * that cannot be read counts as exempt: when in doubt, say nothing.
 */
async function exempt(checker) {
  const m = ten(checker);
  if (m.length !== 10) return true;
  const listed = `${await settings.get('admin_whatsapp_numbers', '')},${await settings.get('owner_check_alert_ignore_numbers', '')}`
    .split(/[,\s;]+/).map(ten).filter((x) => x.length === 10);
  if (listed.includes(m)) return true;
  const admin = await db.one(`SELECT 1 AS x FROM admin_users WHERE mobile = $1 LIMIT 1`, [m]).catch(() => ({ x: 1 }));
  return Boolean(admin);
}

/*
 * The same three buttons on the free message and on the approved template
 * (whose quick replies arrive as their text), so one handler serves both:
 * flow.js → checkAlerts.button().
 */
const ALERT_BUTTONS = [
  { id: 'calert_hide', title: 'Hide my vehicle' },
  { id: 'calert_ok', title: "That's fine" },
  { id: 'calert_stop', title: 'Stop these alerts' },
];
const BUTTON_BY_TEXT = { 'hide my vehicle': 'calert_hide', "that's fine": 'calert_ok', 'thats fine': 'calert_ok', 'stop these alerts': 'calert_stop' };

const hash = (m) => crypto.createHash('sha256').update(`gp-checker|${String(m).slice(-10)}`).digest('hex').slice(0, 32);
const when = (d) => new Date(d).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
});

/** The verified owners of this vehicle who would be told of a check by `checker`. */
async function ownersToTell(regNo, checker) {
  if (!await settings.bool('owner_check_alert_on', false)) return [];
  // THE ADMIN NEVER TRIGGERS AN ALERT (user, 2026-10-04): checks for testing
  // or convenience must not reach an owner. Asked here, the one door every
  // alert passes through, so no check path can forget it.
  if (await exempt(checker)) return [];
  const needReport = await settings.bool('owner_check_alert_need_report', true);
  const { rows } = await db.query(
    `SELECT DISTINCT c.mobile FROM vehicle_owner_claims c
      WHERE c.reg_no = $1 AND c.status = 'verified' AND c.mobile IS DISTINCT FROM $2 AND c.check_alerts_off_at IS NULL
        AND ($3 = false OR EXISTS (
              SELECT 1 FROM vehicle_reports r JOIN users u ON u.id = r.user_id
               WHERE u.mobile = c.mobile AND r.reg_no = c.reg_no AND r.valid_until > now()))`,
    [regNo, checker ? String(checker).slice(-10) : null, needReport]);
  return rows.map((r) => r.mobile);
}

/** The line shown to the person checking, when the owner will be told (or null). */
async function checkerNotice(regNo, checker) {
  if (!await settings.bool('owner_check_alert_tell_checker', true)) return null;
  return (await ownersToTell(regNo, checker)).length
    ? '🔔 _This vehicle\'s owner is verified on GaadiPe and is told when it is checked (with the last 4 digits of your number)._'
    : null;
}

/**
 * A check happened. Records an alert for each owner to tell, and tells them
 * now if it can. Never throws; never slows the check down (call without await).
 */
async function noteCheck({ regNo, checker, channel = 'whatsapp' }) {
  try {
    if (!regNo || !checker) return;
    const owners = await ownersToTell(regNo, checker);
    if (!owners.length) return;
    const h = hash(checker);
    const recent = await db.one(
      `SELECT 1 AS x FROM owner_check_alerts WHERE reg_no = $1 AND checker_hash = $2 AND created_at > now() - interval '24 hours' LIMIT 1`,
      [regNo, h]);
    if (recent) return;
    for (const owner of owners) {
      const row = await db.one(
        `INSERT INTO owner_check_alerts (owner_mobile, reg_no, checker_last4, checker_hash, channel)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`, [owner, regNo, String(checker).slice(-4), h, channel]);
      await tell(row);
    }
  } catch (e) {
    console.error('[check-alert] %s: %s', regNo, e.message);
  }
}

/** Tell one owner about one check, now if possible. */
async function tell(a) {
  const send = require('../whatsapp/send');
  const cap = await settings.num('owner_check_alert_per_day', 10);
  const today = await db.one(
    `SELECT count(*)::int AS n FROM owner_check_alerts WHERE owner_mobile = $1 AND status IN ('sent', 'template')
       AND sent_at > now() - interval '24 hours'`, [a.owner_mobile]);
  if (today.n >= cap) return;   // kept: summarised when they next write

  if (await send.windowOpen(a.owner_mobile)) {
    const out = await send.buttons(a.owner_mobile,
      `🔔 *Your vehicle was checked*\n\n*${a.reg_no}* was checked on GaadiPe on *${when(a.created_at)}*, `
      + `by a number ending *••••${a.checker_last4}*.\n\n`
      + 'They see the vehicle\'s public details only — never your name, number or address.\n\n'
      + 'Expecting it (a buyer, a mechanic, the insurer)? Nothing to do. If not, you can hide your vehicle from other people\'s checks.',
      ALERT_BUTTONS);
    if (out.ok) {
      await db.query(`UPDATE owner_check_alerts SET status = 'sent', sent_at = now() WHERE id = $1`, [a.id]);
      await remember(a.owner_mobile, a.reg_no);
    }
    return;
  }
  if (await settings.bool('owner_check_alert_template_on', false)) {
    const out = await send.template(a.owner_mobile,
      String(await settings.get('owner_check_alert_template_name', 'gp_vehicle_check_alert_v1')),
      [a.reg_no, when(a.created_at), a.checker_last4],
      { language: String(await settings.get('owner_check_alert_template_language', 'en')) }).catch((e) => ({ ok: false, error: e.message }));
    if (out.ok) {
      await db.query(`UPDATE owner_check_alerts SET status = 'template', sent_at = now() WHERE id = $1`, [a.id]);
      await remember(a.owner_mobile, a.reg_no);
    } else console.error('[check-alert] template to ••••%s: %s', String(a.owner_mobile).slice(-4), out.error);
  }
}

/** "Hide from others" acts on this vehicle. */
const remember = (mobile, regNo) => db.query(
  `UPDATE whatsapp_sessions SET context = context || $2::jsonb, modified_at = now() WHERE mobile = $1`,
  [mobile, JSON.stringify({ ov_reg: regNo })]).catch(() => {});

/** Alerts not yet told, as one summary — when the owner writes (flow.js). */
async function deliverPending(mobile) {
  const { rows } = await db.query(
    `SELECT reg_no, count(*)::int AS n, max(created_at) AS last,
            array_agg(DISTINCT checker_last4) AS last4s
       FROM owner_check_alerts WHERE owner_mobile = $1 AND status = 'pending'
      GROUP BY reg_no`, [mobile]);
  if (!rows.length) return;
  const send = require('../whatsapp/send');
  if (!await send.windowOpen(mobile)) return;
  const lines = rows.map((r) => `• *${r.reg_no}* — ${r.n} check${r.n === 1 ? '' : 's'}, last on ${when(r.last)} `
    + `(numbers ending ${r.last4s.slice(0, 5).map((x) => `••••${x}`).join(', ')}${r.last4s.length > 5 ? '…' : ''})`);
  const out = await send.buttons(mobile,
    `🔔 *While you were away, your vehicle${rows.length === 1 ? ' was' : 's were'} checked on GaadiPe*\n\n${lines.join('\n')}\n\n`
    + 'They see public vehicle details only — never your name, number or address.',
    ALERT_BUTTONS);
  if (out.ok) {
    await db.query(`UPDATE owner_check_alerts SET status = 'summarised', sent_at = now() WHERE owner_mobile = $1 AND status = 'pending'`, [mobile]);
    await remember(mobile, rows[0].reg_no);
  }
}

/* ─────────────────────────── the admin panel ─────────────────────────── */

async function getSettings() {
  const out = {};
  for (const [k, d] of Object.entries(SETTINGS)) out[k] = String(await settings.get(k, d));
  return out;
}

async function saveSettings(changes = {}, adminId) {
  const clean = {};
  for (const k of Object.keys(changes).filter((x) => x in SETTINGS)) {
    let v = String(changes[k] ?? '').trim();
    if (/_on$|_need_report$|_tell_checker$/.test(k)) v = v === 'true' ? 'true' : 'false';
    else if (/_name$/.test(k)) v = v.replace(/[^a-z0-9_]/gi, '').toLowerCase().slice(0, 100);
    else if (/_language$/.test(k)) v = v.replace(/[^a-z_]/gi, '').slice(0, 10) || 'en';
    else if (/_numbers$/.test(k)) {
      v = v.split(/[,\s;]+/).map(ten).filter((x) => x.length === 10).join(', ');
    } else {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < 1 || n > 1000) throw Object.assign(new Error(`${k} must be a number from 1 to 1000.`), { status: 400 });
      v = String(n);
    }
    clean[k] = v;
  }
  for (const [k, v] of Object.entries(clean)) {
    await db.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now()`, [k, v]);
  }
  await settings.refresh?.();
  await require('../admin/auth').audit({ adminId, action: 'owner_check_alert_settings', detail: clean });
  return getSettings();
}

/** The latest alerts, for the panel (owner shown as last 4 digits too). */
async function recent(limit = 50) {
  const { rows } = await db.query(
    `SELECT id, owner_mobile, reg_no, checker_last4, channel, status, sent_at, created_at
       FROM owner_check_alerts ORDER BY id DESC LIMIT $1`, [limit]);
  const totals = await db.one(
    `SELECT count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS today,
            count(*) FILTER (WHERE status = 'pending')::int AS waiting, count(*)::int AS total FROM owner_check_alerts`);
  return {
    totals,
    rows: rows.map((r) => ({ ...r, id: String(r.id), owner: `••••••${String(r.owner_mobile).slice(-4)}`, owner_mobile: undefined })),
  };
}

/** The vehicle the owner's latest alert was about (what "Hide my vehicle" hides). */
async function latestReg(mobile) {
  const r = await db.one(
    `SELECT reg_no FROM owner_check_alerts WHERE owner_mobile = $1 AND status <> 'pending' ORDER BY coalesce(sent_at, created_at) DESC LIMIT 1`, [mobile]);
  return r?.reg_no || null;
}

/**
 * A tap on an alert's button — by id (the free message) or by its text (the
 * template's quick reply) — or "ALERTS ON". Returns true when it was handled.
 */
async function button(mobile, { id, text }) {
  const t = String(text || '').trim().toLowerCase().replace(/[’']/g, "'");
  if (/^alerts? on$/.test(t)) {
    if (!await db.one(`SELECT 1 AS x FROM vehicle_owner_claims WHERE mobile = $1 AND status = 'verified' LIMIT 1`, [mobile])) return false;
    const { rowCount } = await db.query(
      `UPDATE vehicle_owner_claims SET check_alerts_off_at = NULL WHERE mobile = $1 AND status = 'verified' AND check_alerts_off_at IS NOT NULL`, [mobile]);
    const send = require('../whatsapp/send');
    await send.text(mobile, rowCount
      ? '🔔 Done — you will be told again when someone checks your vehicle on GaadiPe.'
      : 'Check alerts are already on for your verified vehicles. 🔔');
    return true;
  }
  const which = ['calert_hide', 'calert_ok', 'calert_stop'].includes(id) ? id : BUTTON_BY_TEXT[t];
  if (!which) return false;
  const send = require('../whatsapp/send');
  const reg = await latestReg(mobile);
  // Typed words from someone who never had an alert are not a tap.
  if (!reg && !id?.startsWith('calert_')) return false;
  if (which === 'calert_ok') {
    await send.text(mobile, '👍 Noted — nothing to do. We will keep telling you when your vehicle is checked.');
    return true;
  }
  if (which === 'calert_stop') {
    await db.query(`UPDATE vehicle_owner_claims SET check_alerts_off_at = now() WHERE mobile = $1 AND status = 'verified'`, [mobile]);
    await send.text(mobile, '🔕 Done — you will not be told about checks of your vehicles any more.\n\nTo turn them on again, send *ALERTS ON*.');
    return true;
  }
  // Hide: the vehicle of their latest alert.
  const done = reg && await require('./verify').setHidden(mobile, reg, true);
  await send.buttons(mobile, done
    ? `🙈 Done — *${reg}* is now *hidden*. People checking it on GaadiPe are told the owner keeps it private. You still see it.`
    : 'I could not find which vehicle to hide. Tap *More* → *I own a vehicle* to see your vehicles.',
  done ? [{ id: 'owner_show', title: 'Show it again' }, { id: 'check_another', title: 'Check vehicle' }]
    : [{ id: 'menu', title: 'More' }]);
  return true;
}

module.exports = { button, exempt, noteCheck, checkerNotice, deliverPending, getSettings, saveSettings, recent, _test: { hash } };
