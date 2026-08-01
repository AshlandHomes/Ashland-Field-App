# Working on the Ashland Field App

**READ `CLAUDE_CODE_BUILD_SPEC.md` IN FULL before doing anything.** Restate the prime goal in your own words and wait for my approval on your plan before implementing.

## Prime goal
Extract the schedule engine into ONE shared module (`schedule-engine.js`) that the field app, admin, and backend all call. This is a disciplined RESTRUCTURE of one piece — NOT a rewrite of the app. The stage logic, gate logic, template builder, icons, warnings, and admin tabs stay as they are and keep working. Behavior parity against real data is the acceptance test.

## Hard rules
- This app is LIVE with real builders. Work ONLY on the `Dev` branch. Never touch `main` until I explicitly say so.
- Test against the DEV environment (`ashland-field-ops-dev.netlify.app`) — the duplicate admin + field app on the `dev_` tables. Real builders never see your work until parity passes and I approve a live cutover.
- ONE shared schedule engine. No hand-copied engine logic in multiple files — that duplication (a shadowed `wdBetween`, drifting copies) is the exact bug we're killing.
- Dev/live isolation is by the `TABLE_PREFIX` env var. The literal `dev_` must NEVER appear in code and NEVER in the live site's env. After ANY change to `supabase.js`, run the twofold isolation test in the spec: (1) a dev write lands in `dev_` tables; (2) live tables are untouched.
- Behavior parity against real data is the acceptance test. Prove it before every deploy. Never say "this should work" — run it and show the result.
- ONE change at a time. Verify each before the next. No batched changes.
- Work in the smallest shippable slices. Slice 1 is ONLY extracting the schedule engine. Do not expand scope. If you think something else should change, propose it and wait — do not rebuild the stage logic, gates, or admin while you're "in there."
- Schema changes = `.sql` files committed to the repo, applied to BOTH table prefixes. Never schema-only in the Supabase dashboard.
- Grep for duplicate function names and duplicate switch-cases before adding anything — they silently shadow. This has bitten the project twice.
