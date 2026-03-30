// server.js — Express веб-сервер
// Отображает вакансии, принимает фильтры, управляет просмотром

const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3333;

// EJS — шаблонизатор (вместо React/Vue — проще, серверный рендер)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// Статика (CSS)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Парсинг тела запроса
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── Главная страница — список вакансий ───────────────────

app.get('/', (req, res) => {
  const {
    source = 'all',
    search = '',
    new: onlyNew = '',
    page = '1',
  } = req.query;

  const pageSize = 30;
  const currentPage = Math.max(1, parseInt(page) || 1);
  const offset = (currentPage - 1) * pageSize;

  // Фильтры
  const filter = {
    source: source || 'all',
    search: search.trim() || null,
    onlyNew: onlyNew === '1',
    limit: pageSize,
    offset,
  };

  const vacancies = db.getVacancies(filter);
  const total = db.countVacancies(filter);
  const stats = db.getStats();

  const totalPages = Math.ceil(total / pageSize);

  res.render('index', {
    vacancies,
    stats,
    filter: { source, search, onlyNew },
    pagination: { current: currentPage, total: totalPages, count: total },
  });
});

// ─── Пометить вакансию просмотренной (AJAX или форма) ────

app.post('/viewed/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (id) db.markViewed.run(id);

  // AJAX запрос — возвращаем JSON
  if (req.headers['content-type']?.includes('application/json')) {
    return res.json({ ok: true });
  }

  // Обычная форма — редирект назад
  res.redirect(req.headers.referer || '/');
});

// ─── Ручной запуск парсера ────────────────────────────────

app.post('/scrape', async (req, res) => {
  try {
    const { runAll } = require('./scrapers/index');
    // Не ждём завершения — запускаем в фоне
    runAll().catch(err => console.error('[/scrape]', err));
    res.json({ ok: true, message: 'Парсер запущено' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── API: получить вакансии (для будущего использования) ─

app.get('/api/vacancies', (req, res) => {
  const vacancies = db.getVacancies({
    source: req.query.source,
    search: req.query.search,
    onlyNew: req.query.new === '1',
    limit: Math.min(parseInt(req.query.limit) || 50, 200),
    offset: parseInt(req.query.offset) || 0,
  });
  res.json({ ok: true, count: vacancies.length, data: vacancies });
});

// ─── Аналітика — рейтинг компаній ────────────────────────

app.get('/analytics', (req, res) => {
  const { buildAnalytics } = require('./analytics');
  const data = buildAnalytics();
  res.render('analytics', data);
});

// ─── API: вакансії компанії ───────────────────────────────

app.get('/api/company/:name', (req, res) => {
  const { getCompanyVacancies } = require('./analytics');
  const vacancies = getCompanyVacancies(req.params.name);
  res.json({ ok: true, count: vacancies.length, data: vacancies });
});

// ─── Логи парсера ─────────────────────────────────────────

app.get('/logs', (req, res) => {
  const logs = db.getRecentLogs();
  res.render('logs', { logs });
});

// ─── Запуск ───────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nJob Scraper запущено: http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api/vacancies`);
  console.log(`Логи парсера: http://localhost:${PORT}/logs\n`);
});

// Запускаем планировщик (парсит по расписанию)
require('./scheduler');
