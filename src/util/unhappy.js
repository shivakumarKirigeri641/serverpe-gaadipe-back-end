/**
 * src/util/unhappy.js — the unhappy-customer catcher (user, 2026-10-03).
 *
 * Someone writing "fraud", "worst", "refund", "money deducted, no report", or
 * leaving 1–2 stars, is told about at once — panel alert, WhatsApp, phone —
 * with what they said and a link to their journey, so a fast human answer can
 * stop a STOP or a bad review. At most one alert per person every six hours.
 * It never changes what the bot replies.
 */

const db = require('../db');

const ANGRY = /\b(fraud|froud|scam|cheat(ed|er|ing)?|chor|loot|bakwas|bakvas|faltu|bekar|bekaar|worst|useless|wasted?|fake|dhoka|thag|pathetic|horrible|disgusting)\b/i;
const MONEY = /\b(refund|money\s*back|paisa\s*wapas|paise\s*wapas|amount\s*deducted|money\s*deducted|deducted|charged\s*twice|double\s*charged|not\s*received|didn'?t\s*(get|receive)|no\s*report|report\s*not|complain(t)?|consumer\s*(court|forum)|police|cyber\s*crime)\b/i;

/** Is this text unhappy, and how? Returns 'money', 'angry' or null. */
function kind(text) {
  const t = String(text || '');
  if (MONEY.test(t)) return 'money';
  if (ANGRY.test(t)) return 'angry';
  return null;
}

/**
 * Flag one person. `said` is their words (or the feedback); `why` names the
 * trigger ('money', 'angry', 'low rating'). Returns true when the admin was told.
 */
async function flag({ mobile, said, why, source = 'whatsapp', rating = null }) {
  if (!mobile) return false;
  const recent = await db.one(
    `SELECT 1 AS x FROM event_log WHERE kind = 'unhappy_flag' AND detail->>'mobile' = $1 AND created_at > now() - interval '6 hours' LIMIT 1`, [mobile]);
  if (recent) return false;
  const who = await db.one(
    `SELECT coalesce(u.display_name, u.wa_profile_name) AS name,
            (SELECT count(*)::int FROM payments p WHERE p.user_id = u.id AND p.status = 'paid' AND p.amount_paise > 0) AS paid
       FROM users u WHERE u.mobile = $1`, [mobile]).catch(() => null);
  await db.query(`INSERT INTO event_log (kind, detail) VALUES ('unhappy_flag', $1)`,
    [JSON.stringify({ mobile, why, source, rating, said: String(said || '').slice(0, 300) })]);
  const label = { money: 'about money or a missing report', angry: 'and sounds upset', 'low rating': `and rated ${rating}★` }[why] || '';
  await require('./adminPing').ping({
    key: `unhappy_${mobile}`, severity: why === 'money' ? 'critical' : 'warning', source: 'customers',
    title: `😟 Unhappy customer ${label}`.trim(),
    text: `${who?.name || 'A customer'} (••••${String(mobile).slice(-4)}${who?.paid ? `, paid ${who.paid}×` : ''}) wrote on ${source}: “${String(said || '').slice(0, 200)}”. `
      + `Reply soon — open Live chats or their journey (/journey?mobile=${mobile}).`,
  });
  return true;
}

module.exports = { kind, flag };
