-- A customer's last_seen_at follows the website too (2026-10-07: "in Customers I
-- don't see who just came"). Only WhatsApp messages used to move it; the website
-- heartbeat now does (src/site/presence.js). This catches up from past visits.
UPDATE users u SET last_seen_at = w.seen
  FROM (SELECT user_id, max(last_seen_at) AS seen FROM web_sessions WHERE user_id IS NOT NULL GROUP BY user_id) w
 WHERE u.id = w.user_id AND (u.last_seen_at IS NULL OR u.last_seen_at < w.seen);
