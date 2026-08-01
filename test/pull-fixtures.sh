#!/usr/bin/env bash
# Pull REAL dev-Supabase fixtures for the parity harness (BUILD_SPEC §7.3).
# Reads dev_ tables only. Requires (read-only anon key is sufficient — dev_
# tables GRANT ALL to anon per sql/dev_schema.sql):
#   SUPABASE_URL   e.g. https://acodbcpmxridiwlufkez.supabase.co
#   SUPABASE_KEY   anon key (sb_publishable_… or eyJ…)
#   SLAB_TEMPLATE_ID   (default: the Slab template id from the spec)
#   LOT_ID             (optional: a real dev lot to validate against)
# Writes JSON into test/fixtures/. Nothing here is committed (see .gitignore).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)/fixtures"
mkdir -p "$DIR"
: "${SUPABASE_URL:?set SUPABASE_URL}"
: "${SUPABASE_KEY:?set SUPABASE_KEY}"
PREFIX="${TABLE_PREFIX:-dev_}"
SLAB="${SLAB_TEMPLATE_ID:-9fae6f78-d2b5-4d57-9e09-8622d37cd829}"
H_KEY="apikey: ${SUPABASE_KEY}"
H_AUTH="Authorization: Bearer ${SUPABASE_KEY}"
REST="${SUPABASE_URL%/}/rest/v1"

echo "→ ${PREFIX}sched_template_tasks (template ${SLAB})"
curl -sS -H "$H_KEY" -H "$H_AUTH" -H "Range: 0-9999" \
  "${REST}/${PREFIX}sched_template_tasks?template_id=eq.${SLAB}&select=bt_num,name,duration,lag,relative_start,relative_finish,predecessors,force_critical,is_critical,task_type,task_order,phase_order,phase_name,est_start_date,status,actual_start,actual_finish&order=task_order" \
  -o "$DIR/template_tasks.json"
echo "  $(grep -o '"bt_num"' "$DIR/template_tasks.json" | wc -l) tasks"

if [ -n "${LOT_ID:-}" ]; then
  echo "→ ${PREFIX}sched_lots (lot ${LOT_ID})"
  curl -sS -H "$H_KEY" -H "$H_AUTH" \
    "${REST}/${PREFIX}sched_lots?id=eq.${LOT_ID}&select=id,lot_number,status,construction_start_date,template_id" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);process.stdout.write(JSON.stringify(a[0]||null,null,2));})' \
    > "$DIR/lot.json"
  echo "→ ${PREFIX}sched_lot_tasks (lot ${LOT_ID})"
  curl -sS -H "$H_KEY" -H "$H_AUTH" -H "Range: 0-9999" \
    "${REST}/${PREFIX}sched_lot_tasks?lot_id=eq.${LOT_ID}&select=bt_num,name,status,phase_order,phase_name,task_order,is_critical,task_type,trade,est_start_date,actual_start,actual_finish,vendor_confirmed,relative_start,relative_finish,duration,lag,predecessors&order=task_order" \
    -o "$DIR/lot_tasks.json"
  echo "  $(grep -o '"bt_num"' "$DIR/lot_tasks.json" | wc -l) lot tasks"
else
  echo "  (LOT_ID unset — skipping real-lot fixture; TEST 5 will be skipped)"
fi
echo "✓ fixtures written to $DIR"
