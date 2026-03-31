#!/usr/bin/env bash
# clean-db.sh — очистка бази від нерелевантних вакансій
# Використання:
#   ./clean-db.sh        — видалити не-DevOps вакансії
#   ./clean-db.sh --old  — також видалити вакансії старші 90 днів

cd "$(dirname "$0")/.."

echo "🧹 Очищення бази..."

DELETED=$(docker exec job-scraper node -e "
const { isDevOpsTitle } = require('./src/scrapers/utils');
const Database = require('better-sqlite3');
const db = new Database('./data/jobs.db');
const all = db.prepare('SELECT id, title FROM vacancies').all();
const bad = all.filter(v => !isDevOpsTitle(v.title));
const del = db.prepare('DELETE FROM vacancies WHERE id = ?');
const tx = db.transaction(ids => { for (const {id} of ids) del.run(id); });
tx(bad);
console.log(bad.length);
" 2>/dev/null)

echo "  Видалено нерелевантних: ${DELETED:-0}"

if [ "$1" = "--old" ]; then
  OLD=$(docker exec job-scraper node -e "
const Database = require('better-sqlite3');
const db = new Database('./data/jobs.db');
const r = db.prepare(\"DELETE FROM vacancies WHERE created_at < datetime('now', '-90 days')\").run();
console.log(r.changes);
" 2>/dev/null)
  echo "  Видалено старих (90+ днів): ${OLD:-0}"
fi

TOTAL=$(docker exec job-scraper node -e "
const Database = require('better-sqlite3');
const db = new Database('./data/jobs.db');
console.log(db.prepare('SELECT COUNT(*) as c FROM vacancies').get().c);
" 2>/dev/null)

echo "  Залишилось вакансій: ${TOTAL:-?}"
echo "✓ Готово"
