/**
 * src/admin/broadcasts.js — WhatsApp template broadcasts (user, 2026-09-23).
 *
 * Nobody on a broadcast list has messaged GaadiPe in the last 24 hours, so a
 * free-form message would simply not deliver. A broadcast is therefore always
 * an APPROVED TEMPLATE, and this module is three things:
 *
 *   templates()   the templates Meta has approved, read from the WhatsApp
 *                 Business account itself — so the panel can never offer a
 *                 name that would be rejected on send
 *   recipients()  who can be sent to, from the sign-in data: every customer
 *                 who has an account, with what they last checked
 *   queue()       the broadcast, one target row per person, sent by the job
 *                 a few a minute
 *
 * WHAT WAS SENT IS RECORDED, NOT RECOMPUTED. Each target keeps the parameters
 * exactly as they went out, because "the vehicle they last checked" changes the
 * next time they check something, and a log that rewrites itself is not a log.
 *
 * THE GUARDS ARE NOT HERE. WHATSAPP_ALLOWED_RECEPIENTS and the block list are
 * enforced in whatsapp/send.js, at the one door every message leaves through,
 * so a broadcast cannot go anywhere a reply could not. This module only refuses
 * to start when WhatsApp is switched off entirely.
 */

const db = require('../db');
const { config } = require('../config');

/** How each {{n}} may be filled. Anything else is treated as literal text. */
const FIELDS = {
  first_name: "The customer's first name (falls back to \"there\")",
  full_name: 'Their full name as recorded',
  last_vehicle: 'The vehicle number they last checked',
  mobile: 'Their mobile number',
};

/* ─────────────────────────────────────────────── what Meta has approved ── */

let cache = { at: 0, rows: null };

/**
 * The approved templates on the WhatsApp Business account.
 *
 * Read from Meta rather than typed by hand: a template name that does not exist,
 * or is not APPROVED, fails per-message with an error nobody sees until the
 * broadcast has already half run.
 */
async function templates({ refresh = false } = {}) {
  if (!refresh && cache.rows && Date.now() - cache.at < 5 * 60 * 1000) {
    return { ok: true, templates: cache.rows, cached: true };
  }
  const wa = config.whatsapp;
  if (!wa.token || !wa.businessId) {
    return { ok: false, error: 'not_configured',
             message: 'WHATSAPP_ACCESS_TOKEN and WHATSAPP_BUSINESS_ID are needed to read the template list.' };
  }
  const url = `https://graph.facebook.com/${wa.apiVersion}/${wa.businessId}/message_templates`
    + '?limit=100&fields=name,language,status,category,components';
  let json;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${wa.token}` },
      signal: AbortSignal.timeout(15000),
    });
    json = await res.json();
  } catch (e) {
    return { ok: false, error: 'unreachable', message: `Could not reach Meta: ${e.message}` };
  }
  if (json?.error) {
    return { ok: false, error: 'meta', message: `${json.error.code}: ${json.error.message}` };
  }

  const rows = (json?.data || []).map((t) => {
    const body = (t.components || []).find((c) => c.type === 'BODY')?.text || '';
    const footer = (t.components || []).find((c) => c.type === 'FOOTER')?.text || '';
    const buttons = (t.components || []).find((c) => c.type === 'BUTTONS')?.buttons || [];
    const header = (t.components || []).find((c) => c.type === 'HEADER') || null;
    // {{1}}, {{2}} … — how many parameters a send must carry, in order.
    const vars = [...new Set((body.match(/\{\{\s*\d+\s*\}\}/g) || [])
      .map((m) => Number(m.replace(/\D/g, ''))))].sort((a, b) => a - b);
    return {
      name: t.name, language: t.language, status: t.status, category: t.category,
      body, footer, header_format: header?.format || null,
      buttons: buttons.map((b) => b.text).filter(Boolean),
      variables: vars,
      // A media header needs a handle per send, which this panel does not do.
      sendable: t.status === 'APPROVED' && (!header || header.format === 'TEXT'),
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));

  cache = { at: Date.now(), rows };
  return { ok: true, templates: rows };
}

/* ────────────────────────────────────────── who there is to send to ── */

const FILTERS = {
  all: 'Everyone who has signed in',
  not_paying: 'Signed in, never paid',
  checked: 'Checked a vehicle, never paid',
  paying: 'Has paid at least once',
};

function filterWhere(filter) {
  const PAID = `EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id
                          AND p.status = 'paid' AND p.amount_paise > 0)`;
  const CHECKED = `EXISTS (SELECT 1 FROM user_vehicles uv WHERE uv.user_id = u.id)`;
  switch (filter) {
    case 'not_paying': return `NOT ${PAID}`;
    case 'checked': return `${CHECKED} AND NOT ${PAID}`;
    case 'paying': return PAID;
    default: return 'true';
  }
}

/**
 * The people who can be broadcast to, newest activity first.
 *
 * From the sign-in data — every account, whether or not they ever bought
 * anything — with the one fact a template usually needs about them: the vehicle
 * they last checked.
 */
async function recipients({ filter = 'all', q = '', limit = 500 } = {}) {
  const where = filterWhere(filter);
  const term = String(q || '').trim().toLowerCase();
  const { rows } = await db.query(
    `SELECT u.id, u.mobile, u.display_name, u.created_at,
            (SELECT v.reg_no FROM user_vehicles uv JOIN vehicles v ON v.id = uv.vehicle_id
              WHERE uv.user_id = u.id ORDER BY uv.last_checked_at DESC NULLS LAST LIMIT 1) AS last_vehicle,
            (SELECT max(uv.last_checked_at) FROM user_vehicles uv WHERE uv.user_id = u.id) AS last_checked,
            (SELECT count(*)::int FROM user_vehicles uv WHERE uv.user_id = u.id) AS vehicles,
            EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id
                      AND p.status = 'paid' AND p.amount_paise > 0) AS paid,
            EXISTS (SELECT 1 FROM blocks b
                     WHERE b.kind = 'mobile' AND b.value = u.mobile AND b.released_at IS NULL) AS blocked
       FROM users u
      WHERE u.deactivated_at IS NULL AND ${where}
        AND ($1 = '' OR lower(coalesce(u.display_name, '')) LIKE '%' || $1 || '%' OR u.mobile LIKE '%' || $1 || '%')
      ORDER BY last_checked DESC NULLS LAST, u.id DESC
      LIMIT $2`, [term, Math.min(2000, limit)]);
  return { filters: FILTERS, fields: FIELDS, rows: rows.map((r) => ({ ...r, id: String(r.id) })) };
}

/* ──────────────────────────────────────────────────── the broadcast ── */

/** One person's parameters, in {{1}}, {{2}} … order. */
function paramsFor(person, variables) {
  return (variables || []).map((v) => {
    switch (v) {
      case 'first_name':
        return String(person.display_name || '').trim().split(/\s+/)[0] || 'there';
      case 'full_name': return String(person.display_name || '').trim() || 'there';
      case 'last_vehicle': return person.last_vehicle || 'your vehicle';
      case 'mobile': return String(person.mobile || '');
      // Anything else is literal text the admin typed.
      default: return String(v ?? '');
    }
  });
}

/** What this broadcast would send, for the first few people, before it is sent. */
async function preview({ template_name, language = 'en', variables = [], mobiles = [] }) {
  const list = await templates();
  const tpl = list.ok && list.templates.find((t) => t.name === template_name && t.language === language);
  if (!tpl) return { ok: false, error: 'template', message: 'Choose an approved template.' };
  if (!tpl.sendable) {
    return { ok: false, error: 'template',
             message: `${tpl.name} is ${tpl.status}${tpl.header_format && tpl.header_format !== 'TEXT'
               ? ` and has a ${tpl.header_format} header, which this panel cannot fill` : ''}.` };
  }
  if (tpl.variables.length !== (variables || []).length) {
    return { ok: false, error: 'variables',
             message: `${tpl.name} takes ${tpl.variables.length} variable(s); ${(variables || []).length} given.` };
  }
  const people = await peopleByMobile(mobiles);
  const sample = people.slice(0, 5).map((p) => {
    const params = paramsFor(p, variables);
    let text = tpl.body;
    params.forEach((v, i) => { text = text.split(`{{${i + 1}}}`).join(v); });
    return { mobile: p.mobile, name: p.display_name, params, text };
  });
  return {
    ok: true,
    matched: people.length,
    missing: mobiles.length - people.length,
    test_mode: config.whatsapp.allowedRecipients,
    whatsapp_enabled: config.whatsapp.enabled,
    template: tpl,
    sample,
  };
}

/** The chosen customers, as the sign-in data has them. */
async function peopleByMobile(mobiles) {
  const clean = [...new Set((mobiles || [])
    .map((m) => String(m).replace(/\D/g, '').slice(-10)).filter((m) => m.length === 10))];
  if (!clean.length) return [];
  const { rows } = await db.query(
    `SELECT u.id, u.mobile, u.display_name,
            (SELECT v.reg_no FROM user_vehicles uv JOIN vehicles v ON v.id = uv.vehicle_id
              WHERE uv.user_id = u.id ORDER BY uv.last_checked_at DESC NULLS LAST LIMIT 1) AS last_vehicle
       FROM users u
      WHERE u.deactivated_at IS NULL AND u.mobile = ANY($1::text[])
      ORDER BY u.id`, [clean]);
  return rows;
}

/**
 * Queue a broadcast. The job sends it, a few a minute.
 *
 * Nothing is sent from here: a broadcast that sent inline would tie the admin's
 * browser to Meta's API for as long as the list is long, and a closed tab would
 * leave half a list wondering.
 */
async function queue({ template_name, language = 'en', variables = [], mobiles = [], note = '' }, adminId) {
  if (!config.whatsapp.enabled) {
    return { ok: false, error: 'whatsapp_off',
             message: 'WhatsApp is switched off (WHATSAPP_ENABLED). Turn it on before broadcasting.' };
  }
  const check = await preview({ template_name, language, variables, mobiles });
  if (!check.ok) return check;
  const people = await peopleByMobile(mobiles);
  if (!people.length) return { ok: false, error: 'recipients', message: 'Choose at least one customer.' };

  const b = await db.one(
    `INSERT INTO whatsapp_broadcasts (admin_id, template_name, language, variables, note, recipients)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING id`,
    [adminId || null, template_name, language, JSON.stringify(variables), String(note || '').slice(0, 300), people.length]);

  for (const p of people) {
    await db.query(
      `INSERT INTO whatsapp_broadcast_targets (broadcast_id, user_id, mobile, params)
       VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (broadcast_id, mobile) DO NOTHING`,
      [b.id, p.id, p.mobile, JSON.stringify(paramsFor(p, variables))]);
  }
  console.log('[broadcast] %s (%s) queued for %d customer(s)', template_name, language, people.length);
  return { ok: true, id: String(b.id), recipients: people.length };
}

/** Stop whatever has not gone yet. Anything already sent cannot be recalled. */
async function cancel(id) {
  await db.query(`UPDATE whatsapp_broadcasts SET status = 'cancelled', finished_at = now() WHERE id = $1`, [id]);
  const out = await db.query(
    `UPDATE whatsapp_broadcast_targets SET status = 'skipped', error = 'cancelled'
      WHERE broadcast_id = $1 AND status = 'pending'`, [id]);
  return { ok: true, stopped: out.rowCount };
}

/** Every broadcast, with how it went. */
async function list({ limit = 50 } = {}) {
  const { rows } = await db.query(
    `SELECT b.*,
            (SELECT count(*)::int FROM whatsapp_broadcast_targets t WHERE t.broadcast_id = b.id AND t.status = 'sent') AS sent,
            (SELECT count(*)::int FROM whatsapp_broadcast_targets t WHERE t.broadcast_id = b.id AND t.status = 'failed') AS failed,
            (SELECT count(*)::int FROM whatsapp_broadcast_targets t WHERE t.broadcast_id = b.id AND t.status = 'skipped') AS skipped,
            (SELECT count(*)::int FROM whatsapp_broadcast_targets t WHERE t.broadcast_id = b.id AND t.status = 'pending') AS pending
       FROM whatsapp_broadcasts b ORDER BY b.id DESC LIMIT $1`, [Math.min(200, limit)]);
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}

/** One broadcast, person by person. */
async function targets(id, { limit = 500 } = {}) {
  const { rows } = await db.query(
    `SELECT t.id, t.mobile, t.params, t.status, t.error, t.attempts, t.sent_at, u.display_name
       FROM whatsapp_broadcast_targets t
       LEFT JOIN users u ON u.id = t.user_id
      WHERE t.broadcast_id = $1 ORDER BY t.id LIMIT $2`, [id, Math.min(2000, limit)]);
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}

module.exports = { FIELDS, FILTERS, templates, recipients, preview, queue, cancel, list, targets, paramsFor };
