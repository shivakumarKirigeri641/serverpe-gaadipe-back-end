/**
 * src/jobs/tagShipping.js — WHERE THE STICKERS ARE (2026-10-29; src/tags/orders.js refreshTracking). Every few hours,
 * while Delhivery is set up, each booked sticker parcel's status is read (a GET) and a delivered one is marked delivered.
 */
async function tick() {
  if (!require('../ship/delhivery').configured()) return;
  const out = await require('../tags/orders').refreshTracking();
  if (out.updated) console.log('[tag-ship] tracking: %d checked, %d updated, %d delivered', out.checked, out.updated, out.delivered);
}

function start(everySeconds = 3 * 3600) {
  setInterval(require('../util/heartbeat').wrap('tag_shipping', tick, everySeconds), everySeconds * 1000).unref();
}

module.exports = { start, tick };
