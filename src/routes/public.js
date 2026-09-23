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
      versions[slug] = rows.length
        ? { version: rows[rows.length - 1].version, effective_from: rows[rows.length - 1].effective_from }
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
