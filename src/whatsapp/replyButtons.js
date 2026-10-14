/**
 * src/whatsapp/replyButtons.js — the buttons an admin may put under a reply from the panel
 * (user, 2026-10-13: "Hot leads — give 1, 2 or 3 selectable buttons, a dropdown of all
 * possible buttons and what each does when the customer taps it").
 *
 * Each id is one the bot already answers (whatsapp/flow.js), so a tap does exactly what
 * the same button does anywhere else in the chat. Titles are WhatsApp's 20 characters.
 */
const CATALOG = [
  { id: 'buy_report',      title: 'Get full report',     does: 'Opens the payment link for the full report of the vehicle they checked last (asks for a number if there is none).' },
  { id: 'check_another',   title: 'Check vehicle',       does: 'Asks for a vehicle number and runs the free check.' },
  { id: 'menu_offers',     title: 'Current offers',      does: 'Shows today\'s prices — free check, full report, renewal, replace — and any free reports they hold.' },
  { id: 'what_get',        title: 'What do I get?',      does: 'Explains the free check, the full report, 28-day monitoring and fleets, with a sample report link.' },
  { id: 'my_vehicles',     title: 'My vehicles',         does: 'Lists their vehicles; picking one sends its report or the basic details.' },
  { id: 'download_report', title: 'My reports',          does: 'Sends their report PDFs that are still downloadable.' },
  { id: 'my_monitoring',   title: 'My monitoring',       does: 'Shows each watched vehicle — end date, next alert, paused alerts, renew price.' },
  { id: 'menu_email',      title: 'Email for alerts',    does: 'Shows their confirmed email, or asks for one and confirms it with a 4-digit code.' },
  { id: 'rp_pick',         title: 'Replace vehicle',     does: 'Starts Replace vehicle (₹11, GST included) — only works on paid monitoring within its window.' },
  { id: 'support',         title: 'Help & support',      does: 'Sends a support-ticket link, with the Terms, Privacy and Refund links.' },
  { id: 'feedback',        title: 'Feedback',            does: 'Asks them to type their feedback; the next message is saved as feedback.' },
  { id: 'menu',            title: 'Menu',                does: 'Opens the full GaadiPe menu.' },
];
const BY_ID = Object.fromEntries(CATALOG.map((b) => [b.id, b]));

module.exports = { CATALOG, BY_ID };
