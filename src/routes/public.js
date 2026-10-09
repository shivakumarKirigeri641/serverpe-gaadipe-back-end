/**
 * src/routes/public.js
 * ---------------------------------------------------------------------------
 * Unauthenticated endpoints for the public website.
 *
 *   GET /serverpe/platform/gaadipe/v1/public/users/policies
 *
 * The path looks odd because the deployed front-end already calls it — this
 * restores a route that disappeared when the old application was replaced on
 * this port, which is why gaadipe.in/privacy started showing "not found".
 *
 * NO API KEY HERE, deliberately: these are published legal documents that must
 * be readable by anyone, including Meta's reviewers during app review and
 * business verification.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const db = require('../db');

const router = express.Router();

/* slug in the URL -> table holding that policy's clauses */
const POLICIES = {
  terms: 'terms_and_conditions',
  privacy: 'privacy_policy',
  refund: 'refund_policy',
  liability: 'liability_policy',
  consent: 'consent_policy',
  cancellation: 'cancellation_policy',
  delivery: 'delivery_policy',
  'data-deletion': 'data_deletion_policy',
  // The deployed front-end asks for this policy as "deletion" (see
  // POLICY_SLUGS in its lib/api.js). Serving both names costs one extra query
  // and means neither side has to be redeployed in step with the other.
  deletion: 'data_deletion_policy',
  partner: 'partner_policy',
  email: 'email_policy',
};

/** "4.0" vs "1.10": compared as numbers, part by part — never as text. */
const cmpVersion = (a, b) => {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
};

// Legal text changes rarely and every visitor loads it, so it is read once and
// held in memory. Cleared by restarting, which is what a policy edit needs
// anyway.
let cached = null;
let cachedAt = 0;
const TTL_MS = 10 * 60 * 1000;

async function loadPolicies() {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;

  const policies = {};
  const versions = {};

  for (const [slug, table] of Object.entries(POLICIES)) {
    try {
      const { rows } = await db.query(
        `SELECT title, description, display_order, version, effective_from
           FROM ${table}
          WHERE is_active
          ORDER BY display_order, id`);
      policies[slug] = rows.map(r => ({
        title: r.title,
        description: r.description,
        display_order: r.display_order,
      }));
      // Every clause carries a version; the document's version is the newest.
      // Found by comparing versions, not by taking the last clause on the page:
      // a clause rewritten in the middle (Terms 22 → 4.0) is still the newest,
      // and the bot and checkout already treat it so (policyVersions()).
      const newest = rows.reduce((best, r) => (!best || cmpVersion(r.version, best.version) > 0 ? r : best), null);
      versions[slug] = newest
        ? { version: newest.version, effective_from: newest.effective_from }
        : null;
    } catch (e) {
      // A missing table must not take the whole page down — the others are
      // still worth showing.
      console.warn(`[policies] ${table}: ${e.message}`);
      policies[slug] = [];
      versions[slug] = null;
    }
  }

  let business = {};
  try {
    const { rows } = await db.query(
      `SELECT * FROM business_details WHERE is_active ORDER BY id DESC LIMIT 1`);
    business = rows[0] || {};
  } catch (e) {
    console.warn('[policies] business_details:', e.message);
  }

  cached = { success: true, policies, versions, business };
  cachedAt = Date.now();
  return cached;
}

router.get('/policies', async (_req, res) => {
  try {
    res.json(await loadPolicies());
  } catch (e) {
    console.error('[policies] failed:', e.message);
    res.status(500).json({ success: false, error: 'server_error' });
  }
});

/*
 * THE SITE NOTICE (user, 2026-10-07: WhatsApp account disabled). One line at
 * the top of every page of gaadipe.in, in the visitor's language, switched and
 * worded from admin Configuration (site_notice_on / _en / _hi) — no rebuild to
 * put it up or take it down.
 */
router.get('/notice', async (_req, res) => {
  try {
    const settings = require('../util/settings');
    const on = await settings.bool('site_notice_on', false);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      ...(on
        ? { on: true, en: String(await settings.get('site_notice_en', '')), hi: String(await settings.get('site_notice_hi', '')),
            // 'warn' (yellow ⚠️) or 'good' (green ✅, with an "Open WhatsApp" link) — 2026-10-09.
            tone: String(await settings.get('site_notice_tone', 'warn')) === 'good' ? 'good' : 'warn' }
        : { on: false }),
      check: await checkNotice(settings),
      // The chat asks for sign-in before a check when this is on (2026-10-08).
      sign_in_required: await settings.bool('check_sign_in_required', true),
    });
  } catch {
    res.json({ on: false });
  }
});

/*
 * BEFORE A VEHICLE CHECK (user, 2026-10-07: "mention that dependent servers are
 * down and vehicle details may fail to fetch"). check_notice_mode:
 *   on    always shown (the default while the Government services are unreliable)
 *   auto  only while the VAHAN watch (jobs/vahanWatch.js) says VAHAN is down
 *   off   never
 * Worded from Configuration (check_notice_en / _hi). The chat shows it before a
 * visitor's first check and again if a check fails.
 */
async function checkNotice(settings) {
  const mode = String(await settings.get('check_notice_mode', 'on')).toLowerCase();
  if (mode === 'off') return null;
  if (mode === 'auto') {
    const w = JSON.parse(await settings.get('vahan_watch', 'null') || 'null');
    if (w?.state !== 'down') return null;
  }
  return {
    en: String(await settings.get('check_notice_en', '') || '') || 'Heads up: the Government services we depend on (VAHAN / e-Challan) are down at times right now, so vehicle details may fail to fetch. If a check fails, please try again after a while.',
    hi: String(await settings.get('check_notice_hi', '') || '') || 'ध्यान दें: हम जिन सरकारी सेवाओं (VAHAN / e-Challan) पर निर्भर हैं, वे अभी कभी-कभी बंद रहती हैं, इसलिए गाड़ी की जानकारी लाने में दिक्कत हो सकती है। अगर जाँच न हो पाए, तो कुछ देर बाद फिर कोशिश करें।',
  };
}

/** Drop the cache after editing policy text, without a restart. */
router.post('/policies/refresh', (_req, res) => {
  cached = null;
  res.json({ success: true, message: 'Policy cache cleared.' });
});


/* ─────────────────────── support tickets (user, 2026-09-23) ─────────────── */

/*
 * The support form opened from a WhatsApp message. No sign-in: the token in
 * the link identifies the customer, who has already proved who they are by
 * messaging from their own number. It expires, and it is looked up rather
 * than decoded — by itself it identifies nobody.
 */
const tickets = require('../support/tickets');

/* Express 4 does not catch a rejected promise from an async handler, and an
   unhandled rejection stops the process. */
const safe = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[public] %s %s: %s', req.method, req.path, e.message);
  if (!res.headersSent) res.status(500).json({ ok: false, error: 'server_error' });
});

router.get('/support/:token', safe(async (req, res) => {
  const who = await tickets.whoIs(req.params.token);
  if (!who) return res.status(404).json({ ok: false, error: 'link_expired' });
  // Only what the form needs to greet them; never the whole account.
  res.json({ ok: true, name: who.name, email: who.email, reg_no: who.reg_no,
             mobile_masked: `${String(who.mobile).slice(0, 2)}****${String(who.mobile).slice(-2)}` });
}));

router.post('/support/:token', express.json(), safe(async (req, res) => {
  const out = await tickets.create({ token: req.params.token, ...(req.body || {}) });
  if (!out.ok) return res.status(out.error === 'link_expired' ? 410 : 400).json(out);
  res.json(out);
}));

module.exports = router;
// The admin panel clears this after editing policy text: an edit nobody can
// see for ten minutes looks like an edit that failed.
module.exports.refresh = () => { cached = null; };
