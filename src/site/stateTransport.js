/**
 * src/site/stateTransport.js — each state's transport department, for the RTO line on a
 * vehicle (user, 2026-10-14: "CarInfo shows the respective RTO website and phone").
 *
 * WEBSITES: only addresses that opened on 14 Oct 2026 and are that state's transport
 * department. A state left out (no site, or one that fails — an expired certificate,
 * a timeout) gets Parivahan, the national portal, rather than a guess.
 *
 * HELPLINES: a number is only shown where it is known to be right, so they are a
 * setting, state_transport_helplines — JSON like {"UP": "1800-180-2877"} — filled from
 * each state's official site. Nothing is shown for a state without one.
 */

const settings = require('../util/settings');

const PARIVAHAN = 'https://parivahan.gov.in';

const SITES = {
  AP: 'https://aptransport.org',
  AS: 'https://transport.assam.gov.in',
  CH: 'https://chdtransport.gov.in',
  CG: 'https://cgtransport.gov.in',
  DL: 'https://transport.delhi.gov.in',
  HR: 'https://hartrans.gov.in',
  HP: 'https://himachal.nic.in/transport',
  JK: 'https://transport.jk.gov.in',
  KA: 'https://transport.karnataka.gov.in',
  KL: 'https://mvd.kerala.gov.in',
  MP: 'https://transport.mp.gov.in',
  MH: 'https://transport.maharashtra.gov.in',
  MZ: 'https://transport.mizoram.gov.in',
  OD: 'https://odishatransport.gov.in',
  PY: 'https://transport.py.gov.in',
  PB: 'https://transport.punjab.gov.in',
  RJ: 'https://transport.rajasthan.gov.in',
  TN: 'https://tnsta.gov.in',
  TS: 'https://transport.telangana.gov.in',
  TR: 'https://transport.tripura.gov.in',
  UP: 'https://uptransport.upsdc.gov.in',
  UK: 'https://transport.uk.gov.in',
};

/* "https://transport.karnataka.gov.in/x" -> "transport.karnataka.gov.in" — what the card prints. */
const label = (url) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

/** The state's transport website (or Parivahan) and its helpline, if one is set. */
async function forState(stateCode) {
  const code = String(stateCode || '').toUpperCase();
  const website = SITES[code] || PARIVAHAN;
  let helpline = null;
  try {
    const all = JSON.parse(String(await settings.get('state_transport_helplines', '{}')) || '{}');
    const n = String(all[code] || '').trim();
    helpline = /^[0-9+][0-9 -]{2,18}[0-9]$/.test(n) ? n : null;
  } catch { /* a broken setting shows no number, never a wrong one */ }
  return { website, website_label: label(website), state_site: Boolean(SITES[code]), helpline };
}

module.exports = { forState, SITES, PARIVAHAN };
