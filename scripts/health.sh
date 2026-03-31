#!/usr/bin/env bash
# health.sh — перевірка здоров'я всіх компонентів сайту
# Повертає exit code 0 якщо все OK, 1 якщо є проблеми

cd "$(dirname "$0")/.."

ERRORS=0

check() {
  local name="$1"
  local result="$2"
  local expected="$3"
  if [ "$result" = "$expected" ]; then
    printf "  ✓ %-32s %s\n" "$name" "$result"
  else
    printf "  ✗ %-32s очікувалось '%s', отримали '%s'\n" "$name" "$expected" "$result"
    ERRORS=$((ERRORS + 1))
  fi
}

echo "════════════════════════════════════════"
echo "  Job Scraper — Health Check"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "════════════════════════════════════════"
echo ""

# ── Контейнери ───────────────────────────────────────────
echo "▸ Docker контейнери:"

for container in job-scraper job-scraper-nginx; do
  STATUS=$(docker inspect --format='{{.State.Status}}' "$container" 2>/dev/null || echo "not found")
  HEALTH=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null)
  if [ -n "$HEALTH" ]; then
    check "$container" "$STATUS/$HEALTH" "running/healthy"
  else
    check "$container" "$STATUS" "running"
  fi
done
echo ""

# ── HTTP ендпоінти ───────────────────────────────────────
echo "▸ HTTP ендпоінти:"

CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost/health 2>/dev/null)
check "/health" "$CODE" "200"

CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost/login 2>/dev/null)
check "/login" "$CODE" "200"

CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost/ 2>/dev/null)
check "/ (redirect to login)" "$CODE" "302"

CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost/metrics 2>/dev/null)
check "/metrics" "$CODE" "200"
echo ""

# ── База даних через node ────────────────────────────────
echo "▸ База даних:"

DB_RESULT=$(docker exec job-scraper node -e "
const Database = require('better-sqlite3');
try {
  const db = new Database('/app/data/jobs.db');
  db.pragma('journal_mode = WAL');
  const total = db.prepare('SELECT COUNT(*) as c FROM vacancies').get().c;
  console.log('ok:' + total);
} catch(e) { console.log('error:' + e.message); }
" 2>/dev/null)

DB_STATUS=$(echo "$DB_RESULT" | cut -d: -f1)
DB_COUNT=$(echo "$DB_RESULT" | cut -d: -f2)

check "SQLite доступна" "$DB_STATUS" "ok"

if [ "$DB_STATUS" = "ok" ]; then
  if [ "$DB_COUNT" -gt 0 ] 2>/dev/null; then
    printf "  ✓ %-32s %s вакансій\n" "Вакансії в БД" "$DB_COUNT"
  else
    printf "  ⚠ %-32s %s\n" "Вакансії в БД" "порожньо — запусти парсер"
  fi
fi
echo ""

# ── Парсер ───────────────────────────────────────────────
echo "▸ Парсер:"

SCRAPER_RESULT=$(docker exec job-scraper node -e "
const Database = require('better-sqlite3');
try {
  const db = new Database('/app/data/jobs.db');
  const row = db.prepare('SELECT created_at, status FROM scrape_logs ORDER BY id DESC LIMIT 1').get();
  if (row) console.log(row.created_at + '|' + row.status);
  else console.log('none');
} catch(e) { console.log('error'); }
" 2>/dev/null)

if [ "$SCRAPER_RESULT" = "none" ] || [ "$SCRAPER_RESULT" = "error" ]; then
  printf "  ⚠ %-32s %s\n" "Парсер" "ще не запускався"
else
  LAST_TS=$(echo "$SCRAPER_RESULT" | cut -d'|' -f1)
  LAST_ST=$(echo "$SCRAPER_RESULT" | cut -d'|' -f2)
  printf "  ✓ %-32s %s (%s)\n" "Останній запуск" "${LAST_TS:0:16}" "$LAST_ST"
fi
echo ""

# ── Підсумок ─────────────────────────────────────────────
echo "════════════════════════════════════════"
if [ "$ERRORS" -eq 0 ]; then
  echo "  ✓ Всі перевірки пройдено успішно"
else
  echo "  ✗ Знайдено проблем: $ERRORS"
fi
echo "════════════════════════════════════════"

exit $ERRORS
