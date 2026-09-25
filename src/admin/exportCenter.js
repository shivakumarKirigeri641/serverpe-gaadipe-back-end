/**
 * src/admin/exportCenter.js — the Export Center (user, 2026-09-25,
 * operations module phase 7).
 * ---------------------------------------------------------------------------
 *   record({...})   log an export and keep its file for 24 hours — called by
 *                   every CSV route, so no export goes unrecorded
 *   create(...)     make an export from here: vehicles, customers, payments,
 *                   revenue (the ledger), API logs, WhatsApp, audit log
 *   list(admin)     every export: who, what, filters, rows, when, expiry
 *   file(id)        the stored file, while it has not expired
 *
 * Each dataset names the permission it needs; customers' numbers are masked
 * unless the role may see them. Expired files are cleared; their records stay.
 * ---------------------------------------------------------------------------
 */

const db = require('../db');

const DATASETS = {
  vehicles: ['Vehicles', 'vehicles.export'],
  customers: ['Customers', 'customers.view'],
  payments: ['Payments', 'payments.view'],
  revenue: ['Revenue (transaction ledger)', 'finance.export'],
  api_logs: ['API logs', 'api.view'],
  whatsapp: ['WhatsApp', 'dashboard.view'],
  searches: ['Vehicle searches', 'customers.view'],
  audit: ['Audit log', 'audit.view'],
};

async function record({ adminId, dataset, filters = {}, csv, rows, masked = null, fileName }) {
  const buf = Buffer.from(`﻿${csv}`, 'utf8');
  const r = await db.one(
    `INSERT INTO export_jobs (admin_id, dataset, filters, records, file_name, content, size_bytes, masked)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [adminId, dataset, JSON.stringify(filters || {}), rows ?? null, fileName || `gaadipe-${dataset}.csv`, buf, buf.length, masked]);
  return String(r.id);
}

const cell = (v) => {
  if (v == null) return '';
  let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function auditCsv({ from, to }) {
  const { rows } = await db.query(
    `SELECT a.id, a.created_at, u.name AS admin, a.action, a.ip, a.detail FROM admin_audit a LEFT JOIN admin_users u ON u.id = a.admin_id
      WHERE ($1::timestamptz IS NULL OR a.created_at >= $1) AND ($2::timestamptz IS NULL OR a.created_at < $2) ORDER BY a.id DESC LIMIT 50000`, [from || null, to || null]);
  const head = ['ID', 'When (UTC)', 'Admin', 'Action', 'IP', 'Detail'];
  return { csv: [head.join(','), ...rows.map((r) => [r.id, r.created_at, r.admin, r.action, r.ip, r.detail].map(cell).join(','))].join('\r\n'), rows: rows.length };
}

/** Build one export's CSV (same code as the screens' own downloads). */
async function build(dataset, filters, { admin, mask }) {
  const command = require('./command');
  const r = command.resolve({ range: filters.range || '30d', from: filters.from, to: filters.to, compare: 'none' });
  switch (dataset) {
    case 'vehicles': {
      const out = await require('./vehicles').exportCsv(filters, admin);
      return { csv: out.csv, rows: out.rows, masked: true };
    }
    case 'revenue': {
      const out = await require('./profitability').exportCsv(filters, { mask });
      return { csv: out.csv, rows: out.rows, masked: mask };
    }
    case 'audit': return { ...(await auditCsv({ from: r.from, to: r.to })), masked: false };
    case 'api_logs': case 'customers': case 'payments': case 'whatsapp': case 'searches': {
      const kind = dataset === 'api_logs' ? 'api' : dataset;
      // journey.exportCsv takes IST calendar days.
      const istDay = (t) => new Date(new Date(t).getTime() + 330 * 60000).toISOString().slice(0, 10);
      const out = await require('./journey').exportCsv(kind, { from: istDay(r.from), to: istDay(new Date(r.to).getTime() - 1), mask });
      return { csv: out.csv, rows: out.rows, masked: mask };
    }
    default: return null;
  }
}

async function create({ dataset, filters = {}, admin, can }) {
  const d = DATASETS[dataset];
  if (!d) return { ok: false, status: 400, message: 'No such dataset.' };
  if (!can(d[1])) return { ok: false, status: 403, message: 'Your account may not export this.' };
  const mask = !can('customers.view_sensitive');
  const out = await build(dataset, filters, { admin, mask });
  if (!out) return { ok: false, status: 400, message: 'Could not build that export.' };
  const stamp = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const id = await record({ adminId: admin.id, dataset, filters, csv: out.csv, rows: out.rows, masked: out.masked, fileName: `gaadipe-${dataset}-${stamp}.csv` });
  return { ok: true, id, rows: out.rows };
}

async function list(q = {}) {
  await db.query(`UPDATE export_jobs SET status = 'expired', content = NULL WHERE status = 'ready' AND expires_at < now()`);
  const limit = Math.min(200, Number(q.limit) || 50); const offset = Math.max(0, Number(q.offset) || 0);
  const { rows } = await db.query(
    `SELECT e.id, e.dataset, e.filters, e.records, e.status, e.file_name, e.size_bytes, e.masked, e.created_at, e.expires_at, e.downloads,
            a.name AS admin, count(*) OVER () AS total_rows
       FROM export_jobs e LEFT JOIN admin_users a ON a.id = e.admin_id ORDER BY e.id DESC LIMIT ${limit} OFFSET ${offset}`);
  return {
    total: rows[0] ? Number(rows[0].total_rows) : 0,
    datasets: Object.entries(DATASETS).map(([k, [label, cap]]) => ({ key: k, label, cap })),
    rows: rows.map(({ total_rows, ...x }) => ({ ...x, id: String(x.id), label: DATASETS[x.dataset]?.[0] || x.dataset })),
  };
}

async function file(id) {
  const r = await db.one(`SELECT id, dataset, file_name, content, status, expires_at FROM export_jobs WHERE id = $1`, [Number(id)]);
  if (!r || r.status !== 'ready' || !r.content || new Date(r.expires_at) < new Date()) return null;
  await db.query(`UPDATE export_jobs SET downloads = downloads + 1 WHERE id = $1`, [r.id]);
  return r;
}

module.exports = { record, create, list, file, DATASETS };
