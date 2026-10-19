#!/usr/bin/env bash
# Read-only checks around applying migrations/014_facebook_removal_retention.sql.
#
#   bash scripts/migration-014-check.sh preflight   # before applying: every gate must PASS
#   bash scripts/migration-014-check.sh verify      # after applying
#
# Run from workers/kilcon-gallery-worker. Prints counts and schema names only.
# This script never writes to D1; the apply command is printed, not run.

set -u
MODE="${1:-preflight}"
DB="kilcon-db"
pass=0; fail=0

q() {  # q <sql> → JSON rows on stdout
  npx wrangler d1 execute "$DB" --remote --json --command "$1" 2>/dev/null \
    | python -c "import sys,json; print(json.dumps(json.load(sys.stdin)[0]['results']))"
}
gate() {  # gate <label> <python-bool-expr over r> <json>
  if python -c "import json,sys; r=json.loads(sys.argv[1]); sys.exit(0 if ($2) else 1)" "$3"; then
    printf 'PASS  %s\n' "$1"; pass=$((pass+1))
  else
    printf 'FAIL  %s  -> %s\n' "$1" "$3"; fail=$((fail+1))
  fi
}

COUNTS="SELECT (SELECT COUNT(*) FROM apparel_items) ai,(SELECT COUNT(*) FROM apparel_variants) av, (SELECT COUNT(*) FROM apparel_orders) ao,(SELECT COUNT(*) FROM apparel_order_items) aoi, (SELECT COUNT(*) FROM stripe_events) se,(SELECT COUNT(*) FROM stripe_webhook_audit) swa, (SELECT COUNT(*) FROM facebook_webhook_events) fe,(SELECT COUNT(*) FROM facebook_projects) fpr, (SELECT COUNT(*) FROM facebook_posts) fpo,(SELECT COUNT(*) FROM facebook_photos) fph, (SELECT COUNT(*) FROM facebook_sync_state) fst"

echo "== account"
npx wrangler whoami 2>&1 | grep -q "8481dbc471ac3a4aa14cc26ea366f956" \
  && { echo "PASS  wrangler can access the Kil.con.contact account"; pass=$((pass+1)); } \
  || { echo "FAIL  Kil.con.contact account not accessible"; fail=$((fail+1)); }

cols=$(q "SELECT name FROM pragma_table_info('facebook_photos')")
idx=$(q "SELECT name FROM sqlite_master WHERE name = 'idx_facebook_photos_purge_after'")
last=$(q "SELECT id, name FROM d1_migrations ORDER BY id DESC LIMIT 1")
pending=$(npx wrangler d1 migrations list "$DB" --remote 2>&1 | grep -oE "[0-9A-Za-z_]+\.sql" | python -c "import sys,json; print(json.dumps(sys.stdin.read().split()))")

if [[ "$MODE" == "preflight" ]]; then
  echo "== preflight (read-only)"
  gate "013 is the last applied migration" "r and r[0]['name']=='013_facebook_sync.sql'" "$last"
  gate "014 is the only pending migration" "r==['014_facebook_removal_retention.sql']" "$pending"
  gate "facebook_photos has the 23 columns from 013" "len(r)==23" "$cols"
  gate "hidden_reason / purge_after do not exist yet" "not {'hidden_reason','purge_after'} & {c['name'] for c in r}" "$cols"
  gate "index idx_facebook_photos_purge_after does not exist yet" "r==[]" "$idx"
  base=$(q "$COUNTS")
  gate "baseline row counts captured" "len(r)==1 and len(r[0])==11" "${base:-null}"
  echo "INFO  baseline row counts: $base"
  echo "$base" > migration-014-baseline.json
  echo "INFO  restore point (record it; restoring the whole DB needs separate approval):"
  npx wrangler d1 time-travel info "$DB" 2>&1 | grep -iE "bookmark is" | sed 's/^/      /'
  echo
  echo "pass=$pass fail=$fail"
  [[ $fail -eq 0 ]] && echo "All gates passed. Apply with (approval required):
  npx wrangler d1 migrations apply $DB --remote"
  [[ $fail -eq 0 ]]
elif [[ "$MODE" == "verify" ]]; then
  echo "== verify (read-only)"
  gate "014 recorded in d1_migrations" "r and r[0]['name']=='014_facebook_removal_retention.sql'" "$last"
  gate "no migrations pending" "r==[]" "$pending"
  gate "facebook_photos now has 25 columns incl. hidden_reason, purge_after" "len(r)==25 and {'hidden_reason','purge_after'} <= {c['name'] for c in r}" "$cols"
  gate "index idx_facebook_photos_purge_after exists" "len(r)==1" "$idx"
  now=$(q "$COUNTS")
  if [[ -f migration-014-baseline.json ]]; then
    gate "every table's row count unchanged" "r==json.load(open('migration-014-baseline.json'))" "$now"
  else
    echo "INFO  no baseline file; row counts now: $now"
  fi
  echo
  echo "pass=$pass fail=$fail"
  [[ $fail -eq 0 ]]
else
  echo "usage: $0 preflight|verify"; exit 2
fi
