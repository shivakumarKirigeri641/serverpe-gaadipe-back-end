/**
 * src/whatsapp/signature.js
 * ---------------------------------------------------------------------------
 * Prove a webhook body really came from Meta.
 *
 * The endpoint is a public URL that accepts JSON describing customer messages.
 * Without this check, anyone who learns the URL can post whatever they like:
 * fake enquiries, fake payments confirmations, a flood of junk sessions. Meta
 * signs each body with the app secret, so recomputing the HMAC is the only
 * thing separating a real customer from a stranger with curl.
 *
 * Returns a word rather than a boolean so the caller can log *why* — the
 * difference between "not configured yet" and "someone is forging requests"
 * matters, and a bare false hides it.
 * ---------------------------------------------------------------------------
 */

const crypto = require('crypto');

const UNSET = 'unset';     // no secret configured — checking is off
const MISSING = 'missing'; // no signature header at all
const BAD = 'bad';         // present and wrong
const OK = 'ok';

/**
 * @param {Buffer|string} raw  the EXACT bytes received; re-serialised JSON will
 *                             not match, which is why app.js keeps rawBody.
 * @param {string} header      value of x-hub-signature-256
 * @param {string} secret      the app secret
 */
function verify(raw, header, secret) {
  if (!secret) return UNSET;
  if (!header) return MISSING;

  const given = String(header).replace(/^sha256=/i, '');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8'))
    .digest('hex');

  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on a length mismatch, so check length first — and a
  // wrong length is a wrong signature anyway.
  if (a.length !== b.length) return BAD;
  return crypto.timingSafeEqual(a, b) ? OK : BAD;
}

module.exports = { verify, UNSET, MISSING, BAD, OK };
