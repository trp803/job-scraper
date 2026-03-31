#!/usr/bin/env bash
# logs.sh — перегляд логів
# Використання:
#   ./logs.sh          — логи job-scraper (tail -f)
#   ./logs.sh nginx    — логи nginx
#   ./logs.sh all      — логи всіх контейнерів

cd "$(dirname "$0")/.."

case "${1:-app}" in
  nginx)  docker compose logs -f --tail=100 nginx ;;
  all)    docker compose logs -f --tail=50 ;;
  *)      docker compose logs -f --tail=100 job-scraper ;;
esac
