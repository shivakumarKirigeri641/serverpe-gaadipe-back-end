/**
 * src/routes/tags.js — WHAT A GAADIPE TAG'S QR OPENS (2026-10-29; src/tags). GET /t/<code>: counts the scan, then opens
 * WhatsApp with "TAG <code>" typed, where the bot asks the person to agree and choose a reason. Our own link rather than
 * wa.me in the QR, so a lost sticker can be switched off and the WhatsApp number can change without reprinting.
 * Public by design: the code grants nothing but the chance to send a preset message through GaadiPe.
 */
const express = require('express');
const T = require('../tags/tags');

const router = express.Router();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} · GaadiPe Tag</title>
<style>body{margin:0;font-family:system-ui,Segoe UI,Arial,sans-serif;background:#f3f7f5;color:#10221d;display:grid;place-items:center;min-height:100vh}
.c{background:#fff;max-width:380px;margin:16px;padding:26px 22px;border-radius:16px;box-shadow:0 8px 28px rgba(0,0,0,.08);text-align:center}
h1{font-size:20px;margin:8px 0}p{color:#4b5d58;line-height:1.5}a.b{display:inline-block;margin-top:12px;background:#25d366;color:#052b1f;
font-weight:800;padding:13px 22px;border-radius:999px;text-decoration:none}</style></head><body><div class="c">${body}</div></body></html>`;

router.get('/t/:code', async (req, res) => {
  try {
    const tag = await T.byCode(req.params.code);
    if (!(await T.live(tag))) {
      return res.status(404).send(page('Not active', `<div style="font-size:42px">🏷️</div><h1>This GaadiPe Tag is not active</h1>
        <p>It may have been switched off by its owner. If you need urgent help with a vehicle, the local traffic police can help.</p>`));
    }
    await T.recordScan(tag.code);
    const wa = T.waLink(tag.code);
    // A redirect works from every camera app; the page is the fallback when an in-app browser holds on to it.
    res.set('Cache-Control', 'no-store');
    return res.status(200).send(page('Contact the owner', `<meta http-equiv="refresh" content="0;url=${esc(wa)}">
      <div style="font-size:42px">🚗</div><h1>Contact the owner of ${esc(T.masked(tag.reg_no))}</h1>
      <p>Opening WhatsApp… Send the message that appears, and GaadiPe will pass your reason to the owner. Your number stays private.</p>
      <a class="b" href="${esc(wa)}">Open WhatsApp</a>
      <script>location.replace(${JSON.stringify(wa)});</script>`));
  } catch (e) {
    console.error('[tag] /t/%s failed: %s', req.params.code, e.message);
    return res.status(500).send(page('Try again', '<h1>Something went wrong</h1><p>Please scan the tag again in a moment.</p>'));
  }
});

/*
 * GET /tr/<tracking no.> — WHERE IS MY STICKER (2026-10-29). The link in the shipped message (WhatsApp button, SMS):
 * our own page with Delhivery's live status read by its API (tags/orders.trackPage), and Delhivery's full tracking as a
 * second link; any other courier: its name and number. Keyed by the tracking number the owner was already given, so it
 * shows nothing they don't have (the plate masked, no name or address).
 */
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
router.get('/tr/:tracking', async (req, res) => {
  try {
    const o = await require('../tags/orders').trackPage(String(req.params.tracking || '').trim().slice(0, 40));
    if (!o) {
      return res.status(404).send(page('Not found', `<div style="font-size:42px">📦</div><h1>Tracking number not found</h1>
        <p>Please check the number in your GaadiPe message.</p>`));
    }
    res.set('Cache-Control', 'no-store');
    const delivered = o.status === 'delivered';
    const status = o.live ? `${o.live.status}${o.live.location ? ` · ${o.live.location}` : ''}` : (o.ship_status || (o.status === 'paid' ? 'Being prepared' : 'Shipped'));
    const at = o.live?.at || o.ship_status_at || o.dispatched_at;
    const isDelhivery = Boolean(o.waybill) || /delhivery/i.test(o.courier || '');
    return res.status(200).send(page('Track your sticker', `<div style="font-size:42px">${delivered ? '✅' : '📦'}</div>
      <h1>${delivered ? 'Delivered' : 'Your sticker is on its way'}</h1>
      <p>GaadiPe Tag sticker${o.quantity > 1 ? `s (${o.quantity})` : ''} for <b>${esc(T.masked(o.reg_no))}</b></p>
      <p style="background:#f3f7f5;border-radius:12px;padding:12px"><b>${esc(status)}</b>${at ? `<br><small>${esc(when(at))}</small>` : ''}</p>
      <p><small>Courier: <b>${esc(o.courier || (isDelhivery ? 'Delhivery' : '—'))}</b> · Tracking no. <b>${esc(o.tracking || o.waybill)}</b></small></p>
      ${delivered ? '<p>Stick it on your vehicle where people can easily see and scan it.</p>' : ''}
      ${isDelhivery ? `<p><a href="${esc(T.trackUrl(o.waybill || o.tracking))}" rel="noopener">Full tracking on Delhivery →</a></p>` : ''}`));
  } catch (e) {
    console.error('[tag] /tr failed: %s', e.message);
    return res.status(500).send(page('Try again', '<h1>Something went wrong</h1><p>Please try again in a moment.</p>'));
  }
});

module.exports = router;
