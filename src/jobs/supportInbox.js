/**
 * src/jobs/supportInbox.js — mail to support@gaadipe.in reaches the admin
 * (user, 2026-10-04: "2 mails to support@, no notification").
 *
 * The support mailbox (Hostinger) is separate from the server, so nothing saw
 * what arrived there. Every two minutes this reads its inbox over IMAP — read
 * only: messages are fetched without being marked read, nothing is moved or
 * deleted — and each new email becomes:
 *
 *   • a row on the panel's Support inbox (who, subject, a short preview)
 *   • a ping to the admin: panel pop-up and sound, WhatsApp (in its window),
 *     the phone (push), and email when configured (util/adminPing.js)
 *
 * The first run takes the last seven days quietly and says once how many are
 * waiting. Off unless SUPPORTMAIL and SUPPORTMAIL_PASSWORD are in .env
 * (host: SUPPORTMAIL_IMAP_HOST, default imap.hostinger.com).
 */

const db = require('../db');
const settings = require('../util/settings');

const cfg = () => ({
  user: String(process.env.SUPPORTMAIL || '').trim(),
  pass: String(process.env.SUPPORTMAIL_PASSWORD || ''),
  host: String(process.env.SUPPORTMAIL_IMAP_HOST || 'imap.hostinger.com'),
  port: Number(process.env.SUPPORTMAIL_IMAP_PORT || 993),
});
const configured = () => Boolean(cfg().user && cfg().pass);

async function saveSetting(key, value) {
  await db.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, modified_at = now()`, [key, String(value)]);
  settings.refresh();
}

const short = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);

let running = false;
async function tick() {
  if (running || !configured()) return 0;
  running = true;
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const c = cfg();
  const client = new ImapFlow({ host: c.host, port: c.port, secure: c.port === 993, auth: { user: c.user, pass: c.pass }, logger: false });
  let added = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const validity = String(client.mailbox.uidValidity || '');
      const state = JSON.parse(await settings.get('support_inbox_state', 'null') || 'null');
      const first = !state || state.validity !== validity;
      let uids;
      if (first) {
        uids = await client.search({ since: new Date(Date.now() - 7 * 864e5) }, { uid: true });
      } else {
        uids = (await client.search({ uid: `${Number(state.last) + 1}:*` }, { uid: true })).filter((u) => u > Number(state.last));
      }
      let last = first ? 0 : Number(state.last);
      for (const uid of (uids || []).sort((a, b) => a - b)) {
        const msg = await client.fetchOne(String(uid), { uid: true, envelope: true, internalDate: true, source: true }, { uid: true });
        if (!msg) continue;
        last = Math.max(last, uid);
        const from = msg.envelope?.from?.[0] || {};
        let preview = '';
        try { const parsed = await simpleParser(msg.source); preview = short(parsed.text || parsed.html?.replace(/<[^>]+>/g, ' '), 400); } catch { /* unreadable body */ }
        const row = await db.one(
          `INSERT INTO support_emails (mailbox, uid, message_id, from_name, from_email, subject, preview, received_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (mailbox, uid) DO NOTHING RETURNING id`,
          [c.user, uid, msg.envelope?.messageId || null, short(from.name, 120) || null, short(from.address, 200) || null,
            short(msg.envelope?.subject, 300) || '(no subject)', preview, msg.internalDate || new Date()]);
        if (!row) continue;
        added += 1;
        if (!first) {
          await require('../util/adminPing').ping({
            key: `support_email_${row.id}`, alert: true, severity: 'warning', source: 'support',
            title: `📧 Support email · ${short(from.name || from.address, 40)}`,
            text: `“${short(msg.envelope?.subject, 120) || '(no subject)'}” — ${short(preview, 180)}${preview.length > 180 ? '…' : ''} (to ${c.user}; open Support inbox in the panel)`,
          });
        }
      }
      await saveSetting('support_inbox_state', JSON.stringify({ validity, last, checked_at: new Date().toISOString() }));
      if (first && added) {
        await require('../util/adminPing').ping({
          key: 'support_inbox_start', alert: false, severity: 'info', source: 'support',
          title: `📧 ${added} support email${added === 1 ? '' : 's'} from the last 7 days`,
          text: `The support inbox (${c.user}) is now watched. ${added} email${added === 1 ? ' is' : 's are'} listed on Support inbox in the panel; new ones will be announced as they arrive.`,
        });
      }
    } finally { lock.release(); }
    await client.logout();
    await require('../admin/alerts').clear('support_inbox_failing', 'The support inbox answered again').catch(() => {});
  } catch (e) {
    console.error('[support-inbox]', e.message);
    try { await client.logout(); } catch { /* already closed */ }
    await require('../admin/alerts').raise({
      key: 'support_inbox_failing', severity: 'warning', source: 'support', title: 'Cannot read the support inbox',
      description: `${c.user} on ${c.host}: ${e.message}. Check SUPPORTMAIL / SUPPORTMAIL_PASSWORD in .env.`,
    }).catch(() => {});
  } finally { running = false; }
  return added;
}

async function list({ status = null } = {}) {
  const { rows } = await db.query(
    `SELECT s.*, a.name AS done_by_name FROM support_emails s LEFT JOIN admin_users a ON a.id = s.done_by
      WHERE ($1::text IS NULL OR s.status = $1) ORDER BY s.received_at DESC NULLS LAST LIMIT 300`, [status || null]);
  const state = JSON.parse(await settings.get('support_inbox_state', 'null') || 'null');
  return { configured: configured(), mailbox: cfg().user || null, checked_at: state?.checked_at || null,
           rows: rows.map((r) => ({ ...r, id: String(r.id), uid: String(r.uid) })) };
}

async function setDone(id, adminId, done = true) {
  await db.query(
    `UPDATE support_emails SET status = $2, done_by = CASE WHEN $2 = 'done' THEN $3::bigint END, done_at = CASE WHEN $2 = 'done' THEN now() END
      WHERE id = $1`, [id, done ? 'done' : 'new', adminId || null]);
  return { ok: true };
}

function start(everySeconds = 120) {
  if (!configured()) { console.log('  support inbox: off (SUPPORTMAIL / SUPPORTMAIL_PASSWORD not set)'); return; }
  setTimeout(() => tick().catch(() => {}), 20 * 1000).unref();
  setInterval(() => tick().catch(() => {}), everySeconds * 1000).unref();
  console.log(`  support inbox: ${cfg().user} every ${everySeconds}s`);
}

module.exports = { start, tick, list, setDone, configured };
