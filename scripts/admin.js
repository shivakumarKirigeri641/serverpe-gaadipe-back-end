/**
 * scripts/admin.js — who may open the admin panel.
 *
 *   node scripts/admin.js list
 *   node scripts/admin.js add 9886122415 "Shivakumar" owner
 *   node scripts/admin.js disable 9886122415
 *   node scripts/admin.js enable  9886122415
 *
 * A COMMAND RATHER THAN A SEED ROW: a migration that inserts somebody's mobile
 * number ships that number to every deployment and every developer's laptop.
 * The first admin is added deliberately, on the machine that owns the database.
 */

require('dotenv').config();
const db = require('../src/db');
const auth = require('../src/admin/auth');

const [, , command, ...args] = process.argv;

const usage = () => {
  console.log(`
  node scripts/admin.js list
  node scripts/admin.js add <mobile> "<name>" [owner|admin|finance|viewer]
  node scripts/admin.js disable <mobile>
  node scripts/admin.js enable  <mobile>
`);
};

(async () => {
  try {
    if (command === 'list') {
      const rows = await auth.listAdmins();
      if (!rows.length) {
        console.log('\n  No admins yet. Add one with:  node scripts/admin.js add <mobile> "<name>" owner\n');
      } else {
        console.table(rows.map(r => ({
          mobile: r.mobile, name: r.name, role: r.role,
          active: r.is_active ? 'yes' : 'no',
          last_login: r.last_login_at ? new Date(r.last_login_at).toLocaleString('en-IN') : '—',
        })));
      }
    } else if (command === 'add') {
      const [mobile, name, role = 'admin'] = args;
      if (!mobile || !name) { usage(); process.exit(1); }
      const user = await auth.addAdmin({ mobile, name, role });
      console.log(`\n  ${user.name} (${user.mobile}) can now open the panel as ${user.role}.`);
      console.log(`  Sign in at the panel with that number.\n`);
    } else if (command === 'disable' || command === 'enable') {
      const [mobile] = args;
      const m = auth.localMobile(mobile);
      const row = await db.one(`SELECT id, name FROM admin_users WHERE mobile = $1`, [m]);
      if (!row) { console.error(`\n  No admin with mobile ${m}.\n`); process.exit(1); }
      await auth.setAdminActive(row.id, command === 'enable');
      console.log(`\n  ${row.name} is now ${command === 'enable' ? 'active' : 'disabled'}.\n`);
    } else {
      usage();
    }
    process.exit(0);
  } catch (e) {
    console.error('\n  failed:', e.message, '\n');
    process.exit(1);
  }
})();
