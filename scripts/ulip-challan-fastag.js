/**
 * scripts/ulip-challan-fastag.js — CHALLANS AND FASTAG FROM ULIP, NO RC (user, 2026-10-20: "for
 * GJ03CT2721 ULIP fails for RC, I need to check challan & fastag from ULIP, give me a script").
 * ULIP's VAHAN answers commercial vehicles only, but its e-Challan and FASTag work for every vehicle.
 *
 * RUN ON THE SERVER ONLY — ULIP allows the server's IP alone, and repeated failed logins lock the
 * account. Two lookups (e-Challan, FASTag), ULIP only (no eChallan.app, no paid source), no RC, nothing
 * sent to anyone. Fresh by default; --cached reads GaadiPe's cache instead (no ULIP call at all).
 *
 *   node scripts/ulip-challan-fastag.js GJ03CT2721
 *   node scripts/ulip-challan-fastag.js GJ03CT2721 --cached
 */
require('dotenv').config();
const gateway = require('../src/vehicle/gateway');

const reg = String(process.argv[2] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const cached = process.argv.includes('--cached');
const money = (p) => (p == null ? '—' : `₹${Math.round(Number(p) / 100).toLocaleString('en-IN')}`);
const day = (d) => (d ? String(d).slice(0, 10) : '—');

(async () => {
  if (!/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/.test(reg)) {
    console.log('usage: node scripts/ulip-challan-fastag.js GJ03CT2721 [--cached]');
    process.exit(1);
  }
  const opts = cached ? { backup: 0, ulip_only: 1 } : { refresh: 1, backup: 0, ulip_only: 1 };
  console.log(`\n${reg} — ${cached ? 'from GaadiPe\'s cache (no ULIP call)' : 'fresh from ULIP'} · RC not asked\n`);

  // e-Challan: every challan, pending and disposed.
  const ch = await gateway.challans(reg, { ...opts, status: 'all', per_page: 50 }).catch((e) => ({ success: false, message: e.message }));
  console.log('E-CHALLAN');
  if (!ch?.success) {
    console.log(`  ❌ ${ch?.error || ''} ${ch?.message || 'no answer'}`);
  } else {
    const s = ch.summary || {};
    console.log(`  pending ${s.pending_count ?? '—'} (${money(s.pending_amount_paise)}) · disposed ${s.disposed_count ?? '—'} · total listed ${ch.total}`);
    console.log(`  ${ch.cached ? `cached, ${ch.age_minutes} min old` : 'fresh'} · ULIP calls made: ${ch.ulip_calls_made ?? 0}`);
    for (const c of ch.challans || []) {
      const offence = c.offence || (c.offences || []).map((o) => o.name || o).join('; ') || '—';
      console.log(`  • ${day(c.challan_date || c.date)}  ${String(c.status || '').padEnd(9)} ${money(c.amount_paise).padStart(8)}  ${c.challan_no || ''}`);
      console.log(`      ${offence}${c.place ? ` · ${c.place}` : ''}`);
    }
  }

  // FASTag: tag status, bank, vehicle class, last toll transactions where ULIP gives them.
  const ft = await gateway.fastag(reg, opts).catch((e) => ({ success: false, message: e.message }));
  console.log('\nFASTAG');
  if (!ft?.success) {
    console.log(`  ❌ ${ft?.error || ''} ${ft?.message || 'no answer'}`);
  } else {
    const d = ft.data || ft.fastag || ft;
    const tags = d.tags || (Array.isArray(d) ? d : []);
    console.log(`  ${ft.cached ? `cached, ${ft.age_minutes} min old` : 'fresh'} · ULIP calls made: ${ft.ulip_calls_made ?? (ft.calls || []).length ?? 0}`);
    if (tags.length) {
      for (const t of tags) {
        console.log(`  • tag ${t.tag_id || t.tagId || '—'} · ${t.status || (t.active ? 'Active' : 'Inactive')} · ${t.bank || t.issuer || t.issuer_bank || ''} · class ${t.vehicle_class || t.vc || '—'}`);
      }
    } else {
      console.log('  ' + JSON.stringify(d).slice(0, 600));
    }
    const tx = d.transactions || d.toll_history || [];
    if (tx.length) {
      console.log(`  last ${Math.min(10, tx.length)} toll transactions:`);
      for (const x of tx.slice(0, 10)) console.log(`    ${x.time || x.date || x.readerReadTime || '—'}  ${x.plaza || x.toll_plaza || x.tollPlazaName || ''}  ${x.amount != null ? `₹${x.amount}` : ''}`);
    }
  }
  console.log('');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
