#!/usr/bin/env bash
# restart.sh — перезапуск без перебудови образу
cd "$(dirname "$0")/.."

echo "↻ Перезапускаємо job-scraper..."
docker compose restart
echo "✓ Перезапущено"
docker compose ps
