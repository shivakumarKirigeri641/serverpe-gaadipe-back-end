/**
 * src/fleet/excel.js — the fleet's daily Excel (user, 2026-09-29).
 *
 * One clean table: a row per vehicle, a column per document, each cell
 * coloured by its state — green valid, amber due within 30 days, red expired,
 * grey not needed. Frozen header and vehicle column, filters, a legend, and a
 * second sheet with every pending challan. Built with exceljs.
 */

const ExcelJS = require('exceljs');
const { COLUMNS, fmt } = require('./status');

const C = {
  brand: 'FF0F766E', brandSoft: 'FFE6F3F1', ink: 'FF0B1F1C', body: 'FF41514E', line: 'FFD7E3E1', zebra: 'FFF7FAF9',
  valid: ['FFE9F8EF', 'FF0A6C34'], due: ['FFFFF4DC', 'FF8F5600'], expired: ['FFFDE3E1', 'FF912018'],
  na: ['FFF1F4F3', 'FF8A9A97'], missing: ['FFF1F4F3', 'FF6B8380'], unchecked: ['FFF1F4F3', 'FF6B8380'],
};
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin', color: { argb: C.line } };
const border = { top: thin, left: thin, bottom: thin, right: thin };
const STATE_WORD = { ok: 'All good', attention: 'Needs attention', expired: 'Action now', unchecked: 'Not checked yet' };
const STATE_COLOR = { ok: C.valid, attention: C.due, expired: C.expired, unchecked: C.unchecked };

async function build(fleet, list, { date = new Date() } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'GaadiPe'; wb.created = date;

  /* ───────────────────────── sheet 1: every vehicle ── */
  const ws = wb.addWorksheet('Fleet status', {
    views: [{ state: 'frozen', xSplit: 2, ySplit: 5, showGridLines: false }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  const heads = ['#', 'Vehicle number', 'Vehicle', ...COLUMNS.map((c) => c.name), 'Pending challans', 'Challan amount (₹)', 'Blacklist', 'Loan / financier', 'Status', 'Last checked'];
  const widths = [5, 16, 26, 17, 20, 17, 17, 17, 17, 11, 13, 12, 22, 17, 17];
  ws.columns = widths.map((w) => ({ width: w }));
  const lastCol = heads.length;

  // Title, subtitle and legend.
  ws.mergeCells(1, 1, 1, lastCol);
  Object.assign(ws.getCell(1, 1), { value: `GaadiPe Fleet — ${fleet.company}` });
  ws.getCell(1, 1).font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  ws.getCell(1, 1).fill = fill(C.brand);
  ws.getCell(1, 1).alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(1).height = 30;

  const counts = list.reduce((a, v) => { a[v.state] = (a[v.state] || 0) + 1; return a; }, {});
  ws.mergeCells(2, 1, 2, lastCol);
  ws.getCell(2, 1).value = `Status on ${fmt(date)} · ${list.length} vehicle${list.length === 1 ? '' : 's'} · `
    + `${counts.ok || 0} all good · ${(counts.attention || 0) + (counts.expired || 0)} need attention`
    + (counts.unchecked ? ` · ${counts.unchecked} not checked yet` : '');
  ws.getCell(2, 1).font = { size: 11, color: { argb: C.body } };
  ws.getCell(2, 1).fill = fill(C.brandSoft);
  ws.getCell(2, 1).alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(2).height = 20;

  const legend = [['Valid', C.valid], ['Expires within 30 days', C.due], ['Expired', C.expired], ['Not needed / not on record', C.na]];
  let lc = 2;
  ws.getCell(3, 1).value = '';
  for (const [word, [bg, fg]] of legend) {
    const cell = ws.getCell(3, lc);
    cell.value = word; cell.fill = fill(bg); cell.font = { size: 9, bold: true, color: { argb: fg } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' }; cell.border = border;
    lc += 1;
  }
  ws.getRow(3).height = 18;

  // Header row (row 5; row 4 is a spacer).
  const hr = ws.getRow(5);
  hr.values = heads;
  hr.height = 30;
  hr.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = fill(C.ink);
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = border;
  });

  list.forEach((v, i) => {
    const r = ws.getRow(6 + i);
    r.values = [
      i + 1, v.reg_no, v.title || '—',
      ...COLUMNS.map((c) => v.docs[c.label].text),
      v.pending == null ? 'Checking' : v.pending,
      v.pending_paise == null ? '—' : Math.round(v.pending_paise / 100),
      v.blacklisted ? 'Yes' : 'No',
      v.loan || 'None',
      STATE_WORD[v.state],
      v.checked_at ? fmt(new Date(v.checked_at)) : '—',
    ];
    r.height = 20;
    r.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.border = border;
      cell.alignment = { vertical: 'middle', horizontal: col <= 3 ? 'left' : 'center', indent: col <= 3 ? 1 : 0 };
      cell.font = { size: 10, color: { argb: C.ink } };
      if (i % 2 === 1) cell.fill = fill(C.zebra);
    });
    r.getCell(2).font = { size: 10, bold: true, color: { argb: C.ink } };

    COLUMNS.forEach((c, k) => {
      const d = v.docs[c.label];
      const [bg, fg] = C[d.state] || C.na;
      const cell = r.getCell(4 + k);
      cell.fill = fill(bg);
      cell.font = { size: 10, bold: d.state === 'expired' || d.state === 'due', color: { argb: fg } };
    });
    const chCol = 4 + COLUMNS.length;
    if (v.pending > 0) {
      for (const col of [chCol, chCol + 1]) { r.getCell(col).fill = fill(C.expired[0]); r.getCell(col).font = { size: 10, bold: true, color: { argb: C.expired[1] } }; }
    } else if (v.pending === 0) {
      r.getCell(chCol).fill = fill(C.valid[0]); r.getCell(chCol).font = { size: 10, color: { argb: C.valid[1] } };
    }
    r.getCell(chCol + 1).numFmt = '#,##0';
    if (v.blacklisted) { r.getCell(chCol + 2).fill = fill(C.expired[0]); r.getCell(chCol + 2).font = { size: 10, bold: true, color: { argb: C.expired[1] } }; }
    const [sbg, sfg] = STATE_COLOR[v.state];
    const sc = r.getCell(chCol + 4);
    sc.fill = fill(sbg); sc.font = { size: 10, bold: true, color: { argb: sfg } };
  });

  ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5 + Math.max(1, list.length), column: lastCol } };

  const foot = 7 + list.length;
  ws.mergeCells(foot, 1, foot, lastCol);
  ws.getCell(foot, 1).value = 'Source: Government records (VAHAN, e-Challan) via ULIP, as they stood at the last check. '
    + 'If anything differs from your documents, the RTO record prevails. Reply to the email to add, remove or replace a vehicle.';
  ws.getCell(foot, 1).font = { size: 9, italic: true, color: { argb: C.body } };
  ws.getCell(foot, 1).alignment = { wrapText: true, vertical: 'top' };
  ws.getRow(foot).height = 30;

  /* ───────────────────────── sheet 2: pending challans ── */
  const cs = wb.addWorksheet('Pending challans', { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });
  cs.columns = [
    { header: 'Vehicle number', width: 16 }, { header: 'Challan number', width: 26 }, { header: 'Date', width: 14 },
    { header: 'Offence', width: 46 }, { header: 'Place', width: 30 }, { header: 'Amount (₹)', width: 13 }, { header: 'In court', width: 10 },
  ];
  cs.getRow(1).height = 24;
  cs.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }; cell.fill = fill(C.ink);
    cell.alignment = { vertical: 'middle', horizontal: 'center' }; cell.border = border;
  });
  let rowN = 2;
  for (const v of list) {
    for (const p of (v.challans?.pending || [])) {
      const when = p.challan_date ? new Date(p.challan_date) : null;
      const r = cs.getRow(rowN);
      r.values = [
        v.reg_no, p.challan_no || '—', when && !Number.isNaN(when.getTime()) ? fmt(when) : '—',
        p.offence || (p.offences || []).map((o) => o.name).join('; ') || '—', p.place || '—',
        p.amount_paise != null ? Math.round(p.amount_paise / 100) : '—',
        p.sent_to_court || p.sent_to_virtual_court ? 'Yes' : 'No',
      ];
      r.eachCell({ includeEmpty: true }, (cell, col) => {
        cell.border = border; cell.font = { size: 10, color: { argb: C.ink } };
        cell.alignment = { vertical: 'top', wrapText: col === 4 || col === 5, horizontal: col === 6 ? 'right' : 'left' };
        if (rowN % 2 === 1) cell.fill = fill(C.zebra);
      });
      r.getCell(6).numFmt = '#,##0';
      rowN += 1;
    }
  }
  if (rowN === 2) {
    cs.mergeCells(2, 1, 2, 7);
    cs.getCell(2, 1).value = 'No pending challans on any vehicle. ✅';
    cs.getCell(2, 1).font = { size: 11, color: { argb: C.valid[1] }, bold: true };
    cs.getCell(2, 1).fill = fill(C.valid[0]);
  } else {
    cs.autoFilter = { from: { row: 1, column: 1 }, to: { row: rowN - 1, column: 7 } };
  }

  return wb.xlsx.writeBuffer();
}

module.exports = { build };
