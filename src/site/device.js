/**
 * src/site/device.js — who is on the other end of a sign-in, as far as the
 * request and the browser will say.
 *
 * Two sources, and both are kept: the user agent (sent by every browser, easy
 * to fake) and what the page itself reports (screen, time zone, languages, and
 * on Chrome the real device model through client hints). Where they disagree,
 * that is itself worth seeing — which is why the raw values are stored beside
 * the parsed ones.
 */

const clip = (v, n = 300) => (v == null || v === '' ? null : String(v).slice(0, n));
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

/** Browser, OS and device from a user agent. Best effort, never throws. */
function parseUA(ua) {
  const s = String(ua || '');
  const out = { browser: null, browser_version: null, os: null, os_version: null,
                device_type: null, device_vendor: null, device_model: null };
  if (!s) return out;

  const hit = (re) => re.exec(s);
  let m;

  // Browser — order matters: Edge and Opera also say Chrome; Chrome also says Safari.
  if ((m = hit(/EdgA?\/([\d.]+)/)) || (m = hit(/Edg\/([\d.]+)/))) { out.browser = 'Edge'; out.browser_version = m[1]; }
  else if ((m = hit(/OPR\/([\d.]+)/))) { out.browser = 'Opera'; out.browser_version = m[1]; }
  else if ((m = hit(/SamsungBrowser\/([\d.]+)/))) { out.browser = 'Samsung Internet'; out.browser_version = m[1]; }
  else if ((m = hit(/UCBrowser\/([\d.]+)/))) { out.browser = 'UC Browser'; out.browser_version = m[1]; }
  else if ((m = hit(/FxiOS\/([\d.]+)/)) || (m = hit(/Firefox\/([\d.]+)/))) { out.browser = 'Firefox'; out.browser_version = m[1]; }
  else if ((m = hit(/CriOS\/([\d.]+)/))) { out.browser = 'Chrome'; out.browser_version = m[1]; }
  else if (/; wv\)/.test(s) && (m = hit(/Chrome\/([\d.]+)/))) { out.browser = 'Android WebView'; out.browser_version = m[1]; }
  else if ((m = hit(/Chrome\/([\d.]+)/))) { out.browser = 'Chrome'; out.browser_version = m[1]; }
  else if ((m = hit(/Version\/([\d.]+).*Safari/))) { out.browser = 'Safari'; out.browser_version = m[1]; }
  if (/FBAN|FBAV/.test(s)) out.browser = 'Facebook in-app';
  else if (/Instagram/.test(s)) out.browser = 'Instagram in-app';
  else if (/WhatsApp/.test(s)) out.browser = 'WhatsApp in-app';

  // OS
  if ((m = hit(/Android\s+([\d.]+)/))) { out.os = 'Android'; out.os_version = m[1]; }
  else if ((m = hit(/(?:iPhone|CPU) OS ([\d_]+)/))) { out.os = /iPad/.test(s) ? 'iPadOS' : 'iOS'; out.os_version = m[1].replace(/_/g, '.'); }
  else if ((m = hit(/Windows NT ([\d.]+)/))) {
    out.os = 'Windows';
    out.os_version = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' }[m[1]] || m[1];
  }
  else if ((m = hit(/Mac OS X ([\d_]+)/))) { out.os = 'macOS'; out.os_version = m[1].replace(/_/g, '.'); }
  else if (/CrOS/.test(s)) out.os = 'ChromeOS';
  else if (/Linux/.test(s)) out.os = 'Linux';

  // Device
  if (/bot|crawler|spider|curl|wget|python|axios|node-fetch|headless/i.test(s)) out.device_type = 'Bot';
  else if (/iPad|Tablet/.test(s) || (/Android/.test(s) && !/Mobile/.test(s))) out.device_type = 'Tablet';
  else if (/Mobile|iPhone|Android/.test(s)) out.device_type = 'Mobile';
  else out.device_type = 'Desktop';

  if (/iPhone/.test(s)) { out.device_vendor = 'Apple'; out.device_model = 'iPhone'; }
  else if (/iPad/.test(s)) { out.device_vendor = 'Apple'; out.device_model = 'iPad'; }
  else if (/Macintosh/.test(s)) { out.device_vendor = 'Apple'; out.device_model = 'Mac'; }
  else if ((m = hit(/Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/|\))/))) {
    const model = m[1].trim();
    if (model && model !== 'K') {                 // "K" is Chrome's frozen placeholder
      out.device_model = model;
      out.device_vendor = /^SM-|Galaxy|Samsung/i.test(model) ? 'Samsung'
        : /^(Redmi|Mi |M2|2201|2107|POCO)/i.test(model) ? 'Xiaomi'
        : /^(CPH|OPPO)/i.test(model) ? 'OPPO'
        : /^(RMX|Realme)/i.test(model) ? 'realme'
        : /^(V2|vivo)/i.test(model) ? 'vivo'
        : /^(Pixel)/i.test(model) ? 'Google'
        : /^(ONEPLUS|[A-Z]{2}\d{4})/i.test(model) ? 'OnePlus'
        : /moto/i.test(model) ? 'Motorola'
        : /^(Nokia|TA-)/i.test(model) ? 'Nokia' : null;
    }
  }
  return out;
}

/**
 * Everything about a request worth keeping. `client` is what the site's own
 * page reported (see the front end's lib/device.js); it is trusted for nothing
 * but kept as said, and allowed to fill gaps the user agent leaves — Chrome
 * no longer puts the phone's model in the user agent, but will say it in a
 * client hint.
 */
function contextOf(req) {
  const c = (req.body && typeof req.body.client === 'object' && req.body.client) || {};
  const ua = req.get('user-agent') || '';
  const parsed = parseUA(ua);
  const hints = c.hints || {};

  return {
    device_id: clip(c.device_id || req.get('x-gp-device'), 64),
    ip: clip(req.ip, 64),
    ip_chain: clip(req.get('x-forwarded-for'), 300),
    country: clip(req.get('cf-ipcountry') || req.get('x-vercel-ip-country') || req.get('x-country'), 64),
    region: clip(req.get('x-vercel-ip-country-region') || req.get('x-region'), 64),
    city: clip(req.get('x-vercel-ip-city') || req.get('x-city'), 64),
    user_agent: clip(ua, 600),
    browser: parsed.browser,
    browser_version: parsed.browser_version,
    os: clip(hints.platform, 40) || parsed.os,
    os_version: clip(hints.platformVersion, 40) || parsed.os_version,
    device_type: hints.mobile === true && parsed.device_type === 'Desktop' ? 'Mobile' : parsed.device_type,
    device_vendor: parsed.device_vendor,
    device_model: clip(hints.model, 80) || parsed.device_model,
    screen: clip(c.screen, 40),
    viewport: clip(c.viewport, 40),
    timezone: clip(c.timezone, 64),
    languages: clip(c.languages || req.get('accept-language'), 200),
    platform: clip(c.platform, 64),
    touch_points: int(c.touch_points),
    cpu_cores: int(c.cpu_cores),
    memory_gb: Number.isFinite(Number(c.memory_gb)) ? Number(c.memory_gb) : null,
    connection: clip(c.connection, 40),
    referrer: clip(c.referrer || req.get('referer'), 300),
    page: clip(c.page, 200),
    client: Object.keys(c).length ? JSON.stringify(c).slice(0, 4000) : null,
  };
}

/** One line for a person to read: "Mobile · Samsung SM-S918B · Android 14 · Chrome 128". */
function describe(r) {
  if (!r) return null;
  const model = [r.device_vendor, r.device_model].filter(Boolean).join(' ');
  return [r.device_type, model || null,
          [r.os, r.os_version].filter(Boolean).join(' ') || null,
          [r.browser, r.browser_version && String(r.browser_version).split('.')[0]].filter(Boolean).join(' ') || null]
    .filter(Boolean).join(' · ') || null;
}

module.exports = { parseUA, contextOf, describe };
