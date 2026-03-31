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
db.pragma('foreign_keys = ON');

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

  -- Резюме (LaTeX шаблони під конкретні вакансії)
  CREATE TABLE IF NOT EXISTS resumes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    vacancy_id  INTEGER REFERENCES vacancies(id) ON DELETE SET NULL,
    name        TEXT    NOT NULL DEFAULT 'Без назви',
    latex_code  TEXT    NOT NULL DEFAULT '',
    is_base     INTEGER DEFAULT 0,   -- 1 = базовий шаблон
    created_at  TEXT    DEFAULT (datetime('now')),
    updated_at  TEXT    DEFAULT (datetime('now'))
  );

  -- Нотатки до вакансій (окремо від трекеру)
  CREATE TABLE IF NOT EXISTS vacancy_notes (
    vacancy_id  INTEGER PRIMARY KEY REFERENCES vacancies(id) ON DELETE CASCADE,
    note        TEXT    NOT NULL DEFAULT '',
    updated_at  TEXT    DEFAULT (datetime('now'))
  );

  -- Трекер відгуків на вакансії
  CREATE TABLE IF NOT EXISTS applications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    vacancy_id  INTEGER NOT NULL REFERENCES vacancies(id),
    status      TEXT    NOT NULL DEFAULT 'applied',
                                  -- applied | screening | interview | offer | rejected | withdrawn
    applied_at  TEXT    DEFAULT (datetime('now')),
    updated_at  TEXT    DEFAULT (datetime('now')),
    notes       TEXT,             -- нотатки користувача
    next_step   TEXT,             -- наступний крок (напр. "Тех. інтерв'ю")
    next_date   TEXT,             -- дата наступного кроку (ISO date)
    UNIQUE(vacancy_id)            -- одна вакансія — один відгук
  );

  -- Історія зміни статусів відгуку
  CREATE TABLE IF NOT EXISTS application_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    vacancy_id  INTEGER NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
    from_status TEXT,             -- null = перший відгук
    to_status   TEXT    NOT NULL,
    note        TEXT,
    changed_at  TEXT    DEFAULT (datetime('now'))
  );

  -- Збережені супровідні листи (один на вакансію)
  CREATE TABLE IF NOT EXISTS cover_letters (
    vacancy_id  INTEGER PRIMARY KEY REFERENCES vacancies(id) ON DELETE CASCADE,
    text        TEXT    NOT NULL DEFAULT '',
    updated_at  TEXT    DEFAULT (datetime('now'))
  );

  -- Версії резюме (до 10 на резюме)
  CREATE TABLE IF NOT EXISTS resume_versions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    resume_id  INTEGER NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
    latex_code TEXT    NOT NULL,
    saved_at   TEXT    DEFAULT (datetime('now'))
  );
`);

// ─── Вакансии ───────────────────────────────────────────

// Вставить вакансию (игнорируем дубликаты по UNIQUE constraint)
const insertVacancy = db.prepare(`
  INSERT OR IGNORE INTO vacancies (source, title, company, location, salary, url, description, published_at)
  VALUES (@source, @title, @company, @location, @salary, @url, @description, @published_at)
`);

// Построитель WHERE-условий (общий для всех query)
function buildWhere({ source, onlyNew, search, hasSalary } = {}) {
  const where  = [];
  const params = {};
  if (source && source !== 'all') { where.push('source = @source'); params.source = source; }
  if (onlyNew)   { where.push('is_new = 1'); }
  if (search)    { where.push('(title LIKE @search OR company LIKE @search)'); params.search = `%${search}%`; }
  if (hasSalary) { where.push("salary IS NOT NULL AND salary != ''"); }
  return { condition: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

// Получить все вакансии без пагинации (для серверной фильтрации по enrich-полям)
function getAllVacancies(filters = {}) {
  const { condition, params } = buildWhere(filters);
  return db.prepare(`SELECT * FROM vacancies ${condition} ORDER BY created_at DESC, id DESC`).all(params);
}

// Получить все вакансии с фильтрами + опциональный dedup
function getVacancies({ source, onlyNew, search, hasSalary, noDupes, limit = 100, offset = 0 } = {}) {
  const { condition, params } = buildWhere({ source, onlyNew, search, hasSalary });

  // При дедупликации: GROUP BY title+company, оставляем свежайшую запись
  if (noDupes) {
    return db.prepare(`
      SELECT *, MAX(id) as _mid FROM vacancies
      ${condition}
      GROUP BY lower(trim(title)), lower(trim(coalesce(company,'')))
      ORDER BY created_at DESC, id DESC
      LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset });
  }

  return db.prepare(`
    SELECT * FROM vacancies
    ${condition}
    ORDER BY created_at DESC, id DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset });
}

// Количество вакансий (для пагинации)
function countVacancies({ source, onlyNew, search, hasSalary, noDupes } = {}) {
  const { condition, params } = buildWhere({ source, onlyNew, search, hasSalary });
  if (noDupes) {
    return db.prepare(`
      SELECT COUNT(*) as cnt FROM (
        SELECT MAX(id) FROM vacancies ${condition}
        GROUP BY lower(trim(title)), lower(trim(coalesce(company,'')))
      )
    `).get(params).cnt;
  }
  return db.prepare(`SELECT COUNT(*) as cnt FROM vacancies ${condition}`).get(params).cnt;
}

// ─── Нотатки до вакансій ─────────────────────────────────────────
function getVacancyNote(vacancyId) {
  const row = db.prepare('SELECT note FROM vacancy_notes WHERE vacancy_id = ?').get(vacancyId);
  return row ? row.note : '';
}

function saveVacancyNote(vacancyId, note) {
  db.prepare(`
    INSERT INTO vacancy_notes (vacancy_id, note, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(vacancy_id) DO UPDATE SET note = excluded.note, updated_at = datetime('now')
  `).run(vacancyId, note || '');
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

// ─── Трекер відгуків ────────────────────────────────────

const _upsertApp = db.prepare(`
  INSERT INTO applications (vacancy_id, status, notes, next_step, next_date)
  VALUES (@vacancy_id, @status, @notes, @next_step, @next_date)
  ON CONFLICT(vacancy_id) DO UPDATE SET
    status     = excluded.status,
    notes      = excluded.notes,
    next_step  = excluded.next_step,
    next_date  = excluded.next_date,
    updated_at = datetime('now')
`);

const _insertHistory = db.prepare(`
  INSERT INTO application_history (vacancy_id, from_status, to_status, note)
  VALUES (@vacancy_id, @from_status, @to_status, @note)
`);

const _upsertWithHistory = db.transaction((params) => {
  const existing = db.prepare('SELECT status FROM applications WHERE vacancy_id = ?').get(params.vacancy_id);
  _upsertApp.run(params);
  if (!existing) {
    _insertHistory.run({ vacancy_id: params.vacancy_id, from_status: null, to_status: params.status, note: 'Перший відгук' });
  } else if (existing.status !== params.status) {
    _insertHistory.run({ vacancy_id: params.vacancy_id, from_status: existing.status, to_status: params.status, note: null });
  }
});

function upsertApplication(params) {
  return _upsertWithHistory(params);
}

const _deleteApp = db.prepare(`DELETE FROM applications WHERE vacancy_id = ?`);
function deleteApplication(vacancyId) {
  return _deleteApp.run(vacancyId);
}

const _getAppsAll = db.prepare(`
  SELECT a.*, v.title, v.company, v.source, v.url, v.salary, v.location
  FROM applications a
  JOIN vacancies v ON v.id = a.vacancy_id
  ORDER BY
    CASE a.status
      WHEN 'interview' THEN 1
      WHEN 'screening' THEN 2
      WHEN 'applied'   THEN 3
      WHEN 'offer'     THEN 4
      WHEN 'rejected'  THEN 5
      WHEN 'withdrawn' THEN 6
      ELSE 7
    END,
    a.updated_at DESC
`);

const _getAppsByStatus = db.prepare(`
  SELECT a.*, v.title, v.company, v.source, v.url, v.salary, v.location
  FROM applications a
  JOIN vacancies v ON v.id = a.vacancy_id
  WHERE a.status = ?
  ORDER BY
    CASE a.status
      WHEN 'interview' THEN 1
      WHEN 'screening' THEN 2
      WHEN 'applied'   THEN 3
      WHEN 'offer'     THEN 4
      WHEN 'rejected'  THEN 5
      WHEN 'withdrawn' THEN 6
      ELSE 7
    END,
    a.updated_at DESC
`);

function getApplications({ status } = {}) {
  return status ? _getAppsByStatus.all(status) : _getAppsAll.all();
}

function getApplicationByVacancy(vacancyId) {
  return db.prepare(`SELECT * FROM applications WHERE vacancy_id = ?`).get(vacancyId);
}

function getApplicationHistory(vacancyId) {
  return db.prepare(`
    SELECT * FROM application_history WHERE vacancy_id = ? ORDER BY changed_at ASC
  `).all(vacancyId);
}

function saveCoverLetter(vacancyId, text) {
  db.prepare(`
    INSERT INTO cover_letters (vacancy_id, text, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(vacancy_id) DO UPDATE SET text = excluded.text, updated_at = datetime('now')
  `).run(vacancyId, text || '');
}

function getCoverLetter(vacancyId) {
  const row = db.prepare('SELECT text FROM cover_letters WHERE vacancy_id = ?').get(vacancyId);
  return row ? row.text : '';
}

function getApplicationStats() {
  return db.prepare(`
    SELECT status, COUNT(*) as cnt FROM applications GROUP BY status
  `).all();
}

function getVacancyById(id) {
  return db.prepare('SELECT * FROM vacancies WHERE id = ?').get(id);
}

// ─── Резюме ─────────────────────────────────────────────────────────

// Базовий LaTeX шаблон DevOps-резюме
const BASE_LATEX = String.raw`\documentclass[letterpaper,11pt]{article}

\usepackage[utf8]{inputenc}
\usepackage[T2A]{fontenc}
\usepackage[empty]{fullpage}
\usepackage{titlesec}
\usepackage[usenames,dvipsnames]{color}
\usepackage{enumitem}
\usepackage[hidelinks]{hyperref}
\usepackage{fancyhdr}
\usepackage{tabularx}

\pagestyle{fancy}
\fancyhf{}
\fancyfoot{}
\renewcommand{\headrulewidth}{0pt}
\renewcommand{\footrulewidth}{0pt}

\addtolength{\oddsidemargin}{-0.5in}
\addtolength{\evensidemargin}{-0.5in}
\addtolength{\textwidth}{1in}
\addtolength{\topmargin}{-.5in}
\addtolength{\textheight}{1.0in}

\urlstyle{same}
\raggedbottom
\raggedright
\setlength{\tabcolsep}{0in}

\titleformat{\section}{
  \vspace{-4pt}\scshape\raggedright\large
}{}{0em}{}[\color{black}\titlerule \vspace{-5pt}]

% ─── Макроси ───────────────────────────────────────────
\newcommand{\resumeItem}[1]{\item\small{#1\vspace{-2pt}}}

\newcommand{\resumeSubheading}[4]{
  \vspace{-2pt}\item
    \begin{tabular*}{0.97\textwidth}[t]{l@{\extracolsep{\fill}}r}
      \textbf{#1} & #2 \\
      \textit{\small#3} & \textit{\small #4} \\
    \end{tabular*}\vspace{-7pt}
}

\newcommand{\resumeProjectHeading}[2]{
  \item
    \begin{tabular*}{0.97\textwidth}{l@{\extracolsep{\fill}}r}
      \small#1 & #2 \\
    \end{tabular*}\vspace{-7pt}
}

\newcommand{\resumeItemListStart}{\begin{itemize}}
\newcommand{\resumeItemListEnd}{\end{itemize}\vspace{-5pt}}
\newcommand{\resumeSubHeadingListStart}{\begin{itemize}[leftmargin=0.15in, label={}]}
\newcommand{\resumeSubHeadingListEnd}{\end{itemize}}

% ═══════════════════════════════════════════════════════
\begin{document}

% ─── ЗАГОЛОВОК ──────────────────────────────────────────
\begin{center}
  \textbf{\Huge \scshape Іван Іваненко} \\ \vspace{1pt}
  \small +380-XX-XXX-XXXX $|$
  \href{mailto:ivan@example.com}{ivan@example.com} $|$
  \href{https://linkedin.com/in/ivan}{linkedin.com/in/ivan} $|$
  \href{https://github.com/ivan}{github.com/ivan}
\end{center}

% ─── SUMMARY ─────────────────────────────────────────────
\section{Summary}
\small{
  DevOps / SRE Engineer з X роками досвіду. Спеціалізація: Kubernetes, AWS,
  Terraform, CI/CD. Досвід побудови та підтримки хмарної інфраструктури
  для high-load проектів. Готовий до remote-роботи.
}

% ─── ТЕХНІЧНІ НАВИЧКИ ────────────────────────────────────
\section{Technical Skills}
\resumeSubHeadingListStart
  \small{\item{
    \textbf{Cloud}{: AWS (EKS, EC2, RDS, S3, VPC, IAM), GCP} \\
    \textbf{Containers}{: Kubernetes, Docker, Helm, ArgoCD} \\
    \textbf{IaC}{: Terraform, Ansible} \\
    \textbf{CI/CD}{: GitLab CI, GitHub Actions, Jenkins} \\
    \textbf{Monitoring}{: Prometheus, Grafana, Loki, ELK Stack} \\
    \textbf{Languages}{: Python, Bash, Go} \\
    \textbf{OS}{: Linux (Ubuntu, Debian, RHEL/CentOS)} \\
  }}
\resumeSubHeadingListEnd

% ─── ДОСВІД ──────────────────────────────────────────────
\section{Experience}
\resumeSubHeadingListStart

  \resumeSubheading
    {Senior DevOps Engineer}{Черв. 2022 -- до тепер}
    {Компанія А}{Remote}
    \resumeItemListStart
      \resumeItem{Підтримував Kubernetes кластери (EKS) для 20+ мікросервісів}
      \resumeItem{Автоматизував інфраструктуру через Terraform + GitOps (ArgoCD)}
      \resumeItem{Впровадив моніторинг Prometheus/Grafana, знизив MTTR на 40\%}
      \resumeItem{Налаштував CI/CD pipelines у GitLab CI для 50+ репозиторіїв}
    \resumeItemListEnd

  \resumeSubheading
    {DevOps Engineer}{Лют. 2020 -- Черв. 2022}
    {Компанія Б}{Київ}
    \resumeItemListStart
      \resumeItem{Мігрував on-premise інфраструктуру до AWS (EC2, RDS, S3)}
      \resumeItem{Впровадив Docker та Kubernetes для containerization додатків}
      \resumeItem{Написав Ansible playbooks для автоматизації налаштування серверів}
    \resumeItemListEnd

\resumeSubHeadingListEnd

% ─── ОСВІТА ──────────────────────────────────────────────
\section{Education}
\resumeSubHeadingListStart
  \resumeSubheading
    {КПІ ім. Ігоря Сікорського}{Київ}
    {Бакалавр, Комп'ютерні науки}{2016 -- 2020}
\resumeSubHeadingListEnd

% ─── СЕРТИФІКАТИ ─────────────────────────────────────────
\section{Certifications}
\resumeSubHeadingListStart
  \resumeProjectHeading
    {\textbf{AWS Certified Solutions Architect} -- Associate}{2023}
  \resumeProjectHeading
    {\textbf{Certified Kubernetes Administrator (CKA)}}{2022}
\resumeSubHeadingListEnd

\end{document}
`;

// Ініціалізуємо базовий шаблон якщо його ще нема; патчимо якщо нема inputenc
(function seedBaseTemplate() {
  const existing = db.prepare('SELECT id, latex_code FROM resumes WHERE is_base = 1').get();
  if (!existing) {
    db.prepare(`INSERT INTO resumes (name, latex_code, is_base) VALUES (?, ?, 1)`)
      .run('Базовий шаблон', BASE_LATEX);
  } else if (!existing.latex_code.includes('inputenc')) {
    db.prepare(`UPDATE resumes SET latex_code = ? WHERE id = ?`)
      .run(BASE_LATEX, existing.id);
  }
})();

function getResumes() {
  return db.prepare(`
    SELECT r.*, v.title as vacancy_title, v.company as vacancy_company
    FROM resumes r
    LEFT JOIN vacancies v ON v.id = r.vacancy_id
    WHERE r.is_base = 0
    ORDER BY r.updated_at DESC
  `).all();
}

function getBaseResume() {
  return db.prepare('SELECT * FROM resumes WHERE is_base = 1').get();
}

function getResumeById(id) {
  return db.prepare(`
    SELECT r.*, v.title as vacancy_title, v.company as vacancy_company,
           v.description as vacancy_description, v.url as vacancy_url
    FROM resumes r
    LEFT JOIN vacancies v ON v.id = r.vacancy_id
    WHERE r.id = ?
  `).get(id);
}

function _saveVersion(resumeId, latexCode) {
  const last = db.prepare('SELECT latex_code FROM resume_versions WHERE resume_id = ? ORDER BY id DESC LIMIT 1').get(resumeId);
  if (last && last.latex_code === latexCode) return; // без змін — не зберігаємо
  db.prepare('INSERT INTO resume_versions (resume_id, latex_code) VALUES (?, ?)').run(resumeId, latexCode);
  // Тримаємо тільки 10 останніх версій
  db.prepare(`
    DELETE FROM resume_versions WHERE resume_id = ? AND id NOT IN (
      SELECT id FROM resume_versions WHERE resume_id = ? ORDER BY id DESC LIMIT 10
    )
  `).run(resumeId, resumeId);
}

function upsertResume({ id, vacancy_id, name, latex_code, is_base = 0 }) {
  if (id) {
    db.prepare(`
      UPDATE resumes SET name = ?, latex_code = ?, vacancy_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(name, latex_code, vacancy_id || null, id);
    if (!is_base) _saveVersion(id, latex_code);
    return id;
  } else {
    const result = db.prepare(`
      INSERT INTO resumes (vacancy_id, name, latex_code, is_base)
      VALUES (?, ?, ?, ?)
    `).run(vacancy_id || null, name, latex_code, is_base ? 1 : 0);
    const newId = result.lastInsertRowid;
    if (!is_base) _saveVersion(newId, latex_code);
    return newId;
  }
}

function getResumeVersions(resumeId) {
  return db.prepare(`
    SELECT id, saved_at FROM resume_versions WHERE resume_id = ? ORDER BY id DESC LIMIT 10
  `).all(resumeId);
}

function getResumeVersionCode(versionId) {
  return db.prepare('SELECT latex_code FROM resume_versions WHERE id = ?').get(versionId);
}

function deleteResume(id) {
  return db.prepare('DELETE FROM resumes WHERE id = ? AND is_base = 0').run(id);
}

module.exports = {
  insertVacancy,
  getVacancies,
  getAllVacancies,
  countVacancies,
  getVacancyById,
  markViewed,
  resetNewFlags,
  getStats,
  logScrape,
  getRecentLogs,
  upsertApplication,
  deleteApplication,
  getApplications,
  getApplicationByVacancy,
  getApplicationHistory,
  getApplicationStats,
  saveCoverLetter,
  getCoverLetter,
  getVacancyNote,
  saveVacancyNote,
  getResumes,
  getBaseResume,
  getResumeById,
  upsertResume,
  deleteResume,
  getResumeVersions,
  getResumeVersionCode,
};
