#!/usr/bin/env bash
# rotate-logs.sh — очистка Docker логів і старих записів в БД
# Використання:
#   ./scripts/rotate-logs.sh         — показати розміри, запитати підтвердження
#   ./scripts/rotate-logs.sh --force — очистити без підтвердження

cd "$(dirname "$0")/.."

FORCE=0
[ "$1" = "--force" ] && FORCE=1

echo "════════════════════════════════════════"
echo "  Job Scraper — Ротація логів"
echo "════════════════════════════════════════"
echo ""

# ── Docker логи ──────────────────────────────────────────
echo "▸ Поточні розміри Docker логів:"

for container in job-scraper job-scraper-nginx; do
  LOG_PATH=$(docker inspect --format='{{.LogPath}}' "$container" 2>/dev/null)
  if [ -n "$LOG_PATH" ] && [ -f "$LOG_PATH" ]; then
    SIZE=$(du -sh "$LOG_PATH" 2>/dev/null | cut -f1)
    echo "  $container: $SIZE"
  else
    echo "  $container: не знайдено"
  fi
done
echo ""

# ── Логи парсера в БД ────────────────────────────────────
DB_LOGS=$(docker exec job-scraper sqlite3 /app/data/jobs.db \
  "SELECT COUNT(*) FROM scrape_logs WHERE created_at < date('now','-30 days');" 2>/dev/null)
echo "▸ Записів логів парсера старших 30 днів: ${DB_LOGS:-0}"
echo ""

# Підтвердження
if [ "$FORCE" != "1" ]; then
  read -rp "Очистити логи? (y/N): " CONFIRM
  [[ ! "$CONFIRM" =~ ^[Yy]$ ]] && echo "Скасовано." && exit 0
fi

# ── Очистка Docker логів ─────────────────────────────────
echo "▸ Очищаємо Docker логи..."
for container in job-scraper job-scraper-nginx; do
  LOG_PATH=$(docker inspect --format='{{.LogPath}}' "$container" 2>/dev/null)
  if [ -n "$LOG_PATH" ] && [ -f "$LOG_PATH" ]; then
    truncate -s 0 "$LOG_PATH" 2>/dev/null && echo "  ✓ $container" || echo "  ✗ $container (потрібен sudo)"
  fi
done
echo ""

# ── Очистка старих логів в БД ────────────────────────────
echo "▸ Видаляємо старі записи логів парсера (>30 днів)..."
DELETED=$(docker exec job-scraper sqlite3 /app/data/jobs.db \
  "DELETE FROM scrape_logs WHERE created_at < date('now','-30 days'); SELECT changes();" 2>/dev/null)
echo "  ✓ Видалено: ${DELETED:-0} записів"
echo ""

# ── Старі бекапи ─────────────────────────────────────────
OLD_BACKUPS=$(find ./backups -name "*.db" -o -name "*.csv" 2>/dev/null | \
  xargs ls -t 2>/dev/null | tail -n +11 | wc -l | tr -d ' ')

if [ "$OLD_BACKUPS" -gt 0 ]; then
  echo "▸ Видаляємо старі бекапи (залишаємо 10 останніх)..."
  ls -t ./backups/*.db ./backups/*.csv 2>/dev/null | tail -n +11 | xargs rm -f
  echo "  ✓ Видалено: $OLD_BACKUPS файлів"
  echo ""
fi

echo "✓ Ротація завершена!"
echo "════════════════════════════════════════"
