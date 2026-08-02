# Deploy & branch model — Ashland Field App

## Single source of truth (READ THIS)

**`Dev` is the source of truth. The live files are GENERATED from it — never hand-edited.**

- **Editable source (edit these):** `ashland-stage-update-dev.html`, `admin-dev.html`,
  plus the shared `schedule-engine.js`, `netlify/functions/supabase.js`, `netlify.toml`.
- **Generated artifacts (DO NOT hand-edit):** `ashland-stage-update.html`, `admin.html`
  are produced from their `-dev` sources by `scripts/generate-live.js`. The only
  differences are dev-only markers (the red DEV/UAT banner and the "(DEV)" title
  suffix); every feature and the shared engine `<script>` tag carry through unchanged.

Regenerate the live files:

```
node scripts/generate-live.js            # writes live files into the repo root
node scripts/generate-live.js /tmp/out   # or into a staging dir to inspect first
```

The generator hard-fails if it can't find the banner to strip, if a dev marker
survives, or if the shared-engine tag is missing — so it can never ship a live
file that still says "DEV" or that has no engine.

**Why:** live and dev previously drifted apart (different engine, different
features) because both were hand-maintained. Generating live from dev makes that
divergence impossible — there is exactly one editable copy of each surface.

## Branches & sites
- `Dev`  → dev Netlify site (`TABLE_PREFIX=dev_`), carries the DEV banner.
- `main` → live Netlify site (`TABLE_PREFIX` **empty**), no banner.
- One shared Supabase project; dev/live isolation is by table-name prefix, set per
  Netlify site as an env var — never in code.

## Shared config
- `netlify.toml`: pins `node_bundler = "esbuild"` and `included_files = ["schedule-engine.js"]`
  (so the function bundles the shared engine), and omits `test/**` from secret scanning.
- Not shipped to live: `test/` (parity/wiring harness) and `sql/dev_schema.sql` (dev schema).

## Promote to live
The cutover sequence (parity on a real live lot, live-data audit, `TABLE_PREFIX`
verification, isolation re-test) is planned separately and run deliberately — see
the promote plan. Do not push to `main` outside that reviewed sequence.
