#!/usr/bin/env bash
# start.sh — запуск сайту
set -e
cd "$(dirname "$0")/.."

echo "▶ Запускаємо job-scraper..."
docker compose up -d --build
echo "✓ Сайт доступний: http://$(curl -s ifconfig.me 2>/dev/null || echo 'localhost')/"
docker compose ps
