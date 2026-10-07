/**
 * src/site/chat.js — THE CHAT ON gaadipe.in (user, 2026-10-07: "a chat in the
 * browser, like WhatsApp but better; the basic check without a phone number,
 * then sign in for more; an existing customer sees their WhatsApp history").
 *
 *   anonCheck(req)        the free basic check for someone not signed in
 *   history(user, opts)   their GaadiPe WhatsApp conversation, as chat items
 *   summary(user)         "welcome back": vehicles, paid reports, last check
 *
 * THE ANONYMOUS CHECK costs nothing and gives nothing away:
 *   - free sources only (ULIP, then eChallan.app) — never the paid RC backup
 *   - the same basic view a signed-in free check shows (site/vehicleView.basic)
 *   - the scraping guard, the block list and owner-hidden vehicles, as /check
 *   - at most chat_anon_checks_per_day per device (3) and per address (10)
 * Everything beyond it — the full report, history, alerts — needs a sign-in.
 *
 * THE HISTORY is shown only to the signed-in owner of the number (they proved
 * it with the SMS code), newest last, a page at a time. It is READ from
 * whatsapp_messages and never copied.
 */

const crypto = require('crypto');
const db = require('../db');
const plate = require('../util/plate');
const settings = require('../util/settings');
const gateway = require('../vehicle/gateway');
const view = require('./vehicleView');
const blocks = require('../admin/blocks');

const hash = (v) => crypto.createHash('sha256').update(String(v || '')).digest('hex').slice(0, 24);

async function freeDetail() {
  const v = String(await settings.get('free_view_detail', 'count')).toLowerCase();
  return ['labels', 'count', 'none'].includes(v) ? v : 'count';
}

/** The basic check for a visitor who has not signed in. */
async function anonCheck(req) {
  const parsed = plate.parse(req.body?.reg_no);
  if (!parsed.ok) return { status: 400, body: { error: 'bad_plate', message: parsed.error } };

  const device = String(req.body?.client?.device_id || req.get('x-gp-device') || '').slice(0, 64);
  const ip = hash(req.ip);
  const perDevice = await settings.num('chat_anon_checks_per_day', 3);
  const perIp = await settings.num('chat_anon_checks_per_day_ip', 10);
  const used = await db.one(
    `SELECT count(*) FILTER (WHERE $1 <> '' AND detail->>'device' = $1)::int AS device,
            count(*) FILTER (WHERE detail->>'ip' = $2)::int AS ip
       FROM event_log
      WHERE kind = 'chat_anon_check'
        AND created_at > date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`,
    [device, ip]);
  if (used.device >= perDevice || used.ip >= perIp) {
    return { status: 429, body: { error: 'sign_in_needed',
      message: `You have used today's ${perDevice} free checks without signing in. Sign in with your mobile number to keep checking — it takes a few seconds.` } };
  }

  const scan = await require('../security/guard').noteVehicleCheck(req, parsed.regNo);
  if (!scan.ok) {
    return { status: 429, body: { error: 'too_many_vehicles',
      message: 'That is a lot of vehicles in a short time. Please try again in an hour.' } };
  }
  if (await blocks.isBlocked('vehicle', parsed.regNo)
      || await require('../owners/verify').hiddenFrom(null, parsed.regNo)) {
    return { status: 403, body: { error: 'blocked',
      message: 'This vehicle cannot be checked here. If it is yours, please write to support@gaadipe.in.' } };
  }

  // Free sources only: an anonymous visitor never costs an IDSPay call.
  const data = await gateway.full(parsed.regNo, { backup: 0 });
  await db.query(`INSERT INTO event_log (kind, detail) VALUES ('chat_anon_check', $1)`,
    [JSON.stringify({ device, ip, reg_no: parsed.regNo, found: data?.success === true })]).catch(() => {});

  if (!data?.success) {
    return { status: data?.error === 'vehicle_not_found' ? 404 : 503, body: {
      error: data?.error || 'unavailable',
      message: data?.error === 'vehicle_not_found'
        ? `No Government record was found for ${parsed.regNo}. Very new vehicles can take a few weeks to appear.`
        : 'The Government vehicle records server is slow right now. Please try again in a little while.',
    } };
  }
  const plan = await require('../pay/billing').reportPlan();
  return { status: 200, body: {
    vehicle: view.basic(data, { detail: await freeDetail() }),
    price_paise: plan?.price_paise ?? null,
    left_today: Math.max(0, perDevice - used.device - 1),
  } };
}

/* ─────────────────────────────────────────── the WhatsApp history ── */

/** WhatsApp's *bold* and _italic_ stay as they are; the page renders them. */
const clip = (s, n = 2000) => String(s || '').slice(0, n);

let templateCache = { at: 0, map: new Map() };
async function templateBodies() {
  if (Date.now() - templateCache.at < 10 * 60e3) return templateCache.map;
  const { rows } = await db.query(`SELECT template_name, language, body_text FROM wa_templates WHERE body_text IS NOT NULL`);
  templateCache = { at: Date.now(), map: new Map(rows.map((r) => [`${r.template_name}|${r.language}`, r.body_text])) };
  return templateCache.map;
}

/** One stored WhatsApp message as a chat item, or null to leave it out. */
function toItem(m, bodies, reportsByNumber) {
  const p = m.payload || {};
  const base = { id: String(m.id), at: m.created_at, from: m.direction === 'in' ? 'me' : 'bot', source: 'whatsapp' };
  if (m.direction === 'out' && m.error_message) return null;          // never reached them

  if (m.direction === 'in') {
    if (m.message_type === 'interactive') {
      const r = p.interactive?.button_reply || p.interactive?.list_reply || {};
      return { ...base, kind: 'text', text: clip(r.title || m.body) };
    }
    if (m.message_type === 'button') return { ...base, kind: 'text', text: clip(p.button?.text || m.body) };
    if (m.message_type === 'text') return { ...base, kind: 'text', text: clip(p.text?.body || m.body) };
    // Photos (an RC for owner verification) are deleted after the decision; never shown.
    if (['image', 'document'].includes(m.message_type)) return { ...base, kind: 'note', text: '📎 File sent (not kept)' };
    return null;
  }

  if (m.message_type === 'text') return { ...base, kind: 'text', text: clip(p.text?.body || m.body) };
  if (m.message_type === 'interactive') {
    const i = p.interactive || {};
    const buttons = (i.action?.buttons || []).map((b) => b.reply?.title).filter(Boolean);
    const rows = (i.action?.sections || []).flatMap((s) => s.rows || []).map((r) => r.title).filter(Boolean);
    return { ...base, kind: 'text', text: clip([i.header?.text, i.body?.text].filter(Boolean).join('\n\n') || m.body),
             chips: [...buttons, ...rows].slice(0, 10) };
  }
  if (m.message_type === 'template') {
    const t = p.template || {};
    const params = (t.components || []).find((c) => c.type === 'body')?.parameters?.map((x) => x.text) || [];
    let text = bodies.get(`${t.name}|${t.language?.code || 'en'}`) || '';
    params.forEach((v, n) => { text = text.split(`{{${n + 1}}}`).join(v); });
    return { ...base, kind: 'text', label: 'GaadiPe update', text: clip(text || params.join(' · ') || m.body) };
  }
  if (m.message_type === 'document') {
    const caption = String(p.document?.caption || m.body || '');
    const number = (caption.match(/\b(RPT\d+GP\d+)\b/) || [])[1];
    const invoice = (caption.match(/\b(INV\d+GP\d+)\b/) || [])[1];
    // WhatsApp's file links expire; the report or invoice is served fresh from GaadiPe.
    const report = number ? reportsByNumber.get(number) : null;
    return { ...base, kind: 'file', text: clip(caption.replace(/https?:\/\/\S+/g, '').trim()),
             file: number ? { type: 'report', number, id: report ? String(report.id) : null }
               : invoice ? { type: 'invoice', number: invoice } : { type: 'file', name: p.document?.filename || 'file' } };
  }
  return null;
}

/** The customer's WhatsApp conversation, a page at a time (oldest of the page first). */
async function history(user, { before = null, limit = 50 } = {}) {
  const n = Math.min(100, Math.max(10, Number(limit) || 50));
  const { rows } = await db.query(
    `SELECT id, direction, message_type, body, payload, error_message, created_at
       FROM whatsapp_messages
      WHERE right(regexp_replace(mobile, '\\D', '', 'g'), 10) = $1
        AND ($2::bigint IS NULL OR id < $2)
      ORDER BY id DESC LIMIT $3`, [String(user.mobile).slice(-10), before, n + 1]);
  const more = rows.length > n;
  const page = rows.slice(0, n).reverse();
  const bodies = await templateBodies();
  const { rows: reps } = await db.query(
    `SELECT id, report_number FROM vehicle_reports WHERE user_id = $1`, [user.id]).catch(() => ({ rows: [] }));
  const reportsByNumber = new Map(reps.map((r) => [r.report_number, r]));
  const items = page.map((m) => toItem(m, bodies, reportsByNumber)).filter(Boolean);
  return { items, more, before: page.length ? String(page[0].id) : null };
}

/** "Welcome back": what this customer already has with GaadiPe. */
async function summary(user) {
  const row = await db.one(
    `SELECT (SELECT count(*) FROM user_vehicles WHERE user_id = $1)::int AS vehicles,
            (SELECT count(*) FROM vehicle_reports r JOIN payments p ON p.id = r.payment_id
              WHERE r.user_id = $1 AND p.status = 'paid')::int AS reports,
            (SELECT count(*) FROM whatsapp_messages WHERE right(regexp_replace(mobile, '\\D', '', 'g'), 10) = $2)::int AS wa_messages,
            (SELECT v.reg_no FROM user_vehicles uv JOIN vehicles v ON v.id = uv.vehicle_id
              WHERE uv.user_id = $1 ORDER BY uv.last_checked_at DESC NULLS LAST LIMIT 1) AS last_vehicle,
            (SELECT min(created_at) FROM whatsapp_messages WHERE right(regexp_replace(mobile, '\\D', '', 'g'), 10) = $2) AS wa_since`,
    [user.id, String(user.mobile).slice(-10)]);
  return {
    name: user.display_name || user.wa_profile_name || null,
    vehicles: row.vehicles, reports: row.reports, last_vehicle: row.last_vehicle,
    whatsapp: row.wa_messages > 0 ? { messages: row.wa_messages, since: row.wa_since } : null,
  };
}

module.exports = { anonCheck, history, summary, _test: { toItem } };
