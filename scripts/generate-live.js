#!/usr/bin/env node
/*
 * scripts/generate-live.js — SINGLE SOURCE OF TRUTH enforcement.
 * ---------------------------------------------------------------------------
 * The `-dev` HTML files are the ONLY editable source. The live files
 * (ashland-stage-update.html, admin.html) are GENERATED from them, never
 * hand-edited — that is what keeps live from drifting away from dev again
 * (the exact problem this restructure exists to kill).
 *
 * The only differences between a dev file and its live twin are dev-only
 * markers: the red DEV/UAT banner and the "(DEV)" title suffix. Everything
 * else — every feature, the shared schedule-engine <script> tag — is carried
 * through byte-for-byte.
 *
 * Usage:  node scripts/generate-live.js [outputDir]
 *   outputDir defaults to the repo root (produces the real live files).
 *   Pass a staging dir (e.g. /tmp/live-gen) to generate + verify without
 *   touching tracked files.
 * ---------------------------------------------------------------------------
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : ROOT;
fs.mkdirSync(OUT, { recursive: true });

const MAP = [
  { src: 'ashland-stage-update-dev.html', dst: 'ashland-stage-update.html' },
  { src: 'admin-dev.html',                dst: 'admin.html' },
];

// The DEV/UAT banner: a fixed-position red div carrying this exact phrase,
// followed by the 30px spacer div. Matches both the single-line (field app)
// and multi-line (admin) variants. Nothing else in the app carries this text.
const BANNER_RE = /[ \t]*<div\b[^>]*>\s*⚠ DEVELOPMENT \/ UAT — NOT FOR BUILDER USE ⚠\s*<\/div>\s*<div style="height:30px"><\/div>\n?/;

function generate(src, dst) {
  const inPath = path.join(ROOT, src);
  let html = fs.readFileSync(inPath, 'utf8');
  const before = html.length;

  // 1) strip the DEV banner (+ spacer)
  if (!BANNER_RE.test(html)) throw new Error(`${src}: DEV banner not found — refusing to generate a live file that might still carry it.`);
  html = html.replace(BANNER_RE, '');

  // 2) strip the "(DEV)" title suffix (field app; admin title has none — no-op there)
  html = html.replace(/<title>([^<]*?)\s*\(DEV\)<\/title>/, '<title>$1</title>');

  // 3) hard assertions — never ship a live file with a dev marker
  if (/DEVELOPMENT \/ UAT — NOT FOR BUILDER USE/.test(html)) throw new Error(`${src}: banner text still present after strip`);
  if (/<title>[^<]*\(DEV\)<\/title>/.test(html)) throw new Error(`${src}: "(DEV)" still in title after strip`);
  if (!/schedule-engine\.js/.test(html)) throw new Error(`${src}: shared engine <script> tag missing — would ship a live file with no engine`);

  const outPath = path.join(OUT, dst);
  fs.writeFileSync(outPath, html);
  console.log(`  ${src}  ->  ${dst}   (${before} -> ${html.length} bytes, banner+title stripped, engine tag kept)`);
}

console.log('generate-live: live files are GENERATED from -dev sources (single source of truth)');
console.log('  output dir: ' + OUT);
MAP.forEach(m => generate(m.src, m.dst));
console.log('done.');
