// server.js — Express веб-сервер

const express  = require('express');
const path     = require('path');
const { EventEmitter } = require('events');
const db       = require('./db');
const { enrichAll, enrichVacancy } = require('./enricher');
const { notifyNewJobs } = require('./telegram');

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

  // Telegram: відправляємо нові вакансії (не блокуємо основний потік)
  if (newCount > 0) {
    const fresh = db.getVacancies({ onlyNew: true, limit: 10 });
    notifyNewJobs(fresh).catch(err => console.error('[Telegram]', err.message));
  }
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

  const dbFilter = {
    source:  source || 'all',
    search:  search.trim() || null,
    onlyNew: onlyNew === '1',
  };

  const stats = db.getStats();

  // Якщо є фільтри по enrich-полях (level/remote/tech) — збагачуємо всі,
  // потім фільтруємо і пагінуємо в памʼяті. Інакше — звичайна DB пагінація.
  let vacancies, total;

  if (level || remote || tech) {
    const allRaw = db.getAllVacancies(dbFilter);
    let all = enrichAll(allRaw);
    if (level)  all = all.filter(v => v.level?.key === level);
    if (remote) all = all.filter(v => v.workFormat?.key === remote);
    if (tech)   all = all.filter(v => v.techTags.some(t => t.toLowerCase().includes(tech.toLowerCase())));
    total     = all.length;
    vacancies = all.slice(offset, offset + pageSize);
  } else {
    const raw = db.getVacancies({ ...dbFilter, limit: pageSize, offset });
    vacancies = enrichAll(raw);
    total     = db.countVacancies(dbFilter);
  }

  const totalPages = Math.ceil(total / pageSize);

  res.render('index', {
    vacancies,
    stats,
    filter: { source, search, onlyNew: onlyNew === '1', level, remote, tech },
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

// ─── Експорт ──────────────────────────────────────────────────────

app.get('/export/csv', (req, res) => {
  const rows = db.getAllVacancies({
    source:  req.query.source,
    search:  req.query.search,
    onlyNew: req.query.new === '1',
  });

  const cols = ['id', 'source', 'title', 'company', 'location', 'salary', 'url', 'published_at', 'created_at'];
  const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [
    cols.join(','),
    ...rows.map(r => cols.map(c => escape(r[c])).join(',')),
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="devops-jobs.csv"');
  res.send('\uFEFF' + csv); // BOM для коректного відкриття в Excel
});

app.get('/export/json', (req, res) => {
  const rows = db.getAllVacancies({
    source:  req.query.source,
    search:  req.query.search,
    onlyNew: req.query.new === '1',
  });
  res.setHeader('Content-Disposition', 'attachment; filename="devops-jobs.json"');
  res.json({ exported_at: new Date().toISOString(), count: rows.length, data: rows });
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

// ─── Трекер відгуків ──────────────────────────────────────────────

app.get('/tracker', (req, res) => {
  const { status } = req.query;
  const applications = db.getApplications(status ? { status } : {});
  const appStats     = db.getApplicationStats();
  const { enrichVacancy } = require('./enricher');
  const enriched = applications.map(a => ({
    ...a,
    ...enrichVacancy({ title: a.title, description: '', salary: a.salary }),
  }));
  res.render('tracker', { applications: enriched, appStats, filter: { status: status || '' } });
});

app.post('/tracker/apply', (req, res) => {
  const { vacancy_id, status = 'applied', notes = '', next_step = '', next_date = '' } = req.body;
  if (!vacancy_id) return res.status(400).json({ ok: false, error: 'vacancy_id required' });
  db.upsertApplication({
    vacancy_id: parseInt(vacancy_id),
    status,
    notes:      notes      || null,
    next_step:  next_step  || null,
    next_date:  next_date  || null,
  });
  if (req.headers['content-type']?.includes('application/json')) {
    return res.json({ ok: true });
  }
  res.redirect('/tracker');
});

app.post('/tracker/update/:vacancyId', (req, res) => {
  const vacancyId = parseInt(req.params.vacancyId);
  const { status, notes, next_step, next_date } = req.body;
  db.upsertApplication({
    vacancy_id: vacancyId,
    status:     status     || 'applied',
    notes:      notes      || null,
    next_step:  next_step  || null,
    next_date:  next_date  || null,
  });
  res.json({ ok: true });
});

app.post('/tracker/delete/:vacancyId', (req, res) => {
  db.deleteApplication(parseInt(req.params.vacancyId));
  if (req.headers['content-type']?.includes('application/json')) {
    return res.json({ ok: true });
  }
  res.redirect('/tracker');
});

app.get('/api/tracker/check/:vacancyId', (req, res) => {
  const app = db.getApplicationByVacancy(parseInt(req.params.vacancyId));
  res.json({ ok: true, application: app || null });
});

// ─── Prometheus метрики ───────────────────────────────────────────

app.get('/metrics', (req, res) => {
  const stats    = db.getStats();
  const appStats = db.getApplicationStats();

  const appByStatus = { applied: 0, screening: 0, interview: 0, offer: 0, rejected: 0, withdrawn: 0 };
  appStats.forEach(a => { appByStatus[a.status] = a.cnt; });

  const lines = [
    '# HELP job_scraper_vacancies_total Total vacancies in database',
    '# TYPE job_scraper_vacancies_total gauge',
    `job_scraper_vacancies_total ${stats.total}`,
    '',
    '# HELP job_scraper_vacancies_new Vacancies marked as new',
    '# TYPE job_scraper_vacancies_new gauge',
    `job_scraper_vacancies_new ${stats.new}`,
    '',
    '# HELP job_scraper_vacancies_today Vacancies added today',
    '# TYPE job_scraper_vacancies_today gauge',
    `job_scraper_vacancies_today ${stats.today}`,
    '',
    '# HELP job_scraper_vacancies_by_source Vacancies per source',
    '# TYPE job_scraper_vacancies_by_source gauge',
    ...stats.sources.map(s => `job_scraper_vacancies_by_source{source="${s.source}"} ${s.cnt}`),
    '',
    '# HELP job_scraper_scraper_running Is scraper currently running (1=yes)',
    '# TYPE job_scraper_scraper_running gauge',
    `job_scraper_scraper_running ${scraperState.running ? 1 : 0}`,
    '',
    '# HELP job_scraper_applications_total Job applications in tracker',
    '# TYPE job_scraper_applications_total gauge',
    ...Object.entries(appByStatus).map(([s, n]) => `job_scraper_applications_total{status="${s}"} ${n}`),
    '',
  ];

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(lines.join('\n'));
});

// ─── Запуск ───────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nJob Scraper: http://localhost:${PORT}`);
  console.log(`Analytics:   http://localhost:${PORT}/analytics`);
  console.log(`SSE events:  http://localhost:${PORT}/events\n`);
});

require('./scheduler');
