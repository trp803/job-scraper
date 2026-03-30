// server.js — Express веб-сервер

const express  = require('express');
const path     = require('path');
const { EventEmitter } = require('events');
const db       = require('./db');
const { enrichAll } = require('./enricher');

const app  = express();
const PORT = process.env.PORT || 3333;

// ─── SSE EventBus ─────────────────────────────────────────────────
// Глобальний емітер — парсер надсилає події сюди,
// SSE-клієнти (браузери) отримують їх через відкриті з'єднання

const scrapeEvents = new EventEmitter();
scrapeEvents.setMaxListeners(100); // багато відкритих вкладок — ок

// Стан парсера (for SSE status)
let scraperState = {
  running:  false,
  lastRun:  null,
  lastNew:  0,
};

// Публічна функція для парсера — викликається після завершення
function notifyScraperDone(newCount) {
  scraperState.running = false;
  scraperState.lastRun = new Date().toISOString();
  scraperState.lastNew = newCount;
  scrapeEvents.emit('done', { newCount, total: db.getStats().total });
}

function notifyScraperStart() {
  scraperState.running = true;
  scrapeEvents.emit('start', {});
}

module.exports.notifyScraperDone  = notifyScraperDone;
module.exports.notifyScraperStart = notifyScraperStart;

// ─── Express налаштування ─────────────────────────────────────────

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── Головна сторінка — список вакансій ──────────────────────────

app.get('/', (req, res) => {
  const {
    source  = 'all',
    search  = '',
    new: onlyNew = '',
    level   = '',
    remote  = '',
    tech    = '',
    page    = '1',
  } = req.query;

  const pageSize    = 30;
  const currentPage = Math.max(1, parseInt(page) || 1);
  const offset      = (currentPage - 1) * pageSize;

  const filter = {
    source:  source || 'all',
    search:  search.trim() || null,
    onlyNew: onlyNew === '1',
    limit:   pageSize,
    offset,
  };

  const raw      = db.getVacancies(filter);
  const total    = db.countVacancies(filter);
  const stats    = db.getStats();

  // Збагачуємо вакансії на поточній сторінці (аналіз тексту)
  let vacancies = enrichAll(raw);

  // Клієнтська фільтрація по рівню, remote, tech (після збагачення)
  if (level)  vacancies = vacancies.filter(v => v.level?.key === level);
  if (remote) vacancies = vacancies.filter(v => v.workFormat?.key === remote || (remote === 'remote' && v.workFormat?.key === 'remote'));
  if (tech)   vacancies = vacancies.filter(v => v.techTags.some(t => t.toLowerCase().includes(tech.toLowerCase())));

  const totalPages = Math.ceil(total / pageSize);

  res.render('index', {
    vacancies,
    stats,
    filter: { source, search, onlyNew, level, remote, tech },
    pagination: { current: currentPage, total: totalPages, count: total },
  });
});

// ─── SSE — Server-Sent Events ────────────────────────────────────
// Браузер підписується на /events і отримує push без polling

app.get('/events', (req, res) => {
  // SSE headers
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // для Nginx proxy

  // Перше повідомлення — поточний стан
  const stats = db.getStats();
  sendSSE(res, 'init', {
    total:   stats.total,
    newCount: stats.new,
    running: scraperState.running,
    lastRun: scraperState.lastRun,
  });

  // Heartbeat кожні 25 секунд (щоб з'єднання не закривалось)
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  // Слухаємо події від парсера
  const onStart = () => sendSSE(res, 'scraper-start', { running: true });
  const onDone  = (data) => {
    const fresh = db.getStats();
    sendSSE(res, 'scraper-done', {
      newCount: data.newCount,
      total:    fresh.total,
      running:  false,
    });
  };

  scrapeEvents.on('start', onStart);
  scrapeEvents.on('done',  onDone);

  // Очищення при закритті з'єднання
  req.on('close', () => {
    clearInterval(heartbeat);
    scrapeEvents.off('start', onStart);
    scrapeEvents.off('done',  onDone);
  });
});

function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─── Помітити вакансію переглянутою ──────────────────────────────

app.post('/viewed/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (id) db.markViewed.run(id);

  if (req.headers['content-type']?.includes('application/json')) {
    return res.json({ ok: true });
  }
  res.redirect(req.headers.referer || '/');
});

// ─── Ручний запуск парсера ────────────────────────────────────────

app.post('/scrape', async (req, res) => {
  if (scraperState.running) {
    return res.json({ ok: false, message: 'Парсер вже запущено' });
  }
  try {
    const { runAll } = require('./scrapers/index');
    notifyScraperStart();
    runAll()
      .then(n => notifyScraperDone(n))
      .catch(err => {
        console.error('[/scrape]', err);
        scraperState.running = false;
        scrapeEvents.emit('done', { newCount: 0 });
      });
    res.json({ ok: true, message: 'Парсер запущено' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── API ──────────────────────────────────────────────────────────

app.get('/api/vacancies', (req, res) => {
  const vacancies = db.getVacancies({
    source:  req.query.source,
    search:  req.query.search,
    onlyNew: req.query.new === '1',
    limit:   Math.min(parseInt(req.query.limit)  || 50, 200),
    offset:  parseInt(req.query.offset) || 0,
  });
  res.json({ ok: true, count: vacancies.length, data: vacancies });
});

// API: статус парсера (для polling якщо SSE не працює)
app.get('/api/status', (req, res) => {
  const stats = db.getStats();
  res.json({ ok: true, ...scraperState, ...stats });
});

// ─── Аналітика ────────────────────────────────────────────────────

app.get('/analytics', (req, res) => {
  const { buildAnalytics } = require('./analytics');
  const data = buildAnalytics();
  res.render('analytics', data);
});

app.get('/api/company/:name', (req, res) => {
  const { getCompanyVacancies } = require('./analytics');
  const vacancies = getCompanyVacancies(req.params.name);
  res.json({ ok: true, count: vacancies.length, data: vacancies });
});

// ─── Логи ─────────────────────────────────────────────────────────

app.get('/logs', (req, res) => {
  const logs = db.getRecentLogs();
  res.render('logs', { logs });
});

// ─── Запуск ───────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nJob Scraper: http://localhost:${PORT}`);
  console.log(`Analytics:   http://localhost:${PORT}/analytics`);
  console.log(`SSE events:  http://localhost:${PORT}/events\n`);
});

require('./scheduler');
