// scheduler.js — автоматический запуск парсера по расписанию
// node-cron: синтаксис как у unix cron, но в Node.js процессе

const cron = require('node-cron');
const { runAll } = require('./scrapers/index');

// Імпортуємо SSE-сповіщувачі (підключаємо після ініціалізації сервера)
let notifyStart, notifyDone;
try {
  const srv = require('./server');
  notifyStart = srv.notifyScraperStart;
  notifyDone  = srv.notifyScraperDone;
} catch {
  notifyStart = () => {};
  notifyDone  = () => {};
}

// Запускать каждые 3 часа
// '0 */3 * * *' = в 0 минут каждые 3 часа: 0:00, 3:00, 6:00...
const SCHEDULE = process.env.SCRAPE_SCHEDULE || '0 */3 * * *';

console.log(`[scheduler] Розклад: ${SCHEDULE}`);
console.log(`[scheduler] Перший запуск при старті...`);

// Запускаем сразу при старте сервера
notifyStart();
runAll()
  .then(n  => notifyDone(n))
  .catch(err => { console.error('[scheduler] Помилка першого запуску:', err); notifyDone(0); });

// Затем по расписанию
const task = cron.schedule(SCHEDULE, () => {
  console.log(`[scheduler] Плановий запуск: ${new Date().toLocaleString('uk-UA')}`);
  notifyStart();
  runAll()
    .then(n  => notifyDone(n))
    .catch(err => { console.error('[scheduler] Помилка планового запуску:', err); notifyDone(0); });
});

task.start();
console.log(`[scheduler] Заплановано. Наступний запуск — через ~3 годин`);

module.exports = task;
