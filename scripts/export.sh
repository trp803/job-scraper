#!/usr/bin/env bash
# export.sh — вивантаження вакансій в CSV з терміналу
# Використання:
#   ./scripts/export.sh                     — всі вакансії
#   ./scripts/export.sh --new               — тільки нові
#   ./scripts/export.sh --source djinni.co  — по джерелу
#   ./scripts/export.sh --salary            — тільки з зарплатою
#   ./scripts/export.sh --days 7            — додані за останні N днів
#   ./scripts/export.sh --out myfile.csv    — свій файл

cd "$(dirname "$0")/.."

ONLY_NEW=0
ONLY_SALARY=0
SOURCE=""
DAYS=""
OUTPUT_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --new)     ONLY_NEW=1 ;;
    --salary)  ONLY_SALARY=1 ;;
    --source)  SOURCE="$2"; shift ;;
    --days)    DAYS="$2"; shift ;;
    --out)     OUTPUT_FILE="$2"; shift ;;
    *) echo "Невідомий аргумент: $1"; exit 1 ;;
  esac
  shift
done

if [ -z "$OUTPUT_FILE" ]; then
  DATE=$(date +"%Y-%m-%d_%H-%M")
  OUTPUT_FILE="./backups/export_${DATE}.csv"
fi
mkdir -p "$(dirname "$OUTPUT_FILE")"

echo "════════════════════════════════════════"
echo "  Job Scraper — Експорт CSV"
echo "════════════════════════════════════════"
echo ""

# Передаємо параметри через змінні середовища в контейнер
docker exec -i \
  -e ONLY_NEW="$ONLY_NEW" \
  -e ONLY_SALARY="$ONLY_SALARY" \
  -e FILTER_SOURCE="$SOURCE" \
  -e FILTER_DAYS="$DAYS" \
  job-scraper node - << 'NODEJS' > "$OUTPUT_FILE"
const Database = require('better-sqlite3');
const db = new Database('/app/data/jobs.db');
db.pragma('journal_mode = WAL');

const conditions = [];
const params = {};

if (process.env.ONLY_NEW === '1')    conditions.push('is_new = 1');
if (process.env.ONLY_SALARY === '1') conditions.push("salary IS NOT NULL AND salary != ''");
if (process.env.FILTER_SOURCE)       { conditions.push('source = @source'); params.source = process.env.FILTER_SOURCE; }
if (process.env.FILTER_DAYS)         conditions.push(`created_at >= date('now', '-${process.env.FILTER_DAYS} days')`);

const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
const rows = db.prepare(`
  SELECT id, source, title, company, location, salary, url, published_at, created_at
  FROM vacancies ${where} ORDER BY created_at DESC, id DESC
`).all(params);

const escape = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
const cols = ['id','source','title','company','location','salary','url','published_at','created_at'];
const lines = [cols.join(','), ...rows.map(r => cols.map(c => escape(r[c])).join(','))];
process.stdout.write('\uFEFF' + lines.join('\n') + '\n');
NODEJS

COUNT=$(tail -n +2 "$OUTPUT_FILE" | grep -c . 2>/dev/null || echo 0)
SIZE=$(du -sh "$OUTPUT_FILE" | cut -f1)

echo "✓ Експортовано: $COUNT вакансій"
echo "  Файл: $OUTPUT_FILE ($SIZE)"
echo ""
echo "▸ Перші рядки:"
head -4 "$OUTPUT_FILE" | while IFS= read -r line; do
  echo "  ${line:0:80}"
done
echo ""
echo "════════════════════════════════════════"
