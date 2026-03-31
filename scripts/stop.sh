#!/usr/bin/env bash
# stop.sh — зупинка сайту
cd "$(dirname "$0")/.."

echo "■ Зупиняємо job-scraper..."
docker compose down
echo "✓ Зупинено"
