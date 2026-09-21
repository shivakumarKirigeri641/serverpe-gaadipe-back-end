/**
 * src/routes/email.js — the links in customer email (user, 2026-09-21).
 *
 *   GET  /email/confirm/:token       confirm the address; updates can start
 *   GET  /email/unsubscribe/:token   a page with one button (a link scanner that
 *                                    opens every URL must not unsubscribe anyone)
 *   POST /email/unsubscribe/:token   the button, and the one-click unsubscribe
 *                                    mail apps send (RFC 8058)
 *   POST /email/resubscribe/:token   changed their mind
 *
 * Public by design: the token is the authorisation. It is random, belongs to
 * one customer's current address, and grants nothing but these three things.
 */

const express = require('express');
const db = require('../db');

const router = express.Router();
router.use(express.urlencoded({ extended: false }));

const SITE = () => (process.env.PUBLIC_SITE_URL || 'https://gaadipe.in').replace(/\/+$/, '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (t) => String(t || '').replace(/[^a-f0-9]/gi, '').slice(0, 64);

const userOf = async (token) => (clean(token).length >= 32
  ? db.one(`SELECT id, email, email_verified_at, email_unsubscribed_at FROM users WHERE email_token = $1`, [clean(token)])
  : null);

function page(res, { title, body, status = 200 }) {
  res.status(status).set('Cache-Control', 'no-store').type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} — GaadiPe</title>
<style>
  body{margin:0;background:#eef4f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0b1f1c}
  .w{max-width:460px;margin:48px auto;padding:0 16px}
  .c{background:#fff;border-radius:16px;box-shadow:0 8px 28px rgba(11,31,28,.08);overflow:hidden}
  .h{background:#0f766e;color:#fff;padding:18px 24px;font-weight:800;font-size:20px}
  .b{padding:22px 24px 26px}
  h1{font-size:20px;margin:0 0 8px}
  p{font-size:14px;line-height:1.6;color:#41514e;margin:0 0 14px}
  .btn{display:inline-block;background:#0f766e;color:#fff;border:0;border-radius:10px;padding:11px 20px;font-weight:700;font-size:14px;text-decoration:none;cursor:pointer}
  .q{background:#fff;color:#0f766e;border:1px solid #cfe3e0;margin-left:8px}
</style></head>
<body><div class="w"><div class="c"><div class="h">GaadiPe</div><div class="b">
<h1>${esc(title)}</h1>${body}
</div></div></div></body></html>`);
}

const invalid = (res) => page(res, { status: 404, title: 'This link is no longer valid',
  body: `<p>It may be from an older email, or the address on the account has changed since.</p>
         <a class="btn" href="${esc(SITE())}/app/profile">Open your GaadiPe profile</a>` });

router.get('/email/confirm/:token', async (req, res) => {
  try {
    const u = await userOf(req.params.token);
    if (!u) return invalid(res);
    if (!u.email_verified_at) {
      await db.query(`UPDATE users SET email_verified_at = now(), email_unsubscribed_at = NULL, modified_at = now() WHERE id = $1`, [u.id]);
    }
    page(res, { title: 'Email confirmed',
      body: `<p><b>${esc(u.email)}</b> is confirmed. GaadiPe will email your vehicle updates here in the evening.</p>
             <a class="btn" href="${esc(SITE())}/app">Go to GaadiPe</a>` });
  } catch (e) {
    console.error('[email] confirm:', e.message);
    page(res, { status: 500, title: 'Something went wrong', body: '<p>Please try the link again in a minute.</p>' });
  }
});

router.get('/email/unsubscribe/:token', async (req, res) => {
  try {
    const u = await userOf(req.params.token);
    if (!u) return invalid(res);
    if (u.email_unsubscribed_at) {
      return page(res, { title: 'You are unsubscribed',
        body: `<p>No vehicle update emails go to <b>${esc(u.email)}</b>.</p>
               <form method="post" action="/email/resubscribe/${esc(clean(req.params.token))}"><button class="btn">Subscribe again</button></form>` });
    }
    page(res, { title: 'Stop vehicle update emails?',
      body: `<p>GaadiPe will stop emailing vehicle updates to <b>${esc(u.email)}</b>. Your account, reports and invoices are not affected.</p>
             <form method="post" action="/email/unsubscribe/${esc(clean(req.params.token))}" style="display:inline"><button class="btn">Unsubscribe</button></form>
             <a class="btn q" href="${esc(SITE())}/app">Keep them</a>` });
  } catch (e) {
    console.error('[email] unsubscribe page:', e.message);
    page(res, { status: 500, title: 'Something went wrong', body: '<p>Please try the link again in a minute.</p>' });
  }
});

router.post('/email/unsubscribe/:token', async (req, res) => {
  try {
    const u = await userOf(req.params.token);
    if (!u) return invalid(res);
    await db.query(`UPDATE users SET email_unsubscribed_at = coalesce(email_unsubscribed_at, now()), modified_at = now() WHERE id = $1`, [u.id]);
    await db.query(`INSERT INTO event_log (user_id, kind, detail) VALUES ($1, 'email_unsubscribed', $2)`,
      [u.id, JSON.stringify({ email: u.email, one_click: Boolean(req.body?.['List-Unsubscribe']) })]);
    page(res, { title: 'You are unsubscribed',
      body: `<p>No more vehicle update emails will go to <b>${esc(u.email)}</b>.</p>
             <form method="post" action="/email/resubscribe/${esc(clean(req.params.token))}"><button class="btn">Undo — subscribe again</button></form>` });
  } catch (e) {
    console.error('[email] unsubscribe:', e.message);
    page(res, { status: 500, title: 'Something went wrong', body: '<p>Please try again in a minute.</p>' });
  }
});

router.post('/email/resubscribe/:token', async (req, res) => {
  try {
    const u = await userOf(req.params.token);
    if (!u) return invalid(res);
    await db.query(`UPDATE users SET email_unsubscribed_at = NULL, modified_at = now() WHERE id = $1`, [u.id]);
    page(res, { title: 'Subscribed again',
      body: `<p>Vehicle updates will be emailed to <b>${esc(u.email)}</b> again.</p>
             <a class="btn" href="${esc(SITE())}/app">Go to GaadiPe</a>` });
  } catch (e) {
    console.error('[email] resubscribe:', e.message);
    page(res, { status: 500, title: 'Something went wrong', body: '<p>Please try again in a minute.</p>' });
  }
});

module.exports = router;
