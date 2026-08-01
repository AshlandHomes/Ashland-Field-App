/*
 * split-fixture.js — take the single JSON cell from fixtures-query.sql and
 * write the three fixture files the parity harness reads.
 * Usage: node test/split-fixture.js <path-to-raw-paste>
 * Robust to surrounding whitespace / SQL-editor cell quoting: it extracts the
 * outermost {...} object.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const raw = fs.readFileSync(process.argv[2], 'utf8');
const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
if (a < 0 || b < 0) { console.error('No JSON object found in paste.'); process.exit(1); }
let slice = raw.slice(a, b + 1);
// SQL-editor "Copy as CSV" wraps the json cell in quotes and doubles every
// internal quote ({""template_tasks"":...}). Detect and un-escape that.
if (slice.indexOf('{""') === 0 || slice.indexOf('""') >= 0 && /\{""[a-z_]+""\s*:/.test(slice)) {
  slice = slice.replace(/""/g, '"');
}
let obj = JSON.parse(slice);
// Some editors return the json cell already stringified once more.
if (typeof obj === 'string') obj = JSON.parse(obj);

const dir = path.join(__dirname, 'fixtures');
fs.mkdirSync(dir, { recursive: true });
const tt = obj.template_tasks || [];
const lt = obj.lot_tasks || [];
const lot = obj.lot || null;
fs.writeFileSync(path.join(dir, 'template_tasks.json'), JSON.stringify(tt, null, 2));
fs.writeFileSync(path.join(dir, 'lot_tasks.json'), JSON.stringify(lt, null, 2));
if (lot) fs.writeFileSync(path.join(dir, 'lot.json'), JSON.stringify(lot, null, 2));

console.log('wrote fixtures:');
console.log('  template_tasks.json : ' + tt.length + ' tasks');
console.log('  lot.json            : ' + (lot ? (lot.community + ' / ' + lot.lot_number + '  start=' + lot.construction_start_date) : 'MISSING — lot not matched'));
console.log('  lot_tasks.json      : ' + lt.length + ' tasks');
