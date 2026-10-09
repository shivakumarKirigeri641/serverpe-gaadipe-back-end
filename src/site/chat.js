/**
 * src/site/chat.js — THE CHAT ON gaadipe.in (user, 2026-10-07: "a chat in the
 * browser, like WhatsApp but better; the basic check without a phone number,
 * then sign in for more; an existing customer sees their WhatsApp history").
 *
 *   anonCheck(req)        the free basic check for someone not signed in
 *   history(user, opts)   their GaadiPe WhatsApp conversation, as chat items
 *   summary(user)         "welcome back": vehicles, paid reports, last check
 *
 * THE ANONYMOUS CHECK (2026-10-08, migration 142) costs nothing and gives little away:
 *   - "Agree & check" first; every attempt recorded in anon_checks
 *   - the full lookup, stored (ULIP → eChallan.app → paid RC backup, capped a day)
 *   - make, model name (variant hidden) and fuel only (site/vehicleView.identity)
 *   - the scraping guard, the block list and owner-hidden vehicles, as /check
 *   - 1 per browser and 1 per network address a day, and an hourly site cap
 * Everything beyond it — the basic view, the full report, history — needs a sign-in.
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

/** The basic check for a visitor who has not signed in. */
async function anonCheck(req) {
  const parsed = plate.parse(req.body?.reg_no);
  if (!parsed.ok) return { status: 400, body: { error: 'bad_plate', message: parsed.error } };

  /* SIGN IN FOR EVERY CHECK (user, 2026-10-08: "make sign-in mandatory for any
     vehicle check"). Switch: check_sign_in_required (migration 137, on). Off, the
     free checks without signing in come back as before. */
  if (await settings.bool('check_sign_in_required', true)) {
    return { status: 403, body: { error: 'sign_in_needed',
      message: 'Please sign in with your mobile number to check a vehicle — basic details free (make, model, variant, fuel, vehicle type), full report ₹19. Your checks are kept in your account.' } };
  }

  /*
   * ONE FREE LOOK, AGREED FIRST, RECORDED IN FULL (user, 2026-10-08, migration 142).
   *   consent     the visitor tapped "Agree & check" (Terms, Privacy, Refund,
   *               lawful purpose) — no agreement, no lookup
   *   device      a browser without its id is refused (simple bots have none)
   *   limits      1 per browser AND 1 per network address a day, and a cap for
   *               the whole site per hour; the scraping guard; blocked vehicles
   *   data        the full lookup, stored: RC, challans, FASTag — ULIP, then
   *               eChallan.app, then the paid RC backup (capped a day for free checks)
   *   shown       make, model name without its variant, fuel (vehicleView.identity)
   *   recorded    every attempt, refused ones too, in anon_checks: device, IP,
   *               session, user agent, place, source, consent words and versions
   */
  const ctx = require('./device').contextOf(req);
  const c = (req.body && typeof req.body.client === 'object' && req.body.client) || {};
  const consentIn = (req.body && typeof req.body.consent === 'object' && req.body.consent) || {};
  const device = String(ctx.device_id || '').slice(0, 64);
  const ipHash = hash(req.ip);
  /* The per-network limit counts an IPv4 address, or an IPv6 /64 block: a phone
     on IPv6 can take a new address within its block at will, the block it cannot. */
  const rawIp = String(ctx.ip || '').replace(/^::ffff:/, '');
  const ipKey = rawIp.includes(':') ? `${rawIp.split(':').slice(0, 4).join(':')}::/64` : rawIp;
  const visitorId = String(c.visitor_id || '').slice(0, 64) || null;
  const sessionId = String(c.session_id || '').slice(0, 64) || null;
  const touch = visitorId ? await db.one(
    `SELECT first_touch->>'source' AS source, first_touch->>'campaign' AS campaign FROM visitors WHERE visitor_id = $1`, [visitorId]).catch(() => null) : null;

  const { policyVersions } = require('../pay/consent');
  const consent = consentIn.agreed === true ? {
    agreed: true, method: 'agree_and_check_button',
    words: String(consentIn.words || '').slice(0, 1200) || null,
    language: consentIn.language === 'hi' ? 'hi' : 'en',
    lawful_purpose_confirmed: true,
    documents: ['terms', 'privacy', 'refund'],
    versions: await policyVersions().catch(() => null),
    free_check_terms_version: '1.0',
    at: new Date().toISOString(),
  } : null;

  // Every attempt leaves a row — what was asked, by whom, and what happened.
  const audit = (fields) => db.query(
    `INSERT INTO anon_checks (reg_no, outcome, refusal, data_source, latency_ms, shown, device_id, visitor_id, session_id,
                              ip, ip_chain, user_agent, device, place, referrer, page, source, campaign, consent, ip_key)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
    [parsed.regNo, fields.outcome, fields.refusal || null, fields.data_source || null, fields.latency_ms ?? null,
     fields.shown ? JSON.stringify(fields.shown) : null, device || null, visitorId, sessionId,
     ctx.ip || null, ctx.ip_chain || null, ctx.user_agent || null,
     JSON.stringify({ type: ctx.device_type, vendor: ctx.device_vendor, model: ctx.device_model, os: ctx.os, os_version: ctx.os_version,
       browser: ctx.browser, browser_version: ctx.browser_version, screen: ctx.screen, viewport: ctx.viewport, timezone: ctx.timezone,
       languages: ctx.languages, platform: ctx.platform, connection: String(c.connection || '').slice(0, 60) || null,
       touch_points: c.touch_points ?? null, cpu_cores: c.cpu_cores ?? null, memory_gb: c.memory_gb ?? null }),
     JSON.stringify({ city: ctx.city, region: ctx.region, country: ctx.country }),
     String(c.referrer || '').slice(0, 300) || null, String(c.page || '').slice(0, 200) || null,
     touch?.source || null, touch?.campaign || null, consent ? JSON.stringify(consent) : null, ipKey || null])
    .then((r) => r.rows[0]?.id).catch((e) => { console.error('[chat] anon_checks:', e.message); return null; });

  const SIGN_IN = 'You have used today’s free check. Sign in with your mobile number to check more vehicles — basic details free (make, model, variant, fuel, vehicle type), full report ₹19.';
  const refuse = async (refusal, status, body) => { await audit({ outcome: 'refused', refusal }); return { status, body }; };

  if (!consent) {
    return refuse('no_consent', 400, { error: 'consent_required',
      message: 'Please tap “Agree & check” to agree to the Terms, Privacy policy and Refund policy first.' });
  }
  if (!device) return refuse('no_device_id', 403, { error: 'sign_in_needed', message: SIGN_IN });

  const perDevice = await settings.num('chat_anon_checks_per_day', 1);
  const perIp = await settings.num('chat_anon_checks_per_day_ip', 1);
  const perHour = await settings.num('chat_anon_checks_per_hour', 60);
  const used = await db.one(
    /* Only an answer uses up the free check: shown, or "no record". A lookup that
       failed (ULIP down) gave the visitor nothing, so it does not count — but no
       more than 3 failed tries an hour from one network, so retrying while ULIP is
       down cannot hammer it (2026-10-08). */
    `SELECT count(*) FILTER (WHERE answered AND device_id = $1 AND created_at > ${TODAY})::int AS device,
            count(*) FILTER (WHERE answered AND ip_key = $2 AND created_at > ${TODAY})::int AS ip,
            count(*) FILTER (WHERE answered AND created_at > now() - interval '1 hour')::int AS hour,
            count(*) FILTER (WHERE outcome = 'failed' AND ip_key = $2 AND created_at > now() - interval '1 hour')::int AS failed_hour
       FROM (SELECT *, outcome IN ('shown', 'not_found') AS answered FROM anon_checks
              WHERE outcome <> 'refused' AND created_at > now() - interval '1 day') a`,
    [device, ipKey || '']);
  if (used.device >= perDevice) return refuse('daily_limit_device', 429, { error: 'sign_in_needed', message: SIGN_IN });
  if (used.ip >= perIp) return refuse('daily_limit_ip', 429, { error: 'sign_in_needed', message: SIGN_IN });
  if (used.failed_hour >= 3) {
    return refuse('retry_limit', 429, { error: 'records_busy',
      message: 'The Government vehicle records server is slow right now. Please try again in a little while — or sign in to check this vehicle.' });
  }
  if (used.hour >= perHour) {
    return refuse('hourly_site_cap', 429, { error: 'sign_in_needed',
      message: 'Free checks are busy right now. Sign in with your mobile number to check this vehicle — basic details free (make, model, variant, fuel, vehicle type), full report ₹19.' });
  }

  const scan = await require('../security/guard').noteVehicleCheck(req, parsed.regNo);
  if (!scan.ok) {
    return refuse('scraping_guard', 429, { error: 'too_many_vehicles',
      message: 'That is a lot of vehicles in a short time. Please try again in an hour.' });
  }
  if (await blocks.isBlocked('vehicle', parsed.regNo)
      || await require('../owners/verify').hiddenFrom(null, parsed.regNo)) {
    return refuse('vehicle_blocked', 403, { error: 'blocked',
      message: 'This vehicle cannot be checked here. If it is yours, please write to support@gaadipe.in.' });
  }

  /* THE FULL SEQUENCE, STORED (user, 2026-10-08: "allow the sequence before sign-in
     too — we store RC, challans and FASTag anyway: ULIP, down? eChallan.app, not
     available? IDSPay"). Everything is saved for when they sign in or buy; the
     visitor still sees only make, model name and fuel. The paid backup (IDSPay) is
     capped for free checks: free_check_backup_per_day (30) — past it, free checks
     stop at eChallan.app. Paid reports are never capped by this. */
  const backupCap = await settings.num('free_check_backup_per_day', 30);
  const backupsToday = await db.one(
    `SELECT count(*)::int AS n FROM anon_checks WHERE data_source = 'RC backup (paid)' AND created_at > ${TODAY}`);
  const started = Date.now();
  const data = await gateway.full(parsed.regNo, (backupsToday?.n || 0) >= backupCap ? { backup: 0 } : {});
  const latency = Date.now() - started;
  // Kept like every other check, so the admin email and the Vehicle Explorer know the vehicle.
  if (data?.success) {
    await require('../vehicle/store').record(null, data)
      .catch((e) => console.error('[chat] could not save %s: %s', parsed.regNo, e.message));
  }
  // Like CarInfo before sign-in (2026-10-10): variant, masked owner and RTO, each a setting.
  const shown = data?.success ? view.identity(data, {
    variant: await settings.bool('free_check_show_variant', true),
    owner: await settings.bool('free_check_show_owner', true),
  }) : null;
  if (shown && await settings.bool('free_check_show_rto', true)) {
    shown.rto = await view.rtoOf(parsed.regNo).catch(() => null);
  }
  const SOURCE = { ECHALLANAPP: 'eChallan.app', RCBACKUP: 'RC backup (paid)' };
  const dataSource = data?.success
    ? (data.cached ? 'saved record' : SOURCE[String(data.source || '').toUpperCase()] || 'ULIP')
    : null;
  await audit({ outcome: data?.success ? 'shown' : data?.error === 'vehicle_not_found' ? 'not_found' : 'failed',
    refusal: data?.success ? null : String(data?.error || 'failed').slice(0, 80),
    data_source: dataSource, latency_ms: latency, shown: shown?.identity || null });
  // The admin's email and the Free checks screen read this (notify.js, admin/web.js).
  await db.query(`INSERT INTO event_log (kind, detail) VALUES ('chat_anon_check', $1)`,
    [JSON.stringify({ device, ip: ipHash, reg_no: parsed.regNo, found: data?.success === true, ...(data?.success ? {} : { error: data?.error || 'failed' }) })]).catch(() => {});
  require('../util/activity').log('🔍', `Free check before sign-in · ${parsed.regNo} · ${data?.success ? `shown (${[shown.identity.maker, shown.identity.model].filter(Boolean).join(' ')})` : `not shown (${String(data?.error || 'failed').replace(/_/g, ' ')})`}`,
    { who: `a visitor (not signed in) · ${[ctx.city, ctx.region].filter(Boolean).join(', ') || 'place unknown'}` });

  if (!data?.success) {
    return { status: data?.error === 'vehicle_not_found' || data?.error === 'not_found' ? 404 : 503, body: {
      error: data?.error || 'unavailable',
      message: data?.error === 'vehicle_not_found' || data?.error === 'not_found'
        ? `No Government record was found for ${parsed.regNo}. Please check the number — very new vehicles can take a few weeks to appear.`
        : 'The Government vehicle records server is slow right now. Please try again in a little while.',
    } };
  }
  const plan = await require('../pay/billing').reportPlan();
  return { status: 200, body: { vehicle: shown, price_paise: plan?.price_paise ?? null, left_today: 0 } };
}

/** Today in India, as an SQL expression. */
const TODAY = `(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;

/*
 * A free check made before signing in belongs to the person who then signs in on
 * the same browser (user, 2026-10-08): "checked KA… free, then signed in".
 */
async function linkAnonChecks(userId, deviceId) {
  if (!userId || !deviceId) return;
  await db.query(
    `UPDATE anon_checks SET user_id = $1, linked_at = now()
      WHERE device_id = $2 AND user_id IS NULL AND created_at > now() - interval '30 days'`,
    [userId, String(deviceId).slice(0, 64)]).catch(() => {});
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
        -- Only this account's own time: a fresh account on an archived number never sees the old chat.
        AND created_at >= $4::timestamptz - interval '5 minutes'
      ORDER BY id DESC LIMIT $3`, [String(user.mobile).slice(-10), before, n + 1, user.created_at || '1970-01-01']);
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
    `SELECT (SELECT count(*) FROM user_vehicles WHERE user_id = $1 AND hidden_at IS NULL)::int AS vehicles,
            (SELECT count(*) FROM vehicle_reports r JOIN payments p ON p.id = r.payment_id
              WHERE r.user_id = $1 AND p.status = 'paid')::int AS reports,
            (SELECT count(*) FROM whatsapp_messages WHERE right(regexp_replace(mobile, '\\D', '', 'g'), 10) = $2
                AND created_at >= $3::timestamptz - interval '5 minutes')::int AS wa_messages,
            (SELECT v.reg_no FROM user_vehicles uv JOIN vehicles v ON v.id = uv.vehicle_id
              WHERE uv.user_id = $1 AND uv.hidden_at IS NULL ORDER BY uv.last_checked_at DESC NULLS LAST LIMIT 1) AS last_vehicle,
            (SELECT min(created_at) FROM whatsapp_messages WHERE right(regexp_replace(mobile, '\\D', '', 'g'), 10) = $2
                AND created_at >= $3::timestamptz - interval '5 minutes') AS wa_since`,
    [user.id, String(user.mobile).slice(-10), user.created_at || '1970-01-01']);
  return {
    name: user.display_name || user.wa_profile_name || null,
    vehicles: row.vehicles, reports: row.reports, last_vehicle: row.last_vehicle,
    whatsapp: row.wa_messages > 0 ? { messages: row.wa_messages, since: row.wa_since } : null,
  };
}

module.exports = { anonCheck, linkAnonChecks, history, summary, _test: { toItem } };
