#!/usr/bin/env bash
# Live verification of review-photo privacy + site health (read-only).
#
# Prints status codes only: response bodies are discarded, never printed or
# saved, and no secrets are used unless ADMIN_COOKIE is set (never echoed).
#
# Usage (from repo root, Git Bash):
#   PHOTO_KEY='Reviews/photos/<id>/<file>' \
#   PENDING_ID='r_...'    # optional: a pending or hidden review id
#   ADMIN_COOKIE='admin_auth=...'   # optional: tests admin access
#   bash workers/kilcon-gallery-worker/scripts/verify-review-privacy.sh
#
# PHOTO_KEY / PENDING_ID come from the admin migration inventory
# (POST /api/reviews/admin/migrate {"action":"inventory"}).

set -u
SITE="${SITE:-https://kilcon.work}"
IMG="${IMG:-https://images.kilcon.work}"
R2DEV="${R2DEV:-https://pub-2dbd9bf3a7e440f292cbb98cfc4f0aa8.r2.dev}"
PHOTO_KEY="${PHOTO_KEY:-}"
PENDING_ID="${PENDING_ID:-}"
ADMIN_COOKIE="${ADMIN_COOKIE:-}"

pass=0; fail=0; skip=0

# check <label> <expected-regex> <curl args...>
check() {
  local label="$1" expect="$2"; shift 2
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@" || echo "ERR")
  if [[ "$code" =~ ^($expect)$ ]]; then
    printf 'PASS  %-58s expected %-11s got %s\n' "$label" "$expect" "$code"; pass=$((pass+1))
  else
    printf 'FAIL  %-58s expected %-11s got %s\n' "$label" "$expect" "$code"; fail=$((fail+1))
  fi
}
skip() { printf 'SKIP  %-58s %s\n' "$1" "$2"; skip=$((skip+1)); }

BLOCKED="403|404|401"

echo "== A. Gallery API cannot reach review storage"
check "?project=photos"                         "404" "$SITE/api/gallery-api?project=photos"
check "?project=data"                           "404" "$SITE/api/gallery-api?project=data"
check "?project=reviews/photos"                 "404" "$SITE/api/gallery-api?project=reviews%2Fphotos"
check "?project=Reviews/photos (case)"          "400|404" "$SITE/api/gallery-api?project=Reviews%2Fphotos"
check "?project=../Reviews"                     "400" "$SITE/api/gallery-api?project=..%2FReviews"
check "?project=constructor/x"                  "400|404" "$SITE/api/gallery-api?project=constructor%2Fx"
check "?list=reviews"                           "400" "$SITE/api/gallery-api?list=reviews"
check "?all=1 without admin"                    "401" "$SITE/api/gallery-api?all=1"
# 404 while FB_INTEGRATION_ENABLED="false"; 403 once enabled (wrong verify token)
check "Facebook webhook rejects bad verify token" "403|404" "$SITE/api/gallery-api/facebook/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1"
check "Facebook webhook rejects unsigned POST"  "401|404" -X POST -H 'Content-Type: application/json' -d '{"object":"page","entry":[]}' "$SITE/api/gallery-api/facebook/webhook"
check "Facebook admin API without admin"        "401|404" "$SITE/api/gallery-api/facebook/admin/health"
check "Facebook backfill without admin"         "401|404" -X POST "$SITE/api/gallery-api/facebook/backfill"
check "migration endpoint without admin"        "401" -X POST -H 'Content-Type: application/json' -d '{}' "$SITE/api/reviews/admin/migrate"

echo "== B. Direct and transformed review-file URLs"
if [[ -n "$PHOTO_KEY" ]]; then
  rest="${PHOTO_KEY#Reviews/photos/}"
  check "images: direct"                        "$BLOCKED" -I "$IMG/$PHOTO_KEY"
  check "images: Reviews%2Fphotos"              "$BLOCKED" -I "$IMG/Reviews%2Fphotos/$rest"
  check "images: Reviews/photos%2F..."          "$BLOCKED" -I "$IMG/Reviews/photos%2F$rest"
  check "images: %52eviews"                     "$BLOCKED" -I "$IMG/%52eviews/photos/$rest"
  check "images: Reviews/./photos"              "$BLOCKED" -I "$IMG/Reviews/./photos/$rest"
  check "images: Reviews/x/../photos"           "$BLOCKED" -I "$IMG/Reviews/x/../photos/$rest"
  check "images: transform"                     "$BLOCKED" -I "$IMG/cdn-cgi/image/width=50/$PHOTO_KEY"
  check "images: transform, %2F"                "$BLOCKED" -I "$IMG/cdn-cgi/image/width=50/Reviews%2Fphotos/$rest"
  check "kilcon.work: transform, absolute src"  "$BLOCKED" -I "$SITE/cdn-cgi/image/width=50/$IMG/$PHOTO_KEY"
  check "r2.dev: direct"                        "$BLOCKED" -I "$R2DEV/$PHOTO_KEY"
else
  skip "direct / transform / r2.dev photo checks" "set PHOTO_KEY"
fi
APPROVED_ID=$(curl -s --max-time 20 "$SITE/api/reviews?page=1&pageSize=10" \
  | python -c "import sys,json; r=[x for x in json.load(sys.stdin).get('reviews',[])]; print(r[0]['id'] if r else '')" 2>/dev/null | tr -d '\r')
PHOTO_ID=$(curl -s --max-time 20 "$SITE/api/reviews?page=1&pageSize=50" \
  | python -c "import sys,json; r=[x for x in json.load(sys.stdin).get('reviews',[]) if x.get('photoUrl')]; print(r[0]['id'] if r else '')" 2>/dev/null | tr -d '\r')
if [[ -n "$APPROVED_ID" ]]; then
  check "images: review record JSON"            "$BLOCKED" -I "$IMG/Reviews/data/$APPROVED_ID.json"
  check "r2.dev: review record JSON"            "$BLOCKED" -I "$R2DEV/Reviews/data/$APPROVED_ID.json"
else
  skip "review record JSON checks" "no approved reviews found"
fi

echo "== C. Review photo endpoint"
leak=$(curl -s --max-time 20 "$SITE/api/reviews?page=1&pageSize=50" | grep -c 'images.kilcon.work/Reviews' || true)
if [[ "$leak" == "0" ]]; then printf 'PASS  %-58s\n' "/api/reviews hands out no public bucket URLs"; pass=$((pass+1));
else printf 'FAIL  %-58s\n' "/api/reviews still contains images.kilcon.work/Reviews URLs"; fail=$((fail+1)); fi
if [[ -n "$PHOTO_ID" ]]; then
  check "approved photo via /api/reviews/photo"  "200" "$SITE/api/reviews/photo?id=$PHOTO_ID"
  ct=$(curl -s -o /dev/null -D - --max-time 20 "$SITE/api/reviews/photo?id=$PHOTO_ID" | tr -d '\r' | grep -iE '^(content-type|content-security-policy):' | tr '\n' ' ')
  printf 'INFO  %-58s %s\n' "approved photo headers" "$ct"
else
  skip "approved photo display" "no approved review with a photo"
fi
check "unknown review id"                       "404" "$SITE/api/reviews/photo?id=r_does_not_exist"
check "malformed review id"                     "404" "$SITE/api/reviews/photo?id=..%2Fx"
if [[ -n "$PENDING_ID" ]]; then
  check "pending/hidden photo, public"          "404" "$SITE/api/reviews/photo?id=$PENDING_ID"
  if [[ -n "$ADMIN_COOKIE" ]]; then
    check "pending/hidden photo, admin"         "200" -H "Cookie: $ADMIN_COOKIE" "$SITE/api/reviews/photo?id=$PENDING_ID"
    check "admin review list"                   "200" -H "Cookie: $ADMIN_COOKIE" "$SITE/api/reviews/admin/list"
  else
    skip "admin access checks" "set ADMIN_COOKIE"
  fi
else
  skip "pending/hidden photo checks" "set PENDING_ID"
fi

echo "== D. Website health"
for p in / /projects /services/new-construction /services/remodels /services/furniture /apparel /reviews /contact /privacy /sitemap.xml; do
  check "page $p" "200" "$SITE$p"
done
check "/api/reviews/summary"                    "200" "$SITE/api/reviews/summary"
check "/api/gallery-api?list=projects"          "200" "$SITE/api/gallery-api?list=projects"
check "/api/gallery-api?list=highlights"        "200" "$SITE/api/gallery-api?list=highlights"
read -r PSLUG PFULL PTHUMB < <(curl -s --max-time 20 "$SITE/api/gallery-api?list=projects" \
  | python -c "import sys,json; p=json.load(sys.stdin)['projects'][0]; print(p['slug'], p['previews'][0]['full'], p['previews'][0]['thumb'])" 2>/dev/null | tr -d '\r')
if [[ -n "${PSLUG:-}" ]]; then
  check "project page /projects/<first>"        "200" "$SITE/projects/$PSLUG"
  check "gallery image (public)"                "200" -I "$PFULL"
  check "gallery thumbnail transform"           "200" -I "$PTHUMB"
fi
ASLUG=$(curl -s --max-time 20 "$SITE/api/gallery-api?list=apparel" \
  | python -c "import sys,json; print(json.load(sys.stdin)['apparel'][0]['slug'])" 2>/dev/null | tr -d '\r')
[[ -n "$ASLUG" ]] && check "apparel page /apparel/<first>" "200" "$SITE/apparel/$ASLUG"
[[ -n "$ASLUG" ]] && check "apparel item API"                "200" "$SITE/api/item?slug=$ASLUG"

echo
echo "pass=$pass fail=$fail skip=$skip"
[[ $fail -eq 0 ]]
