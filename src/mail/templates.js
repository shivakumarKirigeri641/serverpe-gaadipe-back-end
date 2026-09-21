/**
 * src/mail/templates.js — how the admin's emails look.
 *
 * ONE LAYOUT for every email, built from tables and inline styles because that
 * is what Gmail, Outlook and phone mail apps all draw the same way: a teal
 * header with the product name, a coloured badge saying what happened, the
 * headline figures, a table of every detail, a button into the admin panel,
 * and a quiet footer saying why this arrived. A plain-text version travels
 * with every email for clients that will not show HTML.
 */

const PANEL = () => (process.env.ADMIN_PANEL_URL || 'https://admin.gaadipe.in').replace(/\/+$/, '');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TONES = {
  good:  { bg: '#e9f8ef', fg: '#0a6c34', bar: '#12a150' },
  info:  { bg: '#e7f3f2', fg: '#0b4f4a', bar: '#0f766e' },
  watch: { bg: '#fff6e6', fg: '#8f5600', bar: '#e08700' },
  wrong: { bg: '#fdecec', fg: '#912018', bar: '#d92d20' },
};

const IST_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 18 Sep 2026, 7:04 pm IST — in India's time, whatever the server's clock says. */
function ist(v) {
  if (!v) return '—';
  const d = new Date(new Date(v).getTime() + 5.5 * 3600 * 1000);
  let h = d.getUTCHours(); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12;
  return `${d.getUTCDate()} ${IST_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${h}:${String(d.getUTCMinutes()).padStart(2, '0')} ${ap} IST`;
}
const rupees = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const mobile = (m) => { const s = String(m || '').replace(/\D/g, '').slice(-10); return s.length === 10 ? `+91 ${s.slice(0, 5)} ${s.slice(5)}` : (m || '—'); };
const duration = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60); return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};

/**
 * The layout.
 *   badge:    { text, tone }            what happened, in two or three words
 *   title:    the headline
 *   lead:     one sentence under it
 *   stats:    [[label, value], …]       up to four big figures
 *   sections: [{ heading, rows: [[k, v], …] }]  every detail
 *   note:     a block of free text (a message someone wrote)
 *   cta:      { label, path }           a button into the admin panel
 *   cta.url:  an absolute link instead (customer email)
 *   tagline, footerHtml, blocks: customer email — its own header line, a footer
 *            with links, and raw HTML blocks placed after the sections
 *            (intro: raw HTML blocks placed before them)
 */
function layout({ preheader = '', badge, title, lead, stats = [], sections = [], note, cta, footer,
                  tagline = 'Admin alert', footerHtml = '', blocks = [], intro = [] }) {
  const tone = TONES[badge?.tone] || TONES.info;
  const statCells = stats.map(([k, v]) => `
      <td style="padding:0 6px 12px 6px;" width="${Math.floor(100 / stats.length)}%" valign="top">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6faf9;border:1px solid #e3ecea;border-radius:10px;">
          <tr><td style="padding:12px 14px;">
            <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#6b8380;">${esc(k)}</div>
            <div style="font-size:19px;font-weight:700;color:#0b1f1c;margin-top:3px;">${esc(v)}</div>
          </td></tr>
        </table>
      </td>`).join('');

  const sectionHtml = sections.filter((s) => s && s.rows && s.rows.some(([, v]) => v !== null && v !== undefined && v !== '')).map((s) => `
    <tr><td style="padding:18px 28px 4px 28px;">
      <div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#0f766e;">${esc(s.heading)}</div>
    </td></tr>
    <tr><td style="padding:6px 28px 0 28px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        ${s.rows.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v], i) => `
        <tr style="background:${i % 2 ? '#ffffff' : '#f9fbfb'};">
          <td style="padding:8px 10px;font-size:13px;color:#6b8380;width:38%;border-bottom:1px solid #eef3f2;vertical-align:top;">${esc(k)}</td>
          <td style="padding:8px 10px;font-size:13px;color:#0b1f1c;font-weight:600;border-bottom:1px solid #eef3f2;vertical-align:top;word-break:break-word;">${typeof v === 'object' && v && v.html ? v.html : esc(v)}</td>
        </tr>`).join('')}
      </table>
    </td></tr>`).join('');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#eef4f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader || lead || title)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef4f3;">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 28px rgba(11,31,28,.08);">
    <tr><td style="background:#0f766e;background-image:linear-gradient(135deg,#0b4f4a,#0f766e 55%,#14918a);padding:22px 28px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="color:#ffffff;">
          <div style="font-size:22px;font-weight:800;letter-spacing:-.3px;">GaadiPe</div>
          <div style="font-size:12px;opacity:.8;margin-top:2px;">Har gaadi ki kundli · ${esc(tagline)}</div>
        </td>
        <td align="right" style="color:#d6efec;font-size:12px;">${esc(ist(new Date()))}</td>
      </tr></table>
    </td></tr>
    <tr><td style="height:4px;background:${tone.bar};"></td></tr>
    <tr><td style="padding:24px 28px 6px 28px;">
      ${badge ? `<span style="display:inline-block;background:${tone.bg};color:${tone.fg};font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;">${esc(badge.text)}</span>` : ''}
      <h1 style="margin:12px 0 6px 0;font-size:22px;line-height:1.3;color:#0b1f1c;">${esc(title)}</h1>
      ${lead ? `<p style="margin:0;font-size:14px;line-height:1.55;color:#41514e;">${esc(lead)}</p>` : ''}
    </td></tr>
    ${stats.length ? `<tr><td style="padding:16px 22px 0 22px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${statCells}</tr></table></td></tr>` : ''}
    ${note ? `<tr><td style="padding:14px 28px 0 28px;"><div style="background:#f6faf9;border-left:4px solid ${tone.bar};border-radius:8px;padding:14px 16px;font-size:14px;line-height:1.6;color:#0b1f1c;white-space:pre-wrap;">${esc(note)}</div></td></tr>` : ''}
    ${intro.map((b) => `<tr><td style="padding:14px 28px 0 28px;">${b}</td></tr>`).join('')}
    ${sectionHtml}
    ${blocks.map((b) => `<tr><td style="padding:14px 28px 0 28px;">${b}</td></tr>`).join('')}
    ${cta ? `<tr><td style="padding:24px 28px 8px 28px;" align="left">
      <a href="${esc(cta.url || (PANEL() + (cta.path || '')))}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:10px;">${esc(cta.label)} →</a>
    </td></tr>` : ''}
    <tr><td style="padding:22px 28px 26px 28px;">
      <div style="border-top:1px solid #e3ecea;padding-top:14px;font-size:11.5px;line-height:1.6;color:#6b8380;">
        ${esc(footer || 'You are receiving this because you administer GaadiPe. Alerts can be switched off under Settings in the admin panel.')}<br>
        ${footerHtml ? `${footerHtml}<br>` : ''}GaadiPe · ServerPe App Solutions · Bengaluru · This mailbox is not monitored — please do not reply.
      </div>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  const text = [
    `GaadiPe — ${badge ? `${badge.text}: ` : ''}${title}`,
    lead || '',
    stats.map(([k, v]) => `${k}: ${v}`).join('\n'),
    note ? `\n${note}\n` : '',
    ...sections.filter(Boolean).map((s) => `\n${s.heading.toUpperCase()}\n${s.rows
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `  ${k}: ${typeof v === 'object' && v && v.text ? v.text : v}`).join('\n')}`),
    cta ? `\n${cta.label}: ${cta.url || `${PANEL()}${cta.path || ''}`}` : '',
  ].filter(Boolean).join('\n');

  return { html, text };
}

module.exports = { layout, esc, ist, rupees, mobile, duration, PANEL };
