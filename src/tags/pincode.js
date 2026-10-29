/**
 * src/tags/pincode.js — WHERE A PINCODE IS (GaadiPe Tag stickers, 2026-10-29), from its digits alone — no outside call.
 *
 *   stateOf(pin)              GST state code ('29' Karnataka …) for the invoice's place of supply, or null
 *   zoneOf(pin, pickup)       'city' | 'state' | 'india' | 'remote' — which delivery charge applies
 *
 * India Post's postal regions follow the first digits, so the longest matching prefix decides. Close enough for a
 * delivery band and for CGST+SGST vs IGST; a live courier rate (Shiprocket) can replace the zone later.
 */

// Longest prefix wins. GST state codes as on the invoice (pay/invoice.js STATES).
const PREFIX_STATE = [
  ['110', '07'],                                             // Delhi
  ['12', '06'], ['13', '06'],                                // Haryana
  ['14', '03'], ['15', '03'], ['160', '04'], ['16', '03'],   // Punjab, Chandigarh
  ['17', '02'],                                              // Himachal Pradesh
  ['194', '38'], ['18', '01'], ['19', '01'],                 // Ladakh, Jammu & Kashmir
  ['246', '05'], ['247', '05'], ['248', '05'], ['249', '05'], ['262', '05'], ['263', '05'],  // Uttarakhand
  ['20', '09'], ['21', '09'], ['22', '09'], ['23', '09'], ['24', '09'], ['25', '09'], ['26', '09'], ['27', '09'], ['28', '09'],  // Uttar Pradesh
  ['30', '08'], ['31', '08'], ['32', '08'], ['33', '08'], ['34', '08'],  // Rajasthan
  ['396', '26'], ['36', '24'], ['37', '24'], ['38', '24'], ['39', '24'],  // Dadra/Daman, Gujarat
  ['403', '30'], ['40', '27'], ['41', '27'], ['42', '27'], ['43', '27'], ['44', '27'],  // Goa, Maharashtra
  ['45', '23'], ['46', '23'], ['47', '23'], ['48', '23'],    // Madhya Pradesh
  ['49', '22'],                                              // Chhattisgarh
  ['50', '36'],                                              // Telangana
  ['51', '37'], ['52', '37'], ['53', '37'],                  // Andhra Pradesh
  ['56', '29'], ['57', '29'], ['58', '29'], ['59', '29'],    // Karnataka
  ['605', '34'], ['609', '34'], ['60', '33'], ['61', '33'], ['62', '33'], ['63', '33'], ['64', '33'],  // Puducherry, Tamil Nadu
  ['6825', '31'], ['67', '32'], ['68', '32'], ['69', '32'],  // Lakshadweep, Kerala
  ['737', '11'], ['744', '35'], ['70', '19'], ['71', '19'], ['72', '19'], ['73', '19'], ['74', '19'],  // Sikkim, Andaman, West Bengal
  ['75', '21'], ['76', '21'], ['77', '21'],                  // Odisha
  ['78', '18'],                                              // Assam
  ['790', '12'], ['791', '12'], ['792', '12'], ['793', '17'], ['794', '17'], ['795', '14'], ['796', '15'],
  ['797', '13'], ['798', '13'], ['799', '16'],               // Arunachal, Meghalaya, Manipur, Mizoram, Nagaland, Tripura
  ['814', '20'], ['815', '20'], ['816', '20'], ['82', '20'], ['83', '20'],  // Jharkhand
  ['80', '10'], ['81', '10'], ['84', '10'], ['85', '10'],    // Bihar
].sort((a, b) => b[0].length - a[0].length);

// Far, slow or costly to reach: North-East, J&K, Ladakh, Andaman & Nicobar, Lakshadweep, Sikkim.
const REMOTE = new Set(['01', '38', '11', '12', '13', '14', '15', '16', '17', '18', '35', '31']);

const valid = (pin) => /^[1-9][0-9]{5}$/.test(String(pin || ''));

function stateOf(pin) {
  const p = String(pin || '');
  if (!valid(p)) return null;
  const hit = PREFIX_STATE.find(([pre]) => p.startsWith(pre));
  return hit ? hit[1] : null;
}

/** Same city = the same first three digits as the pickup pincode (560013 → every 560xxx: Bengaluru). */
function zoneOf(pin, pickup = '560013') {
  const p = String(pin || '');
  if (!valid(p)) return null;
  const st = stateOf(p);
  if (st && REMOTE.has(st)) return 'remote';
  if (p.slice(0, 3) === String(pickup).slice(0, 3)) return 'city';
  if (st && st === stateOf(pickup)) return 'state';
  return 'india';
}

module.exports = { stateOf, zoneOf, valid };
