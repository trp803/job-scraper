// db.js — база данных SQLite
// better-sqlite3 — синхронный драйвер, проще чем async/await
// SQLite — файловая БД, не нужен отдельный сервер

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Папка для файла БД
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'jobs.db'));

// WAL режим — ускоряет запись, безопаснее при конкурентных читателях
db.pragma('journal_mode = WAL');

// Создаём таблицы если не существуют
db.exec(`
  CREATE TABLE IF NOT EXISTS vacancies (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source      TEXT    NOT NULL,          -- 'work.ua', 'dou.ua', ...
    title       TEXT    NOT NULL,          -- название вакансии
    company     TEXT,                      -- название компании
    location    TEXT    DEFAULT 'Київ',    -- город
    salary      TEXT,                      -- зарплата (если указана)
    url         TEXT    NOT NULL,          -- ссылка на вакансию
    description TEXT,                      -- краткое описание
    published_at TEXT,                     -- дата публикации на сайте
    created_at  TEXT    DEFAULT (datetime('now')),  -- когда мы нашли
    is_new      INTEGER DEFAULT 1,         -- 1 = новая (добавлена сегодня)
    is_viewed   INTEGER DEFAULT 0,         -- 1 = пользователь открыл
    UNIQUE(source, url)                    -- один URL не дублируется
  );

  -- Лог запусков парсера: когда, откуда, сколько нашли, ошибки
  CREATE TABLE IF NOT EXISTS scrape_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source     TEXT NOT NULL,
    status     TEXT NOT NULL,   -- 'ok' | 'error'
    count      INTEGER DEFAULT 0,
    error      TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Вакансии ───────────────────────────────────────────

// Вставить вакансию (игнорируем дубликаты по UNIQUE constraint)
const insertVacancy = db.prepare(`
  INSERT OR IGNORE INTO vacancies (source, title, company, location, salary, url, description, published_at)
  VALUES (@source, @title, @company, @location, @salary, @url, @description, @published_at)
`);

// Получить все вакансии с фильтрами
function getVacancies({ source, onlyNew, search, limit = 100, offset = 0 } = {}) {
  let where = [];
  let params = {};

  if (source && source !== 'all') {
    where.push('source = @source');
    params.source = source;
  }
  if (onlyNew) {
    where.push('is_new = 1');
  }
  if (search) {
    where.push('(title LIKE @search OR company LIKE @search)');
    params.search = `%${search}%`;
  }

  const condition = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return db.prepare(`
    SELECT * FROM vacancies
    ${condition}
    ORDER BY created_at DESC, id DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset });
}

// Количество вакансий (для пагинации)
function countVacancies({ source, onlyNew, search } = {}) {
  let where = [];
  let params = {};

  if (source && source !== 'all') {
    where.push('source = @source');
    params.source = source;
  }
  if (onlyNew) {
    where.push('is_new = 1');
  }
  if (search) {
    where.push('(title LIKE @search OR company LIKE @search)');
    params.search = `%${search}%`;
  }

  const condition = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`SELECT COUNT(*) as cnt FROM vacancies ${condition}`).get(params).cnt;
}

// Пометить вакансию как просмотренную
const markViewed = db.prepare(`UPDATE vacancies SET is_viewed = 1, is_new = 0 WHERE id = ?`);

// Пометить все как "не новые" (сбрасываем флаг is_new у старых)
const resetNewFlags = db.prepare(`
  UPDATE vacancies SET is_new = 0
  WHERE is_new = 1 AND created_at < datetime('now', '-1 day')
`);

// Статистика по источникам
function getStats() {
  return {
    total:   db.prepare(`SELECT COUNT(*) as cnt FROM vacancies`).get().cnt,
    new:     db.prepare(`SELECT COUNT(*) as cnt FROM vacancies WHERE is_new = 1`).get().cnt,
    today:   db.prepare(`SELECT COUNT(*) as cnt FROM vacancies WHERE date(created_at) = date('now')`).get().cnt,
    sources: db.prepare(`SELECT source, COUNT(*) as cnt FROM vacancies GROUP BY source ORDER BY cnt DESC`).all(),
    lastRun: db.prepare(`SELECT * FROM scrape_logs ORDER BY id DESC LIMIT 1`).get(),
  };
}

// ─── Логи парсера ──────────────────────────────────────

const logScrape = db.prepare(`
  INSERT INTO scrape_logs (source, status, count, error)
  VALUES (@source, @status, @count, @error)
`);

function getRecentLogs() {
  return db.prepare(`SELECT * FROM scrape_logs ORDER BY id DESC LIMIT 20`).all();
}

module.exports = {
  insertVacancy,
  getVacancies,
  countVacancies,
  markViewed,
  resetNewFlags,
  getStats,
  logScrape,
  getRecentLogs,
};
