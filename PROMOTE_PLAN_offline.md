# Promote plan — Offline subsystem (FULL scope, re-baselined at Dev 203b933)

The most consequential promote yet: it registers a service worker on the LIVE app for
the **first time ever**, changing how the app loads for every builder. Network-first
strategy means it can't trap anyone on stale code, but this is the one to watch.

**Everything in this one promote** (all inside the same 4 files — the file SET never grew):
Layers 1–4 (durable queue, routed writes, offline detect/sync, PWA offline launch),
territory prefetch (whole-subdivision background cache), the push-bar fix (honest
completed/total bar + beforeunload guard), the four silent-loss fixes (delay reason,
note-flag + client-id reconciliation, vendor-confirm, task-edit), utility gates offline,
and the write-path guardrail test. Commits `26e1203 … 203b933` on Dev.

## 0. Verified facts (checked against origin/main, not assumed)
- **`serviceWorker.register` has NEVER appeared anywhere in main's history.** No builder
  has an active service worker today. This is unambiguously the first registration —
  no old SW to conflict with, nothing to migrate.
- Current live `sw.js` is `v3` but **dormant** (present, never registered by any page) —
  effectively dead code that this promote replaces + activates.
- **No backend/function change** (`git diff origin/main..Dev -- netlify/` is empty).
- **No DB migration.** Offline is entirely field-app + client-side; it uses existing
  endpoints (getScheduleLots/…/updateScheduleLotTask/addTaskNote/respondNoteResolution).
- `schedule-engine.js` and `note-resolution.js` are **byte-identical** main↔Dev (no drift;
  already live, not re-promoted).
- `manifest.json` + all icons **already exist on main** (the new html's `<link rel=manifest>`
  resolves; nothing to add).
- `admin.html` differs from `admin-dev.html` by the DEV banner ONLY → admin is already
  current on live, **not part of this promote** (field-app only).

## 1. Exact file set — 4 files, nothing else
| File | Change | Notes |
|---|---|---|
| `offline-queue.js` | **NEW** | durable IndexedDB write queue (L1). dev/live identical. |
| `offline-data.js` | **NEW** | read-through data cache + territory prefetch store (L4/4b). identical. |
| `sw.js` | **CHANGED** | v3 → `ashland-field-ops-v4`, network-first. shared, identical. |
| `ashland-stage-update.html` | **CHANGED** | REGENERATED from `-dev` via generate-live.js: SW registration, offline routing, prefetch, script tags, manifest link. |

NOT in this promote: any `-dev` source, `admin.html`, `schedule-engine.js`,
`note-resolution.js`, `test/`, `sql/`, `*.md`, `generate-live.js`, `CLAUDE.md`.

## 2. Backend / migration
**None.** No `netlify/functions` change, no schema change, no `notify pgrst`. Client-only.
`TABLE_PREFIX` unchanged (live = empty) — offline doesn't touch table routing.

## 3. Phased build + gates (build the branch ONLY after Collin says go)
**Pre-gate:** Collin confirms live Netlify `TABLE_PREFIX` is still empty (standing invariant).

1. `git fetch origin main`
2. `git checkout -B promote-offline origin/main`  ← branch off LIVE
3. Bring the 4 files:
   - `offline-queue.js`, `offline-data.js`, `sw.js` ← copy from Dev (identical, no banner)
   - `ashland-stage-update.html` ← **regenerate** from Dev's `-dev` source. generate-live.js
     is not on main, so run it from a Dev worktree/checkout, output to the promote tree.
4. **Freshness check:** regenerate again from `origin/Dev` and confirm the promoted
   `ashland-stage-update.html` is byte-identical (no hand-edits, no drift).

**Diff gate (must ALL pass before merge):**
- `git diff --stat origin/main` shows **EXACTLY these 4 files** — no more, no less.
- `ashland-stage-update.html`: 0 matches for `DEVELOPMENT / UAT`; no `(DEV)` in `<title>`;
  contains `serviceWorker.register`, `offline-queue.js`, `offline-data.js` script tags.
- `sw.js`: contains `ashland-field-ops-v4` and the network-first fetch handler.
- No `dev_` literal anywhere in the diff.
- `schedule-engine.js` / `note-resolution.js` NOT in the diff.

**Merge + deploy:**
5. `git checkout main && git merge --no-ff promote-offline`
6. `git push origin main` → triggers Netlify live build
7. **Collin confirms Netlify deploy GREEN** (I can't see Netlify).

## 4. Post-deploy verification on LIVE (real device — the risky part)
Live URL (confirm hostname — docs only name the dev site): assume
`https://ashland-field-ops.netlify.app/ashland-stage-update.html`.
1. **Deploy-file check** (bypasses page cache): open `/offline-queue.js` and `/offline-data.js`
   → 200 JS. `/sw.js` → contains `v4` + `NETWORK-FIRST`.
2. **Force-fresh the html** with `?v=live1` → confirm the **sync pill + cache pill appear**
   (on live there's no banner, so the pill is top-right at top:8). Log in; watch the cache
   pill fill the territory → `✓ N lots ready offline`.
3. **Full offline cycle on the phone against LIVE** (DEVICE_TEST_offline.md on the live URL):
   cache online → close/reopen online (warms shell) → airplane mode → cold-start opens +
   PIN + all lots (incl. one never opened).
4. **Exercise EVERY offline write while in airplane mode** (the silent-loss fixes), then
   reconnect and confirm each persisted (pull-to-refresh, values stick):
   - Finish a LATE task → pick a delay reason (both the finish AND the reason must survive).
   - Toggle a utility gate.
   - Add a note, then flag it red.
   - Start/finish a task; vendor-confirm a task; edit a task (duration/est).
   - Watch the pill: `⚠ offline · N queued` climbs, then `⏳ syncing` → `✓ synced` on reconnect.
5. Only after all of that passes on a real phone do we consider it trusted for all builders.

## 5. SW-on-live risk & existing-builder first-load experience
**No old SW exists (proven), so the first activation is clean.** Walkthrough:

- **T=0 deploy:** Netlify serves the new html/sw.js/js. Builders with the app **currently
  open are unaffected** — they're running the old html (no SW code); their session
  continues; nothing reloads; no SW controls them yet.
- **Existing builder's 1st open after deploy:** browser fetches the new html over the
  network (no SW yet), runs it, and registers `sw.js`. SW installs (precache manifest+icons,
  `skipWaiting`) → activates (`clients.claim`, purge non-v4 caches — there are none) →
  now controls the origin. The shell is **not yet cached** (its resources were fetched
  before the SW took control), so this load is a normal online load. Login → territory
  prefetch warms the data cache. **No disruption, no forced reload.**
- **2nd open onward:** navigation is SW-controlled → network-first → fetches fresh html
  and **caches the shell**. Now offline-ready. By the time a builder is at a dead-zone lot
  they've loaded online several times, so the shell + territory are cached.
- **`skipWaiting`/`clients.claim` are safe here:** no old SW to displace; the current page's
  already-loaded resources aren't re-fetched; writes (POST) bypass the SW. Claim just means
  the SW starts controlling future GETs — no visible effect mid-session.
- **Network-first = no stale-code trap** (proven): every online load fetches the freshest
  html; the cache only serves when the network fails. A FUTURE code update is picked up on
  the next online load — offline is the only time a builder sees cached code, which is the
  intended behavior.

## 6. Rollback / kill-switch (because a SW persists)
A registered SW keeps running from the browser even if we delete the file — so removal
isn't "delete sw.js." Two levers, both effective because the browser re-checks `sw.js`
(byte-compare) on each navigation and ~daily:
- **Fix-forward:** push a corrected `sw.js`; builders pick it up on next online load.
- **Kill-switch:** deploy a self-unregistering `sw.js` (calls `registration.unregister()`
  + clears caches on activate). Builders' SW removes itself on next load; app reverts to
  plain network. Keep this snippet ready before promote.
- The network-first strategy means even a misbehaving SW can't hide fresh code from an
  online builder — the html always comes from the network first.

## 7. iOS notes (Collin's builders are on iPhone)
- Safari may evict SW caches after ~7 days unused or under storage pressure → the builder
  simply reloads online once to re-warm. Not a failure.
- First-ever use on a fresh device still needs one online load (can't cache what was never
  loaded). Expected.
