#!/usr/bin/env bash
# db-stats.sh — детальна статистика бази даних

cd "$(dirname "$0")/.."

echo "════════════════════════════════════════"
echo "  Job Scraper — Статистика БД"
echo "════════════════════════════════════════"
echo ""

docker exec -i job-scraper node - << 'NODEJS'
const Database = require('better-sqlite3');
const db = new Database('/app/data/jobs.db');
db.pragma('journal_mode = WAL');

const q = sql => db.prepare(sql).get();
const qa = sql => db.prepare(sql).all();

const total      = q('SELECT COUNT(*) as c FROM vacancies').c;
const isNew      = q('SELECT COUNT(*) as c FROM vacancies WHERE is_new=1').c;
const today      = q("SELECT COUNT(*) as c FROM vacancies WHERE date(created_at)=date('now')").c;
const withSalary = q("SELECT COUNT(*) as c FROM vacancies WHERE salary IS NOT NULL AND salary != ''").c;
const viewed     = q('SELECT COUNT(*) as c FROM vacancies WHERE is_viewed=1').c;

console.log('▸ Вакансії:');
console.log(`  ${'Всього:'.padEnd(22)} ${total}`);
console.log(`  ${'Нових:'.padEnd(22)} ${isNew}`);
console.log(`  ${'Додано сьогодні:'.padEnd(22)} ${today}`);
console.log(`  ${'З зарплатою:'.padEnd(22)} ${withSalary}`);
console.log(`  ${'Переглянуто:'.padEnd(22)} ${viewed}`);
console.log('');

console.log('▸ По джерелах:');
qa('SELECT source, COUNT(*) as cnt FROM vacancies GROUP BY source ORDER BY cnt DESC')
  .forEach(r => console.log(`  ${r.source.padEnd(15)} ${r.cnt}`));
console.log('');

console.log('▸ Нові вакансії (останні 7 днів):');
qa("SELECT date(created_at) as day, COUNT(*) as cnt FROM vacancies WHERE created_at >= date('now','-7 days') GROUP BY day ORDER BY day DESC")
  .forEach(r => console.log(`  ${r.day.padEnd(12)} ${r.cnt} вакансій`));
console.log('');

console.log('▸ Відгуки (трекер):');
const apps = q('SELECT COUNT(*) as c FROM applications').c;
console.log(`  ${'Всього відгуків:'.padEnd(22)} ${apps}`);
qa('SELECT status, COUNT(*) as cnt FROM applications GROUP BY status ORDER BY cnt DESC')
  .forEach(r => console.log(`  ${(r.status+':').padEnd(22)} ${r.cnt}`));
console.log('');

console.log('▸ Останні запуски парсера:');
qa('SELECT created_at, source, status, count FROM scrape_logs ORDER BY id DESC LIMIT 10')
  .forEach(r => {
    const icon = r.status === 'error' ? '✗' : '✓';
    const ts = r.created_at.slice(0,16);
    console.log(`  ${icon} ${ts.padEnd(17)} ${r.source.padEnd(12)} +${r.count}`);
  });
console.log('');
NODEJS

DB_SIZE=$(docker exec job-scraper du -sh /app/data/jobs.db 2>/dev/null | cut -f1)
echo "▸ Розмір файлу БД: ${DB_SIZE:-?}"
echo ""
echo "════════════════════════════════════════"
