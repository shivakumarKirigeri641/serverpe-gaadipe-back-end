/**
 * src/util/adminPing.js — tell the admin something now (user, 2026-10-03).
 *
 * Email is off on the server, so an urgent message goes three ways:
 *   1. an admin alert — the panel's pop-up and sound (admin/alerts.js)
 *   2. WhatsApp to admin_whatsapp_numbers, while that number's 24-hour
 *      window is open (free text; a closed window is skipped, not charged)
 *   3. email, only if the mailer is configured
 * and to the phone through push notifications (util/push.js) when set up.
 *
 * Never throws: a failed ping must not break the job that raised it.
 */

const settings = require('./settings');

async function adminNumbers() {
  return String(await settings.get('admin_whatsapp_numbers', ''))
    .split(/[,\s;]+/).map((x) => x.replace(/\D/g, '').slice(-10)).filter((x) => x.length === 10);
}

/**
 * @param {object} p
 * @param {string} p.key       alert rule key (one open alert per key)
 * @param {string} p.title     one line
 * @param {string} p.text      the WhatsApp / push body
 * @param {'critical'|'warning'|'info'} [p.severity]
 * @param {string} [p.source]
 * @param {boolean} [p.alert]  raise a panel alert (default true); false for good news
 */
async function ping({ key, title, text, severity = 'warning', source = 'system', alert = true }) {
  if (alert) {
    await require('../admin/alerts').raise({ key, severity, source, title, description: text }).catch(() => {});
  }
  try {
    const send = require('../whatsapp/send');
    for (const m of await adminNumbers()) {
      if (await send.windowOpen(m).catch(() => false)) await send.text(m, `*${title}*\n\n${text}`).catch(() => {});
    }
  } catch { /* WhatsApp unavailable */ }
  try {
    const mailer = require('../mail/mailer');
    if (mailer.configured()) {
      const T = require('../mail/templates');
      await mailer.send({ subject: title, ...T.layout({ badge: { text: 'GaadiPe', tone: severity === 'critical' ? 'wrong' : 'info' }, title, lead: text }) });
    }
  } catch { /* mail unavailable */ }
  try { await require('./push').toAdmins({ title, body: text, tag: key }); } catch { /* push not set up */ }
}

module.exports = { ping, adminNumbers };
