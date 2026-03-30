// index.js — запускает все парсеры и сохраняет результаты в БД
// Каждый парсер запускается независимо: если один упал — остальные продолжают

const db = require('../db');
const workua   = require('./workua');
const douua    = require('./douua');
const djinni   = require('./djinni');
const hhapi    = require('./hhapi');
const rabotaua = require('./rabotaua');

// Список всех активных парсеров
const SCRAPERS = [hhapi, douua, djinni, workua, rabotaua];

async function runAll() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Запуск парсерів: ${new Date().toLocaleString('uk-UA')}`);
  console.log('='.repeat(50));

  // Сбрасываем флаг is_new у вакансий старше 1 дня
  db.resetNewFlags.run();

  let totalNew = 0;

  for (const scraper of SCRAPERS) {
    const source = scraper.SOURCE;
    console.log(`\n--- ${source} ---`);

    let vacancies = [];
    let status = 'ok';
    let error = null;

    try {
      vacancies = await scraper.scrape();
    } catch (err) {
      status = 'error';
      error = err.message;
      console.error(`[${source}] ПОМИЛКА: ${err.message}`);
    }

    // Сохраняем в БД (INSERT OR IGNORE — дубликаты пропускаются)
    let newCount = 0;
    for (const vac of vacancies) {
      const result = db.insertVacancy.run(vac);
      if (result.changes > 0) newCount++; // changes > 0 = новая запись добавлена
    }

    totalNew += newCount;

    // Логируем результат
    db.logScrape.run({
      source,
      status,
      count: newCount,
      error,
    });

    console.log(`[${source}] Нових: ${newCount} / Всього знайдено: ${vacancies.length}`);
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Готово! Додано нових вакансій: ${totalNew}`);
  console.log('='.repeat(50) + '\n');

  return totalNew;
}

// Если запущен напрямую (node scrapers/index.js) — выполняем сразу
if (require.main === module) {
  runAll()
    .then(n => { console.log(`Done. New: ${n}`); process.exit(0); })
    .catch(err => { console.error(err); process.exit(1); });
}

module.exports = { runAll };
