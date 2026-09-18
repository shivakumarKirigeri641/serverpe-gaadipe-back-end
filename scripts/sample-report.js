/**
 * scripts/sample-report.js — the report the website shows before anyone pays.
 *
 *   node scripts/sample-report.js [path/to/sample-report.pdf]
 *
 * WHY IT IS GENERATED RATHER THAN HAND-MADE: it must be the real renderer. A
 * mocked-up "sample" drawn in a design tool goes stale the first time the
 * report changes, and then the thing customers were shown is not the thing they
 * are sold. This runs the same buildVehicleReport() a paying customer's report
 * runs, with invented data.
 *
 * AND IT IS INVENTED, deliberately: no real registration, no real challan
 * numbers, no real policy numbers. The document carries a SAMPLE band on the
 * front and its number is SAMPLE, because it will be downloaded, forwarded and
 * screenshotted away from the page that explains it.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { buildVehicleReport } = require('../src/pdf/vehicleReport');
const db = require('../src/db');

const out = process.argv[2]
  || path.join(__dirname, '..', '..', 'serverpe-gaadipe-front-end', 'public', 'sample-report.pdf');

/* Dates are relative to today, so the sample never reads as out of date: one
   document expired, one expiring soon, the rest comfortably valid. */
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const DATA = {
  vehicle_number: 'KA01SM1234',
  vehicle_number_pretty: 'KA 01 SM 1234',
  fetched_at: new Date().toISOString(),
  source: 'VAHAN/04',
  rc: {
    reg_no: 'KA01SM1234',
    maker: 'SAMPLE MOTORS LIMITED',
    model: 'EXAMPLE 1.2 VXI',
    vehicle_class: 'Motor Car (LMV)',
    vehicle_category: 'NON-TRANSPORT',
    fuel: 'PETROL',
    colour: 'WHITE',
    manufactured: '06/2019',
    norms: 'BHARAT STAGE IV',
    cubic_capacity: 1197,
    seats: 5,
    registered_at: 'BENGALURU CENTRAL RTO, Karnataka',
    reg_date: '2019-07-11',
    reg_upto: day(700),
    status: 'Active',
    owner_serial: 2,
    owner_type: 'Individual',
    financer: 'SAMPLE BANK LIMITED',
    blacklist_status: null,
    noc_details: null,
    insurance_company: 'SAMPLE GENERAL INSURANCE CO. LTD',
    insurance_policy: 'SMP0000123456789',
    insurance_upto: day(38),
    pucc_number: 'SMP0000987654',
    pucc_upto: day(-26),
    tax_upto: day(410),
  },
  challans: {
    pending_count: 3,
    pending_amount_paise: 450000,
    disposed_count: 2,
    disposed_amount_paise: 100000,
    summary: {
      top_offences: [
        { act: '112/183(1)', offence: 'Driving with excessive speed than prescribed', count: 2, amount_paise: 400000 },
        { act: '177', offence: 'Parking in a no-parking area', count: 1, amount_paise: 50000 },
      ],
    },
    pending: [
      { challan_no: 'SAMPLE0000000000001', challan_date: day(-12), amount_paise: 200000,
        offence: 'Driving with excessive speed than prescribed', place: 'Sample Road Junction', sent_to_court: false, status: 'Pending' },
      { challan_no: 'SAMPLE0000000000002', challan_date: day(-54), amount_paise: 200000,
        offence: 'Driving with excessive speed than prescribed', place: 'Example Flyover', sent_to_court: false, status: 'Pending' },
      { challan_no: 'SAMPLE0000000000003', challan_date: day(-97), amount_paise: 50000,
        offence: 'Parking in a no-parking area', place: 'Illustration Street', sent_to_court: false, status: 'Pending' },
    ],
    disposed: [
      { challan_no: 'SAMPLE0000000000004', challan_date: day(-180), amount_paise: 50000,
        offence: 'Seat belt not worn', place: 'Sample Road Junction', status: 'Disposed' },
      { challan_no: 'SAMPLE0000000000005', challan_date: day(-260), amount_paise: 50000,
        offence: 'Parking in a no-parking area', place: 'Example Flyover', status: 'Disposed' },
    ],
  },
  fastag: {
    tags: [{ status: 'ACTIVE', issue_date: '2021-02-18', vehicle_class: 'VC4', commercial: false, balance: 420 }],
  },
};

(async () => {
  try {
    // The real business block, so the sample carries the correct GSTIN and
    // address — those are the parts a cautious buyer actually checks.
    const business = await db.one(
      `SELECT * FROM business_details WHERE is_active ORDER BY id DESC LIMIT 1`).catch(() => null) || {};

    const pdf = await buildVehicleReport({
      report: {
        report_number: 'SAMPLE',
        reg_no: DATA.vehicle_number,
        created_at: new Date(),
        sample: true,
      },
      business,
      data: DATA,
      requester: { name: 'Sample', mobile: '00000 00000', channel: 'web', device: '—', ip: '—' },
    });

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, pdf);
    console.log(`\n  sample report written to ${out} (${(pdf.length / 1024).toFixed(0)} KB)\n`);
    process.exit(0);
  } catch (e) {
    console.error('\n  failed:', e.message, '\n');
    process.exit(1);
  }
})();
