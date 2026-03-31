#!/usr/bin/env bash
# update.sh — оновлення сайту: git pull + rebuild + restart

set -e
cd "$(dirname "$0")/.."

echo "════════════════════════════════════════"
echo "  Job Scraper — Оновлення"
echo "════════════════════════════════════════"
echo ""

# Бекап перед оновленням
echo "▸ Створюємо резервну копію БД..."
./scripts/backup.sh
echo ""

# Git pull
echo "▸ Завантажуємо зміни з GitHub..."
git pull origin master
echo ""

# Rebuild і restart
echo "▸ Перебудовуємо і перезапускаємо контейнери..."
docker compose up -d --build

echo ""
echo "▸ Поточний стан:"
docker compose ps

echo ""
echo "✓ Оновлення завершено!"
