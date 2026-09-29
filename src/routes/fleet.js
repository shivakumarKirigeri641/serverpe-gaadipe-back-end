/**
 * src/routes/fleet.js — the fleet enquiry form, at /fleet/<token> (user,
 * 2026-09-29). Opened from WhatsApp's "For fleets"; one screen, no sign-in.
 * What it sends is emailed to support@gaadipe.in (src/fleet/enquiries.js).
 */

const express = require('express');
const enquiries = require('../fleet/enquiries');

const router = express.Router();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safe = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const page = (title, body) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · GaadiPe</title>
<style>
  :root { --brand:#0F766E; --ink:#0B1F1C; --body:#41514E; --line:#E3ECEA; --soft:#F3F8F7; --bad:#B42318; --good:#0A6C34; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--soft); color:var(--ink); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:480px; margin:0 auto; padding:20px 16px 40px; }
  .brand { display:flex; align-items:center; gap:10px; margin:8px 0 18px; }
  .logo { width:34px; height:34px; border-radius:9px; background:var(--brand); color:#fff; display:grid; place-items:center; font-weight:700; font-size:13px; }
  .brand b { font-size:19px; } .brand span { color:var(--body); font-size:12px; display:block; }
  .card { background:#fff; border:1px solid var(--line); border-radius:14px; padding:18px; margin-bottom:14px; }
  h1 { font-size:18px; margin:0 0 6px; } h2 { font-size:15px; margin:0 0 12px; }
  p { margin:0 0 10px; color:var(--body); font-size:14px; }
  ul { margin:6px 0 0; padding-left:18px; color:var(--body); font-size:13.5px; } li { margin:3px 0; }
  .fld { display:block; margin:0 0 12px; }
  .fld span { display:block; font-size:12.5px; font-weight:600; color:var(--body); margin-bottom:4px; }
  .fld em { font-style:normal; font-weight:400; color:#6b8380; }
  input, textarea { width:100%; padding:11px 12px; border:1px solid var(--line); border-radius:10px; font:inherit; color:var(--ink); background:#fff; }
  input:focus, textarea:focus { outline:2px solid rgba(15,118,110,.25); border-color:var(--brand); }
  textarea { min-height:90px; resize:vertical; }
  .two { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  button { width:100%; padding:15px; border:0; border-radius:12px; background:var(--brand); color:#fff; font-size:16px; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.55; }
  .err { color:var(--bad); font-size:13.5px; margin-top:10px; text-align:center; min-height:1em; }
  .ok { text-align:center; } .ok .tick { font-size:42px; }
  .muted { color:var(--body); font-size:12px; }
  .foot { text-align:center; color:var(--body); font-size:11.5px; margin-top:18px; }
  a { color:var(--brand); }
</style>
</head><body><div class="wrap">
<div class="brand"><div class="logo">GP</div><div><b>GaadiPe</b><span>for fleets</span></div></div>
${body}
<div class="foot">ServerPe App Solutions · <a href="https://gaadipe.in/privacy">Privacy</a></div>
</div></body></html>`;

const closed = (why) => page('Fleet enquiry', `<div class="card ok">
  <div class="tick">${why === 'sent' ? '✅' : '⌛'}</div>
  <h1>${why === 'sent' ? 'Already sent — thank you!' : why === 'expired' ? 'This link has expired' : 'This link is not valid'}</h1>
  <p>${why === 'sent'
    ? 'We have your fleet enquiry and will email you your plan, dashboard access and payment link.'
    : 'Open WhatsApp and tap <b>More → For fleets</b> again for a fresh link. You can also email <a href="mailto:support@gaadipe.in">support@gaadipe.in</a>.'}</p></div>`);

router.get('/fleet/:token', safe(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const got = await enquiries.open(req.params.token);
  if (!got.ok) return res.status(got.reason === 'unknown' ? 404 : 410).send(closed(got.reason));
  const r = got.row;
  res.send(page('Fleet enquiry', `
<div class="card">
  <h1>🚛 GaadiPe for fleets</h1>
  <p>For businesses with <b>5 or more vehicles</b>: taxis, goods vehicles, buses, rentals.</p>
  <ul>
    <li>One <b>Excel report every day</b> covering all your vehicles</li>
    <li>Challans, insurance, PUC (emission test), tax, fitness and permit</li>
    <li>Warnings before anything expires</li>
    <li>A dashboard for your fleet, and a GST invoice</li>
  </ul>
</div>
<form class="card" id="f" novalidate>
  <h2>Tell us about your fleet</h2>
  <label class="fld"><span>Company / business name</span><input name="company" maxlength="120" autocomplete="organization" required></label>
  <label class="fld"><span>Your name</span><input name="contact_name" maxlength="80" autocomplete="name" value="${esc(r.known_name || '')}" required></label>
  <label class="fld"><span>Email <em>— your plan, reports and invoices go here</em></span><input name="email" type="email" inputmode="email" maxlength="160" autocomplete="email" value="${esc(r.known_email || '')}" required></label>
  <div class="two">
    <label class="fld"><span>Number of vehicles</span><input name="vehicles" type="number" inputmode="numeric" min="1" max="100000" required></label>
    <label class="fld"><span>City / state <em>(optional)</em></span><input name="city" maxlength="80" autocomplete="address-level2"></label>
  </div>
  <label class="fld"><span>GSTIN <em>(optional — for a GST invoice)</em></span><input name="gstin" maxlength="15" autocapitalize="characters" placeholder="29ABCDE1234F1Z5"></label>
  <label class="fld"><span>Vehicle numbers <em>(optional — one per line, or later by email)</em></span><textarea name="vehicle_list" autocapitalize="characters" placeholder="KA01AB1234&#10;KA01AB5678"></textarea></label>
  <label class="fld"><span>Anything else? <em>(optional)</em></span><textarea name="message" maxlength="2000" placeholder="e.g. which vehicle types, best time to call"></textarea></label>
  <p class="muted">Sent to support@gaadipe.in from your WhatsApp number${r.mobile ? ` (+91 ${esc(String(r.mobile).slice(-10))})` : ''}.</p>
  <button id="send" type="submit">Send enquiry</button>
  <div class="err" id="err"></div>
</form>
<div class="card ok" id="done" style="display:none">
  <div class="tick">✅</div>
  <h1>Thank you!</h1>
  <p id="doneText">We have your enquiry and will email you your plan, dashboard access and payment link.</p>
  <p class="muted">You can close this page and go back to WhatsApp.</p>
</div>
<script>
  var f = document.getElementById('f'), btn = document.getElementById('send'), err = document.getElementById('err');
  f.onsubmit = function (e) {
    e.preventDefault(); err.textContent = ''; btn.disabled = true; btn.textContent = 'Sending…';
    var d = {}; new FormData(f).forEach(function (v, k) { d[k] = v; });
    fetch(location.pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) })
      .then(function (r) { return r.json(); })
      .then(function (out) {
        if (!out.ok) { err.textContent = out.message || 'Please check the form.'; btn.disabled = false; btn.textContent = 'Send enquiry'; return; }
        f.style.display = 'none'; document.getElementById('done').style.display = 'block';
        document.getElementById('doneText').textContent = 'Enquiry FLEET-' + out.id + ' is with our team. Your plan, dashboard access and payment link will be emailed to ' + out.email + '.';
        window.scrollTo(0, 0);
      })
      .catch(function () { err.textContent = 'Please check your connection and try again.'; btn.disabled = false; btn.textContent = 'Send enquiry'; });
  };
</script>`));
}));

router.post('/fleet/:token', express.json({ limit: '40kb' }), safe(async (req, res) => {
  const out = await enquiries.submit(req.params.token, req.body, { ip: req.ip, userAgent: req.get('user-agent') });
  res.status(out.ok ? 200 : 400).json(out);
}));

module.exports = router;
