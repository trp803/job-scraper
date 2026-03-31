#!/usr/bin/env bash
# backup.sh — резервна копія SQLite бази даних
# Зберігає в scripts/../backups/ з датою в імені файлу
# Автоматично видаляє бекапи старші 7 днів

set -e
cd "$(dirname "$0")/.."

BACKUP_DIR="./backups"
mkdir -p "$BACKUP_DIR"

DATE=$(date +"%Y-%m-%d_%H-%M")
BACKUP_FILE="$BACKUP_DIR/jobs_${DATE}.db"

echo "💾 Створюємо резервну копію..."

# Копіюємо файл з Docker volume через контейнер
docker exec job-scraper sqlite3 /app/data/jobs.db ".backup '/tmp/backup.db'"
docker cp job-scraper:/tmp/backup.db "$BACKUP_FILE"

SIZE=$(du -sh "$BACKUP_FILE" | cut -f1)
echo "✓ Збережено: $BACKUP_FILE ($SIZE)"

# Видаляємо бекапи старші 7 днів
DELETED=$(find "$BACKUP_DIR" -name "jobs_*.db" -mtime +7 -print -delete | wc -l)
[ "$DELETED" -gt 0 ] && echo "🗑  Видалено старих бекапів: $DELETED"

# Показуємо всі наявні бекапи
echo ""
echo "Наявні бекапи:"
ls -lh "$BACKUP_DIR"/jobs_*.db 2>/dev/null || echo "  (немає)"
