/**
 * src/util/providerStatus.js — how the outside services are doing, as the real
 * calls find them (user, 2026-10-01, the admin panel's status strip).
 *
 *   record(provider, { ok, ms, error })   after every live call; never throws,
 *                                         never slows the call it follows
 *   all()                                 each provider with a state:
 *     ok        answering normally
 *     degraded  failures among the recent calls in the last 30 minutes
 *     down      three or more failures in a row
 *     idle      no call in 24 hours, so nothing is known
 *
 * "Ok" means the service answered — a vehicle not found, or a customer's
 * WhatsApp that cannot take the message, is an answer, not an outage.
 */

const db = require('../db');

const LABEL = {
  vahan: 'VAHAN (RC)', rc_backup: 'RC backup', echallan: 'eChallan', fastag: 'FASTag', whatsapp: 'WhatsApp', razorpay: 'Razorpay', email: 'Email',
};

function record(provider, { ok, ms = null, error = null } = {}) {
  db.query(
    `INSERT INTO provider_status AS p (provider, last_ok_at, last_fail_at, last_error, last_ms, consecutive_fails, recent, calls, modified_at)
          VALUES ($1, CASE WHEN $2 THEN now() END, CASE WHEN $2 THEN NULL ELSE now() END, $3, $4,
                  CASE WHEN $2 THEN 0 ELSE 1 END, jsonb_build_array($2::boolean), 1, now())
     ON CONFLICT (provider) DO UPDATE SET
       last_ok_at        = CASE WHEN $2 THEN now() ELSE p.last_ok_at END,
       last_fail_at      = CASE WHEN $2 THEN p.last_fail_at ELSE now() END,
       last_error        = CASE WHEN $2 THEN p.last_error ELSE $3 END,
       last_ms           = coalesce($4, p.last_ms),
       consecutive_fails = CASE WHEN $2 THEN 0 ELSE p.consecutive_fails + 1 END,
       recent            = (SELECT coalesce(jsonb_agg(x ORDER BY i), '[]'::jsonb)
                              FROM jsonb_array_elements(jsonb_build_array($2::boolean) || p.recent) WITH ORDINALITY AS t(x, i)
                             WHERE i <= 20),
       calls             = p.calls + 1,
       modified_at       = now()`,
    [provider, Boolean(ok), error ? String(error).slice(0, 300) : null, Number.isFinite(ms) ? Math.round(ms) : null])
    .catch(() => { /* the status strip must never cost a customer anything */ });
}

async function all() {
  const { rows } = await db.query(`SELECT * FROM provider_status`).catch(() => ({ rows: [] }));
  const by = Object.fromEntries(rows.map((r) => [r.provider, r]));
  const lastIn = await db.one(`SELECT max(created_at) AS at FROM whatsapp_messages WHERE direction = 'in'`).catch(() => null);
  const now = Date.now();
  // The RC backup shows only once it is set up on this server.
  const backup = require('../vehicle/rcBackup');
  const keys = Object.keys(LABEL).filter((k) => k !== 'rc_backup' || by.rc_backup || backup.configured());
  // The paid backup's day so far: calls, limit, spend, and whether it is switched on.
  const backupDay = keys.includes('rc_backup')
    ? { ...(await backup.today().catch(() => ({}))), on: await backup.enabled().catch(() => false),
        cost_paise: await require('./settings').num('rc_backup_cost_paise', 300) }
    : null;
  return keys.map((key) => {
    const r = by[key];
    const lastAt = r ? Math.max(r.last_ok_at ? new Date(r.last_ok_at).getTime() : 0, r.last_fail_at ? new Date(r.last_fail_at).getTime() : 0) : 0;
    const recent = Array.isArray(r?.recent) ? r.recent : [];
    const fails = recent.slice(0, 10).filter((x) => x === false).length;
    let state = 'idle';
    if (r && now - lastAt < 24 * 3600e3) {
      const recentFail = r.last_fail_at && now - new Date(r.last_fail_at).getTime() < 30 * 60e3;
      if (r.consecutive_fails >= 3) state = 'down';
      // Amber while the latest call failed, or failures are still frequent; a
      // service that has just come back shows green at once.
      else if (recentFail && (recent[0] === false || fails >= 3)) state = 'degraded';
      else state = 'ok';
    }
    return {
      key, label: LABEL[key], state,
      last_ok_at: r?.last_ok_at || null, last_fail_at: r?.last_fail_at || null, last_error: r?.last_error || null,
      last_ms: r?.last_ms ?? null, consecutive_fails: r?.consecutive_fails || 0,
      recent_ok: recent.slice(0, 10).filter((x) => x === true).length, recent_total: recent.slice(0, 10).length,
      ...(key === 'whatsapp' ? { last_inbound_at: lastIn?.at || null } : {}),
      ...(key === 'rc_backup' ? { backup: backupDay } : {}),
    };
  });
}

module.exports = { record, all, LABEL };
