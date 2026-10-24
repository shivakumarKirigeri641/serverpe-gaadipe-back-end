/**
 * src/whatsapp/quizpeTest.js — TRYING QUIZPE'S WHATSAPP FLOW ON GAADIPE'S NUMBER (user, 2026-10-24: "test flow in
 * QuizPe … as separate, but do not disturb live of GaadiPe").
 *
 * Only for the numbers in QUIZPE_TEST_MOBILES (10-digit, comma-separated). A webhook that concerns ONLY those
 * numbers — their messages, and the delivery receipts of what was sent to them — is passed, byte for byte with
 * Meta's signature, to QuizPe's webhook (QUIZPE_FORWARD_URL), and GaadiPe does nothing else with it: no customer
 * row, no reply, no log. Everyone else, and anything mixed, stays with GaadiPe exactly as before.
 *
 * Both settings empty = off (the default). QuizPe replies from this number with its own code; it must have
 * WHATSAPP_ALLOWED_RECIPIENTS set to the same numbers, so it can never message anyone else from here.
 */

const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const list = () => new Set(String(process.env.QUIZPE_TEST_MOBILES || '').split(',').map(last10).filter((m) => m.length === 10));

/** Every message and receipt in this webhook belongs to a QuizPe test number (and there is at least one). */
function claims(body) {
  const nums = list();
  if (!nums.size || !process.env.QUIZPE_FORWARD_URL || body?.object !== 'whatsapp_business_account') return false;
  let seen = 0;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') return false;           // account news always stays with GaadiPe
      const v = change.value || {};
      for (const m of v.messages || []) { if (!nums.has(last10(m.from))) return false; seen += 1; }
      for (const s of v.statuses || []) { if (!nums.has(last10(s.recipient_id))) return false; seen += 1; }
    }
  }
  return seen > 0;
}

/** Hand the webhook to QuizPe as Meta sent it (QuizPe checks the same signature). Never throws. */
async function forward(rawBody, signature) {
  try {
    const res = await fetch(process.env.QUIZPE_FORWARD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(signature ? { 'X-Hub-Signature-256': signature } : {}) },
      body: rawBody,
      signal: AbortSignal.timeout(10000),
    });
    console.log('[wa] quizpe-test: forwarded to QuizPe (%d)', res.status);
  } catch (e) {
    console.warn('[wa] quizpe-test: QuizPe did not take it: %s', e.message);
  }
}

module.exports = { claims, forward };
