# Real-device offline test — Ashland Field App (Dev)

Run this on your **actual phone** against the Dev site before we promote the offline
feature (esp. the service-worker registration) to live. "Passes in the harness" and
"works in my hand in airplane mode" are different things — this ships to builders.

**Dev field app URL:** https://ashland-field-ops-dev.netlify.app/ashland-stage-update-dev.html

Two small pills in the **top-right corner** are your status lights the whole time:
- **Sync pill (top):** `✓ synced` (green) · `⏳ syncing N` (blue) · `⚠ offline · N queued · synced <time>` (amber) · `⚠ N failed` (red).
- **Cache pill (just below it):** `⏳ Caching N/50 offline` (blue) while your whole territory downloads in the background → `✓ N lots ready offline` (green, then fades) → `⚠ N/M lots cached` (amber) if signal drops before it finishes.

---

## Step 0 — Let the app SAVE ITSELF for offline (do this ONLINE)
The app can only launch offline if it has cached itself at least once. That happens on
the **second** online load, not the first.

1. On wifi/cellular, open the Dev URL above. Log in with your PIN. Wait for the sync pill to show **`✓ synced`**.
2. **Watch the cache pill (second pill) fill by itself:** `⏳ Caching 1/50 offline` climbing up to **`✓ N lots ready offline`**. This is your whole territory downloading in the background — you do NOT need to open each lot anymore. The app stays fully usable while it fills; just leave it a moment until the cache pill goes green. *(If you have signal, this takes ~15–30 seconds for 50 lots.)*
3. Now **fully close the app** (swipe it away — don't just background it) and **reopen it** while STILL online. This second load is when it saves the app shell for offline.
4. *(Optional but recommended — this is how builders will really use it):* tap the browser's Share → **Add to Home Screen**, and run the rest of the test from that home-screen icon.

✅ Expected: it opens normally, PIN works, you see your lots, sync pill `✓ synced`, and the cache pill reached **`✓ N lots ready offline`**.

---

## Step 1 — Offline COLD-START (the core proof)
1. Turn on **Airplane Mode** (this fully cuts wifi + cellular — the real dead-zone test).
2. **Fully close** the app (swipe away) and **reopen** it.

✅ Expected:
- The app **OPENS** (does NOT show a "no internet / can't connect" browser error).
- It goes straight to **your** PIN screen (your name already shown).
- You enter your PIN and it **lets you in** (verified on the phone, no signal needed).
- You see **your lots**.
- **Tap into a lot you NEVER opened online** — its tasks and notes are there. This is the whole point of the territory cache: your entire subdivision is available, not just lots you happened to open.
- Sync pill shows **`⚠ offline · synced <a few min ago>`**.

❌ If instead you get a browser "can't connect" page → the app didn't cache itself.
Turn airplane mode off, redo Step 0 (especially 0.3, the close-and-reopen online), try again.

---

## Step 2 — Do real work OFFLINE (still in Airplane Mode)
1. Open one of your lots.
2. **Start** a task. **Finish** a task. **Add a note** to a task.

✅ Expected:
- Each action **shows as done immediately** (task flips to started/finished, note appears).
- The pill updates to **`⚠ offline · N queued`** — the number climbs as you act (start = 1, finish = 2, note = 3…).
- Nothing errors, nothing hangs, nothing gets lost.

---

## Step 3 — Reconnect and SYNC
1. Turn **Airplane Mode OFF**.
2. Wait a few seconds (it re-checks the connection on its own, up to ~15 seconds — or just tap around / refresh to nudge it).

✅ Expected:
- The pill goes **`⏳ syncing N`** briefly, then **`✓ synced`** (green).
- Queued count returns to 0.

---

## Step 4 — Prove it actually PERSISTED (not just local)
1. Still online, **pull-to-refresh** or reopen the lot.

✅ Expected: the task you started/finished offline is **still** started/finished, and your
note is **still there** — proving the offline actions reached the server, not just the phone.

---

## If something's off — what it means
- **Offline app won't open (browser error page):** it never cached itself → redo Step 0, make sure you do the close-and-reopen **while online** (0.3).
- **Offline PIN won't accept:** the saved login didn't persist (e.g. you'd signed out, or this is a different phone/browser than where you logged in online). Log in once online, then retry.
- **Pill stuck on `⚠ offline` after airplane mode off:** give it ~15s, or refresh. If it won't clear, the connection probe isn't seeing the backend — tell me.
- **Pill shows `⚠ N failed` (red) after reconnect:** an action was rejected by the server (not a network problem — surfaced on purpose, never silently dropped). Tell me what you did and I'll dig in.
- **A lot you didn't open online shows no tasks offline:** expected — only lots opened online are cached. Open it once online first.

Tell me the result of each step (or just "all four clean") and we'll plan the careful live promote.
