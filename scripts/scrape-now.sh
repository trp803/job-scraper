#!/usr/bin/env bash
# scrape-now.sh — запустити парсер прямо зараз (без перезапуску контейнера)

cd "$(dirname "$0")/.."

echo "🔍 Запускаємо парсер..."
RESULT=$(curl -s -X POST http://localhost/scrape)
echo "$RESULT"

if echo "$RESULT" | grep -q '"ok":true'; then
  echo ""
  echo "✓ Парсер запущено. Логи:"
  docker compose logs -f --tail=5 job-scraper &
  LOGS_PID=$!
  sleep 3
  # Чекаємо поки парсер завершиться (максимум 5 хвилин)
  for i in $(seq 1 60); do
    RUNNING=$(curl -s http://localhost/api/status | python3 -c "import json,sys; print(json.load(sys.stdin).get('running',''))" 2>/dev/null)
    if [ "$RUNNING" = "False" ] || [ "$RUNNING" = "false" ]; then
      break
    fi
    sleep 5
  done
  kill $LOGS_PID 2>/dev/null
  echo ""
  echo "✓ Готово. Результат:"
  curl -s http://localhost/api/status | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'  Всього вакансій: {d.get(\"total\",\"?\")}')
print(f'  Нових: {d.get(\"new\",\"?\")}')
" 2>/dev/null
fi
