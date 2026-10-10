/**
 * src/admin/notMe.js — KEEP MY OWN VISITS OUT OF THE NUMBERS (user, 2026-10-08:
 * 383 visits, 1 sale — and much of it was the owner testing).
 *
 * Internal people are users.is_internal (from the internal_mobiles setting,
 * vehicle/store.js upsertUser; switched from the admin panel's "This is me").
 * A website DEVICE is internal once anyone internal has signed in on it — its
 * visits before and after that sign-in are left out too, because the same
 * browser keeps the same visitor id and device key.
 *
 * SQL fragments, each a condition that is TRUE for a real customer:
 *   visitor(col)  events.visitor_id / visitors.visitor_id
 *   user(col)     a users.id
 *   mobile(col)   a 10-digit mobile
 *   device(col)   the chat's device key (event_log detail->>'device')
 */

const INTERNAL_VISITORS = `SELECT iv.visitor_id FROM visitors iv JOIN users iu ON (iu.id = iv.user_id OR iu.mobile = iv.mobile) WHERE iu.is_internal`;

const user = (col) => `(${col} IS NULL OR ${col} NOT IN (SELECT id FROM users WHERE is_internal))`;
const device = (col) => `(${col} IS NULL OR ${col} NOT IN (SELECT s.device_id FROM site_sign_ins s JOIN users u ON u.id = s.user_id WHERE u.is_internal AND s.device_id IS NOT NULL))`;

module.exports = {
  visitor: (col) => `(${col} IS NULL OR ${col} NOT IN (${INTERNAL_VISITORS}))`,
  user,
  mobile: (col) => `(${col} IS NULL OR right(${col}, 10) NOT IN (SELECT right(mobile, 10) FROM users WHERE is_internal))`,
  device,
  /* (user, 2026-10-10: "ignore my sign-ins, checks and test payments in admin")
     event(a)  an event_log row (alias a): not an internal person's, and not from a
               device an internal person signed in on (their checks before signing in)
     pay(a)    a payments row (alias a): not an internal person's, and not a TEST-mode
               payment (the owner's Razorpay test purchases, raw.test_mode) */
  event: (a) => `(${user(`${a}.user_id`)} AND ${device(`${a}.detail->>'device'`)})`,
  pay: (a) => `(${user(`${a}.user_id`)} AND (${a}.raw->>'test_mode') IS NULL)`,
  //   evt(a)    an events row (alias a): not an internal person's — by account, mobile or visitor
  evt: (a) => `(${user(`${a}.user_id`)} AND (${a}.mobile IS NULL OR right(${a}.mobile, 10) NOT IN (SELECT right(mobile, 10) FROM users WHERE is_internal))`
    + ` AND (${a}.visitor_id IS NULL OR ${a}.visitor_id NOT IN (${INTERNAL_VISITORS})))`,
};
