#!/usr/bin/env bash
# status.sh — стан сайту: контейнери, статистика, здоров'я

cd "$(dirname "$0")/.."

echo "════════════════════════════════════════"
echo "  Job Scraper — Статус"
echo "════════════════════════════════════════"
echo ""

# Контейнери
echo "▸ Контейнери:"
docker compose ps --format "  {{.Name}}  {{.Status}}  {{.Ports}}" 2>/dev/null || docker compose ps
echo ""

# HTTP перевірка
echo "▸ HTTP перевірка:"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost/ 2>/dev/null)
if [ "$HTTP" = "200" ]; then
  echo "  ✓ Сайт відповідає (HTTP $HTTP)"
else
  echo "  ✗ Проблема! HTTP $HTTP"
fi

SSE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost/health 2>/dev/null)
echo "  ✓ Nginx health: HTTP $SSE"
echo ""

# Статистика з API
echo "▸ Статистика вакансій:"
STATS=$(curl -s --max-time 5 http://localhost/api/status 2>/dev/null)
if [ -n "$STATS" ]; then
  echo "$STATS" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'  Всього:   {d.get(\"total\",\"?\")}')
print(f'  Нових:    {d.get(\"new\",\"?\")}')
print(f'  Сьогодні: {d.get(\"today\",\"?\")}')
print(f'  Парсер:   {\"🔄 Запущено\" if d.get(\"running\") else \"✓ Очікує\"}')
last = d.get('lastRun')
last_str = last.get('created_at','—')[:19] if isinstance(last,dict) else (last[:19] if last else '—')
print(f'  Останній запуск: {last_str}')
" 2>/dev/null || echo "  $STATS"
fi
echo ""

# Розмір бази
echo "▸ База даних:"
DB_SIZE=$(docker exec job-scraper du -sh /app/data/jobs.db 2>/dev/null | cut -f1)
echo "  Розмір: ${DB_SIZE:-?}"
echo ""

# Аптайм
echo "▸ Аптайм контейнерів:"
docker ps --filter name=job-scraper --format "  {{.Names}}: запущено {{.RunningFor}}" 2>/dev/null
echo ""
echo "════════════════════════════════════════"
