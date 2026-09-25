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
 * What GaadiPe submitted to Meta, as recorded in wa_templates.
 *
 * Used when the live list cannot be read, and merged into it when it can:
 * a template Meta knows about keeps Meta's approval status, because only Meta
 * can say whether a message will actually deliver.
 */
/*
 * ONLY GAADIPE'S OWN TEMPLATES (user, 2026-09-25).
 *
 * The WhatsApp Business account is shared: QuizPe's qp_*, Pravesha's pv_* and
 * Meta's sample hello_world all come back from the same list. Listing them here
 * invited sending a school quiz reminder to a scooter owner, so only gp_* is
 * shown — and since preview and queue look the template up in this same list,
 * anything else cannot be sent from GaadiPe at all.
 */
const OURS = (name) => /^gp_/i.test(String(name || ''));

async function stored() {
  const { rows } = await db.query(
    `SELECT template_name, language, category, variables,
            header_text, body_text, footer_text, approval_status
       FROM wa_templates WHERE is_active ORDER BY category, template_name`);
  return rows.filter((t) => OURS(t.template_name)).map((t) => ({
    name: t.template_name,
    language: t.language,
    status: t.approval_status || 'PENDING',
    category: t.category,
    body: t.body_text || '',
    footer: t.footer_text || '',
    header_format: t.header_text ? 'TEXT' : null,
    header_text: t.header_text || null,
    buttons: [],
    // What each {{n}} means, recorded when the template was written down.
    fills: Array.isArray(t.variables) ? t.variables : [],
    variables: [...new Set((t.body_text || '').match(/\{\{\s*\d+\s*\}\}/g) || [])]
      .map((m) => Number(m.replace(/\D/g, ''))).sort((a, b) => a - b),
    // Never sendable on our say-so: Meta decides, and until it has, it has not.
    sendable: t.approval_status === 'APPROVED',
    source: 'stored',
  }));
}

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
    return { ok: true, templates: await stored(), source: 'stored',
             warning: `Could not reach Meta (${e.message}). Showing the templates GaadiPe has recorded — approval status may be out of date.` };
  }
  if (json?.error) {
    return { ok: true, templates: await stored(), source: 'stored',
             warning: `Meta said: ${json.error.code}: ${String(json.error.message).replace(/\.\s*$/, '')}.`
               + ' Showing the templates GaadiPe has recorded — none can be sent until Meta approves them.' };
  }

  const rows = (json?.data || []).filter((t) => OURS(t.name)).map((t) => {
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

  /*
   * Meta's answer is the truth about approval, so it is written back. A
   * template GaadiPe never recorded is still listed — somebody may have
   * raised it in the console directly, and hiding it would be a lie.
   */
  for (const t of rows) {
    await db.query(
      `UPDATE wa_templates SET approval_status = $3, category = coalesce($4, category), modified_at = now()
        WHERE template_name = $1 AND language = $2`,
      [t.name, t.language, t.status, t.category]).catch(() => {});
  }
  const byKey = new Map(rows.map((t) => [`${t.name}|${t.language}`, t]));
  for (const t of await stored()) {
    // Recorded here but unknown to Meta: not raised yet, and worth seeing.
    if (!byKey.has(`${t.name}|${t.language}`)) rows.push({ ...t, status: 'NOT RAISED', sendable: false });
  }

  cache = { at: Date.now(), rows };
  return { ok: true, templates: rows, source: 'meta' };
}

/* ────────────────────────────────────────── who there is to send to ── */

/*
 * AUDIENCES, SEVERAL AT ONCE (user, 2026-09-25).
 *
 * GaadiPe lives on WhatsApp now, so "everyone" is not just the people with a
 * web account: someone who said Hi and stopped has a WhatsApp session and no
 * users row at all, and is exactly who a nudge is for. The pool is both — every
 * account, plus every WhatsApp number that never became one.
 *
 * Audiences are ticked together and combined with OR: "said Hi only" + "lapsed"
 * is everyone in either. Each row says which audiences it is in, so the list
 * explains itself.
 */
const FILTERS = {
  all:      'Everyone',
  hi_only:  'Said Hi, never checked a vehicle',
  checked:  'Checked a vehicle, never paid',
  lapsed:   'Paid before, nothing active now',
  active:   'Paying now (report or watch active)',
  paying:   'Has paid at least once',
};
// Older links and saved screens asked for this one; it still means what it meant.
const LEGACY = { not_paying: 'NOT paid' };

const PREDICATE = {
  all:     'true',
  hi_only: 'has_chat AND NOT checked',
  checked: 'checked AND NOT paid',
  lapsed:  'paid AND NOT active',
  active:  'active',
  paying:  'paid',
  ...LEGACY,
};

/** The chosen audiences as one SQL condition over the flags below. */
function filterWhere(filter) {
  const keys = String(filter || 'all').split(',').map((k) => k.trim()).filter((k) => PREDICATE[k]);
  if (!keys.length || keys.includes('all')) return 'true';
  return keys.map((k) => `(${PREDICATE[k]})`).join(' OR ');
}

/*
 * Everyone who could be written to, with the facts the audiences are built
 * from. An account's mobile and a WhatsApp session's mobile are the same
 * person; the session is only counted on its own when there is no account.
 */
const PEOPLE = `
  WITH pool AS (
    SELECT u.id AS user_id, u.mobile, u.display_name, u.wa_profile_name, u.created_at
      FROM users u
     WHERE u.deactivated_at IS NULL
    UNION ALL
    SELECT NULL, s.mobile, NULL, s.profile_name, s.created_at
      FROM whatsapp_sessions s
     WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.mobile = s.mobile)
  ),
  people AS (
    SELECT p.*,
           (SELECT v.reg_no FROM user_vehicles uv JOIN vehicles v ON v.id = uv.vehicle_id
             WHERE uv.user_id = p.user_id ORDER BY uv.last_checked_at DESC NULLS LAST LIMIT 1) AS last_vehicle,
           (SELECT max(uv.last_checked_at) FROM user_vehicles uv WHERE uv.user_id = p.user_id) AS last_checked,
           (SELECT count(*)::int FROM user_vehicles uv WHERE uv.user_id = p.user_id) AS vehicles,
           (SELECT max(s.last_inbound_at) FROM whatsapp_sessions s WHERE s.mobile = p.mobile) AS last_message,
           EXISTS (SELECT 1 FROM whatsapp_sessions s WHERE s.mobile = p.mobile) AS has_chat,
           EXISTS (SELECT 1 FROM user_vehicles uv WHERE uv.user_id = p.user_id) AS checked,
           EXISTS (SELECT 1 FROM payments x WHERE x.user_id = p.user_id
                     AND x.status = 'paid' AND x.amount_paise > 0) AS paid,
           (EXISTS (SELECT 1 FROM vehicle_reports r WHERE r.user_id = p.user_id AND r.valid_until > now())
            OR EXISTS (SELECT 1 FROM subscriptions sb WHERE sb.user_id = p.user_id
                         AND sb.is_active AND sb.ends_on >= CURRENT_DATE)) AS active,
           EXISTS (SELECT 1 FROM blocks b
                    WHERE b.kind = 'mobile' AND b.value = p.mobile AND b.released_at IS NULL) AS blocked
      FROM pool p
     -- Replied STOP (user, 2026-09-25): the Terms promise we stop messaging
     -- them, so they are not in any audience — not listed, not counted, not
     -- sendable. send.js refuses them as well, in case of a list built earlier.
     WHERE NOT EXISTS (SELECT 1 FROM whatsapp_sessions s
                        WHERE s.mobile = p.mobile AND s.wa_opt_out_at IS NOT NULL)
  )`;

/** Which audiences a row is in — shown beside it, so the list explains itself. */
const segmentsOf = (r) => Object.keys(FILTERS)
  .filter((k) => k !== 'all' && k !== 'paying')
  .filter((k) => ({
    hi_only: r.has_chat && !r.checked,
    checked: r.checked && !r.paid,
    lapsed: r.paid && !r.active,
    active: r.active,
  })[k]);

/**
 * The people who can be broadcast to, most recently active first, with a
 * count for every audience so the choice is made knowing its size.
 */
async function recipients({ filter = 'all', q = '', limit = 500 } = {}) {
  const where = filterWhere(filter);
  const term = String(q || '').trim().toLowerCase();
  const { rows } = await db.query(
    `${PEOPLE}
     SELECT * FROM people
      WHERE (${where})
        AND ($1 = '' OR lower(coalesce(display_name, wa_profile_name, '')) LIKE '%' || $1 || '%'
                     OR mobile LIKE '%' || $1 || '%')
      ORDER BY greatest(last_checked, last_message) DESC NULLS LAST, created_at DESC
      LIMIT $2`, [term, Math.min(2000, limit)]);

  const counts = await db.one(
    `${PEOPLE}
     SELECT ${Object.entries(PREDICATE).filter(([k]) => FILTERS[k])
       .map(([k, p]) => `count(*) FILTER (WHERE ${p})::int AS "${k}"`).join(', ')}
       FROM people`);

  return {
    filters: FILTERS,
    counts,
    fields: FIELDS,
    rows: rows.map((r) => ({
      ...r,
      id: r.user_id ? String(r.user_id) : `wa:${r.mobile}`,
      user_id: r.user_id ? String(r.user_id) : null,
      segments: segmentsOf(r),
    })),
  };
}

/* ──────────────────────────────────── what fills a template's blanks ── */

/*
 * WHICH FIELD GOES IN WHICH BLANK — PER TEMPLATE, NEVER IN GENERAL.
 *
 * "{{1}} is their name and {{2}} is their vehicle" is true of the start-here
 * templates and of nothing else: the next template's {{1}} could be an amount,
 * a date or a report number, and a panel that quietly pre-fills it with a name
 * would send that name as the amount. So a template is pre-filled only when it
 * is named here, or when the same template has been broadcast before — and
 * anything else starts blank and has to be chosen.
 */
const KNOWN = {
  gp_starthere_en_v1: ['first_name', 'last_vehicle'],
  gp_starthere_hn_v1: ['first_name', 'last_vehicle'],
};

/**
 * Suggested mapping per template.
 *
 * Three sources, weakest first: what was written down in wa_templates when the
 * template was recorded, then the hardcoded pair below, then whatever was
 * actually chosen the last time this template was broadcast — because that is
 * the only one of the three that reflects a decision somebody made.
 */
async function defaults() {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (template_name, language) template_name, language, variables
       FROM whatsapp_broadcasts ORDER BY template_name, language, id DESC`);
  const out = {};
  // What the template itself says each blank is for.
  const { rows: recorded } = await db.query(
    `SELECT template_name, language, variables FROM wa_templates WHERE is_active`);
  for (const t of recorded) {
    if (Array.isArray(t.variables) && t.variables.length) {
      out[`${t.template_name}|${t.language}`] = t.variables;
    }
  }
  for (const [name, vars] of Object.entries(KNOWN)) out[`${name}|en`] = vars;
  // A template's own history wins over the table above: it is what this admin
  // actually chose the last time they sent it.
  for (const r of rows) out[`${r.template_name}|${r.language}`] = r.variables || [];
  // The Hindi start-here template is the same shape as the English one.
  for (const [name, vars] of Object.entries(KNOWN)) {
    if (!out[`${name}|hi`]) out[`${name}|hi`] = vars;
  }
  return out;
}

/* ──────────────────────────────────────────────────── the broadcast ── */

/** One person's parameters, in {{1}}, {{2}} … order. */
function paramsFor(person, variables) {
  return (variables || []).map((v) => {
    switch (v) {
      // Meta gives no profile name before someone messages us, so a name can
      // only come from our own record: what they typed on the site, or — if
      // they have ever written to us — the name WhatsApp showed then.
      case 'first_name':
        return String(person.display_name || person.wa_profile_name || '').trim().split(/\s+/)[0] || 'there';
      case 'full_name':
        return String(person.display_name || person.wa_profile_name || '').trim() || 'there';
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

/**
 * The chosen customers — accounts and WhatsApp-only numbers alike, since a
 * template can reach either. `id` is the account, or null for a number that
 * only ever chatted.
 */
async function peopleByMobile(mobiles) {
  const clean = [...new Set((mobiles || [])
    .map((m) => String(m).replace(/D/g, '').slice(-10)).filter((m) => m.length === 10))];
  if (!clean.length) return [];
  const { rows } = await db.query(
    `${PEOPLE}
     SELECT user_id AS id, mobile, display_name, wa_profile_name, last_vehicle
       FROM people WHERE mobile = ANY($1::text[])
      ORDER BY user_id NULLS LAST`, [clean]);
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

/**
 * Record what Meta decided about a template.
 *
 * Normally the live list answers this and nothing needs saying. But a token
 * belonging to a deleted app cannot read that list, and approvals arrive one
 * at a time over days — so the panel can set it by hand until the credentials
 * are replaced, at which point Meta's answer overwrites whatever is here.
 *
 * This records a decision; it never makes one. Marking something APPROVED that
 * Meta refused does not make it send — it fails per message, and the failure
 * is visible on the broadcast.
 */
async function setStatus(name, language, status) {
  const allowed = ['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED'];
  const clean = String(status || '').toUpperCase();
  if (!allowed.includes(clean)) return { ok: false, error: 'status', message: `Status must be one of ${allowed.join(', ')}.` };
  const row = await db.one(
    `UPDATE wa_templates SET approval_status = $3, modified_at = now()
      WHERE template_name = $1 AND language = $2
      RETURNING template_name, language, approval_status`,
    [String(name || ''), String(language || 'en'), clean]);
  if (!row) return { ok: false, error: 'unknown', message: 'No such template is recorded.' };
  cache = { at: 0, rows: null };            // the list must be read again
  console.log('[broadcast] %s (%s) marked %s', row.template_name, row.language, clean);
  return { ok: true, template: row };
}

module.exports = { FIELDS, FILTERS, KNOWN, defaults, templates, stored, setStatus, recipients, preview, queue, cancel, list, targets, paramsFor };
