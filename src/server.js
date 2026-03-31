// server.js — Express веб-сервер

const Anthropic      = require('@anthropic-ai/sdk');
const express        = require('express');
const path           = require('path');
const fs             = require('fs');
const os             = require('os');
const { execFile }   = require('child_process');
const session        = require('express-session');
const { EventEmitter } = require('events');
const db             = require('./db');
const { enrichAll, enrichVacancy } = require('./enricher');
const { notifyNewJobs } = require('./telegram');
const { calcScore }  = require('./keywords');

// ─── Конфіг авторизації ───────────────────────────────────────────
const AUTH_USER      = process.env.AUTH_USER      || 'admin';
const AUTH_PASS      = process.env.AUTH_PASS      || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-key';

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

app.use(session({
  secret:            SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge:   7 * 24 * 60 * 60 * 1000, // 7 днів
  },
}));

// ─── Auth middleware ──────────────────────────────────────────────
// Публічні роути: /login, /health, /metrics (для Prometheus)
const PUBLIC_PATHS = ['/login', '/health', '/metrics'];

function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.includes(req.path)) return next();
  if (req.session?.authenticated) return next();
  res.redirect('/login');
}

app.use(requireAuth);

// ─── Auth роути ───────────────────────────────────────────────────

app.get('/login', (req, res) => {
  if (req.session?.authenticated) return res.redirect('/');
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === AUTH_USER && password === AUTH_PASS) {
    req.session.authenticated = true;
    res.redirect('/');
  } else {
    res.render('login', { error: 'Невірний логін або пароль' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ─── Головна сторінка — список вакансій ──────────────────────────

app.get('/', (req, res) => {
  const {
    source  = 'all',
    search  = '',
    new: onlyNew = '',
    level   = '',
    remote  = '',
    tech    = '',
    salary  = '',
    dupes   = '',
    page    = '1',
  } = req.query;

  const pageSize    = 30;
  const currentPage = Math.max(1, parseInt(page) || 1);
  const offset      = (currentPage - 1) * pageSize;
  const noDupes     = dupes === '0';  // dupes=0 → hide duplicates

  const dbFilter = {
    source:    source || 'all',
    search:    search.trim() || null,
    onlyNew:   onlyNew === '1',
    hasSalary: salary === '1',
    noDupes,
  };

  const stats    = db.getStats();
  const baseRes  = db.getBaseResume();
  const baseTex  = baseRes?.latex_code || '';

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

  // Розрахунок resume score для кожної вакансії (якщо є базове резюме)
  if (baseTex) {
    for (const v of vacancies) {
      const text = [v.title, v.company, v.description].filter(Boolean).join(' ');
      v.resumeScore = calcScore(text, baseTex).score;
    }
  }

  const totalPages = Math.ceil(total / pageSize);

  res.render('index', {
    vacancies,
    stats,
    filter: { source, search, onlyNew: onlyNew === '1', level, remote, tech, hasSalary: salary === '1', noDupes },
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

// ─── Сторінка деталей вакансії ────────────────────────────────────

app.get('/vacancy/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(404).send('Not found');
  const vacancy = db.getVacancyById(id);
  if (!vacancy) return res.status(404).send('Вакансія не знайдена');
  db.markViewed.run(id);
  const enriched    = enrichVacancy(vacancy);
  const application = db.getApplicationByVacancy(id);
  const note        = db.getVacancyNote(id);
  const baseRes     = db.getBaseResume();
  const baseTex     = baseRes?.latex_code || '';
  const scoreData   = baseTex
    ? calcScore([vacancy.title, vacancy.company, vacancy.description].filter(Boolean).join(' '), baseTex)
    : null;
  // Витягуємо ім'я з LaTeX шаблону для підстановки в листи
  const nameMatch   = baseTex.match(/\\textbf\{\\Huge\s*\\scshape\s+([^}]+)\}/) ||
                      baseTex.match(/\\name\{([^}]+)\}/);
  const coverName   = nameMatch ? nameMatch[1].trim() : '';
  const coverLetter = db.getCoverLetter(id);
  res.render('vacancy', {
    vacancy: enriched, application: application || null, note, scoreData, coverName,
    coverLetter, hasAI: !!process.env.ANTHROPIC_API_KEY,
  });
});

// ─── Збереження нотатки до вакансії ──────────────────────────────
app.post('/vacancy/:id/note', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ ok: false });
  db.saveVacancyNote(id, req.body.note || '');
  res.json({ ok: true });
});

// ─── Експорт ──────────────────────────────────────────────────────

app.get('/export/csv', (req, res) => {
  const rows = db.getAllVacancies({
    source:    req.query.source,
    search:    req.query.search,
    onlyNew:   req.query.new === '1',
    hasSalary: req.query.salary === '1',
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
    source:    req.query.source,
    search:    req.query.search,
    onlyNew:   req.query.new === '1',
    hasSalary: req.query.salary === '1',
  });
  res.setHeader('Content-Disposition', 'attachment; filename="devops-jobs.json"');
  res.json({ exported_at: new Date().toISOString(), count: rows.length, data: rows });
});

app.get('/export/xlsx', async (req, res) => {
  const ExcelJS = require('exceljs');
  const rows = db.getAllVacancies({
    source:    req.query.source,
    search:    req.query.search,
    onlyNew:   req.query.new === '1',
    hasSalary: req.query.salary === '1',
  });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'DevOps Jobs Scraper';

  const sheet = workbook.addWorksheet('DevOps Jobs');
  sheet.columns = [
    { header: 'ID',           key: 'id',           width: 7  },
    { header: 'Джерело',      key: 'source',        width: 12 },
    { header: 'Посада',       key: 'title',         width: 45 },
    { header: 'Компанія',     key: 'company',       width: 25 },
    { header: 'Зарплата',     key: 'salary',        width: 18 },
    { header: 'Локація',      key: 'location',      width: 15 },
    { header: 'URL',          key: 'url',           width: 55 },
    { header: 'Опубліковано', key: 'published_at',  width: 14 },
    { header: 'Знайдено',     key: 'created_at',    width: 14 },
  ];

  // Стиль заголовку
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
  headerRow.alignment = { vertical: 'middle' };
  headerRow.height = 20;

  rows.forEach(r => sheet.addRow(r));

  // Зебра: непарні рядки злегка підсвічені
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1 && rowNumber % 2 === 0) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4FF' } };
    }
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="devops-jobs.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
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

// ─── Редактор резюме ──────────────────────────────────────────────

app.get('/resume', (req, res) => {
  const resumes  = db.getResumes();
  const base     = db.getBaseResume();
  res.render('resume-list', { resumes, base });
});

// Новий чернетка (опційно прив'язаний до вакансії)
app.get('/resume/new', (req, res) => {
  const vacancyId = parseInt(req.query.vacancy_id) || null;
  const base      = db.getBaseResume();
  let vacancy     = null;
  if (vacancyId) {
    vacancy = db.getVacancyById(vacancyId);
  }
  const defaultName = vacancy
    ? `${vacancy.title}${vacancy.company ? ' @ ' + vacancy.company : ''}`
    : 'Нове резюме';
  res.render('resume-editor', {
    resume: { id: null, name: defaultName, latex_code: base?.latex_code || '', vacancy_id: vacancyId },
    vacancy,
    isBase: false,
  });
});

// Редагування існуючого резюме (або базового шаблону)
app.get('/resume/edit/:id', (req, res) => {
  const id     = parseInt(req.params.id);
  const resume = db.getResumeById(id);
  if (!resume) return res.status(404).send('Резюме не знайдено');
  let vacancy = null;
  if (resume.vacancy_id) vacancy = db.getVacancyById(resume.vacancy_id);
  res.render('resume-editor', { resume, vacancy, isBase: resume.is_base === 1 });
});

// Збереження (AJAX JSON)
app.post('/resume/save', (req, res) => {
  const { id, vacancy_id, name, latex_code } = req.body;
  if (!latex_code) return res.status(400).json({ ok: false, error: 'latex_code required' });
  const savedId = db.upsertResume({
    id:         id ? parseInt(id) : null,
    vacancy_id: vacancy_id ? parseInt(vacancy_id) : null,
    name:       name || 'Без назви',
    latex_code,
  });
  res.json({ ok: true, id: savedId });
});

// Збереження базового шаблону
app.post('/resume/save-base', (req, res) => {
  const { latex_code } = req.body;
  if (!latex_code) return res.status(400).json({ ok: false, error: 'latex_code required' });
  const base = db.getBaseResume();
  db.upsertResume({ id: base.id, name: base.name, latex_code, is_base: 1 });
  res.json({ ok: true });
});

// Видалення
app.post('/resume/delete/:id', (req, res) => {
  db.deleteResume(parseInt(req.params.id));
  if (req.headers['content-type']?.includes('application/json')) {
    return res.json({ ok: true });
  }
  res.redirect('/resume');
});

// Компіляція LaTeX → PDF через pdflatex
app.post('/resume/compile', (req, res) => {
  const { latex_code, name } = req.body;
  if (!latex_code) return res.status(400).json({ ok: false, error: 'latex_code required' });

  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
  const texFile = path.join(tmpDir, 'resume.tex');
  const pdfFile = path.join(tmpDir, 'resume.pdf');

  // Якщо старий шаблон без inputenc — автоматично додаємо Cyrillic-сумісні пакети
  let code = latex_code;
  // Видаляємо зламаний babel з Ukrainian (не встановлено в TeX Live)
  code = code.replace(/\\usepackage\[(?:english,\s*)?ukrainian(?:,\s*english)?\]\{babel\}\n?/g, '');
  if (!code.includes('inputenc') && code.includes('\\documentclass')) {
    code = code.replace(/(\\documentclass[^\n]+\n)/, '$1\\usepackage[utf8]{inputenc}\n\\usepackage[T2A]{fontenc}\n');
  }

  fs.writeFileSync(texFile, code, 'utf8');

  // pdflatex двічі — щоб коректно побудувати TOC/посилання якщо є
  const args = ['-interaction=nonstopmode', '-output-directory', tmpDir, texFile];
  execFile('pdflatex', args, { timeout: 30000 }, (err, stdout) => {
    if (err && !fs.existsSync(pdfFile)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return res.status(500).json({ ok: false, error: stdout.slice(-1000) });
    }
    // другий прохід (тихо, ігноруємо помилки)
    execFile('pdflatex', args, { timeout: 30000 }, () => {
      if (!fs.existsSync(pdfFile)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return res.status(500).json({ ok: false, error: 'PDF не згенерований' });
      }
      const pdf      = fs.readFileSync(pdfFile);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      // RFC 5987: filename* дозволяє UTF-8 символи (кирилиця тощо)
      const displayName = (name || 'resume').trim() || 'resume';
      const encoded     = encodeURIComponent(displayName + '.pdf');
      res.setHeader('Content-Type', 'application/pdf');
      const isInline = req.query.inline === '1';
      res.setHeader('Content-Disposition', isInline
        ? 'inline; filename="preview.pdf"'
        : `attachment; filename="resume.pdf"; filename*=UTF-8''${encoded}`);
      res.send(pdf);
    });
  });
});

// ─── AI аналіз вакансії через Claude ─────────────────────────────

app.post('/ai/analyze', requireAuth, async (req, res) => {
  const { vacancy_text } = req.body;
  if (!vacancy_text) return res.status(400).json({ ok: false, error: 'vacancy_text required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY not set' });

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `Проаналізуй цю DevOps вакансію і поверни ТІЛЬКИ валідний JSON (без markdown, без пояснень):
{
  "summary": "2-3 речення: суть позиції та головні вимоги",
  "must_have": ["обов'язкова вимога 1", ...],
  "nice_to_have": ["бажана навичка 1", ...],
  "red_flags": ["потенційна проблема або підозріла деталь", ...],
  "questions": ["Питання для інтерв'ю 1", ...],
  "salary_comment": "коментар про зарплату або null"
}

Правила:
- must_have: 3-6 пунктів, тільки те що явно обов'язкове
- nice_to_have: 2-4 пунктів, явно optional або "буде плюсом"
- red_flags: 0-3 пунктів (відсутня зарплата, завеликий стек, нереальні вимоги тощо)
- questions: рівно 8 технічних питань які ймовірно зададуть на інтерв'ю

ВАКАНСІЯ:
${vacancy_text.slice(0, 4000)}`,
      }],
    });

    const raw     = message.content.find(b => b.type === 'text')?.text || '';
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const data    = JSON.parse(cleaned);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Збереження та отримання супровідного листа ───────────────────

app.post('/cover-letter/save', requireAuth, (req, res) => {
  const { vacancy_id, text } = req.body;
  if (!vacancy_id || !text) return res.status(400).json({ ok: false, error: 'vacancy_id and text required' });
  db.saveCoverLetter(parseInt(vacancy_id), text);
  res.json({ ok: true });
});

app.get('/cover-letter/:vacancyId', requireAuth, (req, res) => {
  const text = db.getCoverLetter(parseInt(req.params.vacancyId));
  res.json({ ok: true, text });
});

// ─── Історія статусів відгуку ─────────────────────────────────────

app.get('/api/tracker/history/:vacancyId', (req, res) => {
  const history = db.getApplicationHistory(parseInt(req.params.vacancyId));
  res.json({ ok: true, history });
});

// ─── Версії резюме ────────────────────────────────────────────────

app.get('/api/resume/versions/:id', (req, res) => {
  const versions = db.getResumeVersions(parseInt(req.params.id));
  res.json({ ok: true, versions });
});

app.get('/api/resume/version/:versionId', (req, res) => {
  const v = db.getResumeVersionCode(parseInt(req.params.versionId));
  if (!v) return res.status(404).json({ ok: false });
  res.json({ ok: true, latex_code: v.latex_code });
});

// ─── Генерація супровідного листа через Claude API ───────────────

app.post('/cover-letter/generate', requireAuth, async (req, res) => {
  const { vacancy_text, resume_latex } = req.body;
  if (!vacancy_text || !resume_latex) {
    return res.status(400).json({ ok: false, error: 'vacancy_text and resume_latex required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY not set in environment' });
  }

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `Ти — DevOps-інженер, який шукає роботу. Напиши супровідний лист українською мовою на основі вакансії та резюме.

Вимоги до листа:
- Мова: українська
- Довжина: 3–4 абзаци, максимум 350 слів
- Тон: професійний, але живий — не шаблонний
- Структура: вітання → чому зацікавила вакансія → ключові навички/досвід що відповідають вимогам → заклик до дії
- Не перелічуй всі технології — вибери 3–5 найбільш релевантних з вакансії
- Не починай з "Я" — починай з фрази типу "Вас може зацікавити..." або "Переглянувши вашу вакансію..."
- Підпис: "З повагою," + ім'я кандидата з резюме (якщо є)

ВАКАНСІЯ:
${vacancy_text.slice(0, 3000)}

РЕЗЮМЕ (LaTeX):
${resume_latex.slice(0, 4000)}

Напиши лише текст листа, без пояснень та коментарів.`
      }]
    });

    const text = message.content.find(b => b.type === 'text')?.text || '';
    res.json({ ok: true, text });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Health check ─────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true }));

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
