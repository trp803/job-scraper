// analytics.js — логіка аналізу вакансій
// Обчислює рейтинги компаній, складність входу, стек-аналіз
// Всі дані з SQLite, рахується в реальному часі

// db.js експортує окремі prepared statements, нам потрібен сирий об'єкт БД
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'jobs.db'));
db.pragma('journal_mode = WAL');

// ─── Константи ────────────────────────────────────────────────────

// Ключові слова для визначення рівня досвіду в назві вакансії
const SENIORITY = {
  junior:    /\b(junior|джуніор|intern|trainee|entry.level|jr\.?)\b/i,
  middle:    /\b(middle|mid\.?|міддл)\b/i,
  senior:    /\b(senior|sr\.?|сеніор|синьор)\b/i,
  lead:      /\b(lead|tech\.?\s*lead|team\.?\s*lead|principal|staff|architect)\b/i,
};

// Технологічний стек — що шукаємо в назвах та описах
const TECH_STACK = [
  // Cloud
  { key: 'AWS',            re: /\baws\b|\bamazon\s+web/i },
  { key: 'GCP',            re: /\bgcp\b|\bgoogle\s+cloud/i },
  { key: 'Azure',          re: /\bazure\b/i },
  // Containers & Orchestration
  { key: 'Kubernetes',     re: /\bkubernetes\b|\bk8s\b/i },
  { key: 'Docker',         re: /\bdocker\b/i },
  { key: 'Helm',           re: /\bhelm\b/i },
  // IaC
  { key: 'Terraform',      re: /\bterraform\b/i },
  { key: 'Ansible',        re: /\bansible\b/i },
  { key: 'Pulumi',         re: /\bpulumi\b/i },
  // CI/CD
  { key: 'CI/CD',          re: /\bci\/?cd\b|\bcontinuous/i },
  { key: 'GitLab CI',      re: /\bgitlab\s*(ci)?\b/i },
  { key: 'GitHub Actions', re: /\bgithub\s+actions\b/i },
  { key: 'Jenkins',        re: /\bjenkins\b/i },
  { key: 'ArgoCD',         re: /\bargoc?d\b/i },
  // Monitoring
  { key: 'Prometheus',     re: /\bprometheus\b/i },
  { key: 'Grafana',        re: /\bgrafana\b/i },
  { key: 'ELK / Loki',    re: /\belk\b|\belastic|\bloki\b|\bkibana\b/i },
  { key: 'Datadog',        re: /\bdatadog\b/i },
  // Programming
  { key: 'Python',         re: /\bpython\b/i },
  { key: 'Go / Golang',    re: /\bgolang\b|\bgo\s+lang|\bgo\s+developer/i },
  { key: 'Bash / Shell',   re: /\bbash\b|\bshell\b/i },
  // Systems
  { key: 'Linux',          re: /\blinux\b|\bubuntu\b|\bdebian\b/i },
  { key: 'Nginx',          re: /\bnginx\b/i },
  { key: 'PostgreSQL',     re: /\bpostgresql\b|\bpostgres\b/i },
  // Security & Other
  { key: 'Vault',          re: /\bhashicorp\s+vault\b|\bvault\b/i },
  { key: 'MLOps',          re: /\bmlops\b|\bml\s+ops\b/i },
];

// Слова що вказують на продуктову компанію
const PRODUCT_SIGNALS = /\bproduct\b|\bsaas\b|\bplatform\b|\bfintech\b|\bgamedev\b|\bgaming\b|\bstartup\b/i;

// ─── Хелпери ──────────────────────────────────────────────────────

// Витягнути рівень зарплати як число (USD або UAH → USD)
function parseSalary(salaryStr) {
  if (!salaryStr) return null;
  const s = salaryStr.replace(/,/g, '').replace(/\s/g, '');

  // USD: $1000–2000 або $1000+
  let m = s.match(/\$(\d+)[–\-—](\d+)/);
  if (m) return (parseInt(m[1]) + parseInt(m[2])) / 2;
  m = s.match(/\$(\d+)\+?/);
  if (m) return parseInt(m[1]);

  // UAH: 50000–80000 UAH
  m = s.match(/(\d+)[–\-—](\d+)\s*UAH/i);
  if (m) return Math.round((parseInt(m[1]) + parseInt(m[2])) / 2 / 40); // ~40 UAH/USD
  m = s.match(/(\d+)\s*UAH/i);
  if (m) return Math.round(parseInt(m[1]) / 40);

  return null;
}

// Скільки днів тому (відносно сьогодні)
function daysAgo(dateStr) {
  if (!dateStr) return 999;
  const d = new Date(dateStr);
  if (isNaN(d)) return 999;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

// Визначити рівень за назвою вакансії
function detectSeniority(title) {
  if (!title) return 'unknown';
  if (SENIORITY.junior.test(title)) return 'junior';
  if (SENIORITY.middle.test(title)) return 'middle';
  if (SENIORITY.lead.test(title))   return 'lead';
  if (SENIORITY.senior.test(title)) return 'senior';
  return 'unspecified';
}

// ─── Основний аналіз ──────────────────────────────────────────────

function buildAnalytics() {
  // Завантажуємо всі вакансії з БД
  const vacancies = db.prepare(`SELECT * FROM vacancies ORDER BY created_at DESC`).all();

  if (vacancies.length === 0) {
    return { empty: true };
  }

  // ═══ 1. АНАЛІЗ КОМПАНІЙ ══════════════════════════════════════

  const companiesMap = new Map(); // company name → stats

  for (const v of vacancies) {
    const name = (v.company || '').trim();
    if (!name || name.length < 2) continue;

    if (!companiesMap.has(name)) {
      companiesMap.set(name, {
        name,
        vacancies:    [],
        sources:      new Set(),
        salaries:     [],
        seniorities:  { junior: 0, middle: 0, senior: 0, lead: 0, unspecified: 0, unknown: 0 },
        minDaysAgo:   999,
        isProduct:    false,
      });
    }

    const c = companiesMap.get(name);
    c.vacancies.push(v);
    c.sources.add(v.source);

    const salary = parseSalary(v.salary);
    if (salary) c.salaries.push(salary);

    const sen = detectSeniority(v.title);
    c.seniorities[sen]++;

    const days = Math.min(daysAgo(v.published_at), daysAgo(v.created_at.slice(0,10)));
    if (days < c.minDaysAgo) c.minDaysAgo = days;

    const searchText = `${v.title} ${v.description || ''} ${v.company}`;
    if (PRODUCT_SIGNALS.test(searchText)) c.isProduct = true;
  }

  // ═══ 2. СКОРИНГ КОМПАНІЙ ════════════════════════════════════

  const companies = [];

  for (const [, c] of companiesMap) {
    const totalVacs = c.vacancies.length;
    const avgSalary = c.salaries.length
      ? Math.round(c.salaries.reduce((a, b) => a + b, 0) / c.salaries.length)
      : null;

    // ── Оцінка доступності (де простіше потрапити, 0–100) ──
    // Чим вище — тим простіше
    let accessScore = 50; // базова точка

    // Рівень позицій: junior = найпростіше
    if (c.seniorities.junior > 0)      accessScore += 30;
    else if (c.seniorities.middle > 0) accessScore += 15;
    else if (c.seniorities.senior > 0) accessScore -= 10;
    if (c.seniorities.lead > 0 && c.seniorities.junior === 0 && c.seniorities.middle === 0) {
      accessScore -= 20; // тільки lead/senior = важко
    }

    // Кількість відкритих позицій: більше = більше шансів
    if (totalVacs >= 5)      accessScore += 20;
    else if (totalVacs >= 3) accessScore += 10;
    else if (totalVacs === 1) accessScore -= 10;

    // Свіжість: нові вакансії = активний набір
    if (c.minDaysAgo <= 3)       accessScore += 15;
    else if (c.minDaysAgo <= 14) accessScore += 8;
    else if (c.minDaysAgo > 60)  accessScore -= 15;

    // Публікують зарплату = прозора компанія, легше домовлятись
    if (c.salaries.length > 0) accessScore += 10;

    // Кілька майданчиків = відомо про вакансію = більше кандидатів = складніше
    if (c.sources.size >= 3) accessScore -= 5;

    accessScore = Math.max(5, Math.min(95, accessScore));

    // ── Загальна привабливість компанії (0–100) ──
    let attractScore = 50;

    if (avgSalary) {
      if (avgSalary >= 4000)      attractScore += 25;
      else if (avgSalary >= 2000) attractScore += 15;
      else if (avgSalary >= 1000) attractScore += 5;
    }
    if (c.salaries.length > 0) attractScore += 10; // публікують ЗП
    if (totalVacs >= 3)         attractScore += 10; // багато вакансій
    if (c.sources.size >= 2)    attractScore += 10; // на кількох платформах
    if (c.minDaysAgo <= 7)      attractScore += 10; // свіжі вакансії
    if (c.isProduct)            attractScore += 5;  // product company

    attractScore = Math.max(5, Math.min(95, attractScore));

    // ── Наш фінальний рейтинг "підходить першим" ──
    // Баланс між привабливістю та доступністю
    const finalScore = Math.round(attractScore * 0.45 + accessScore * 0.55);

    companies.push({
      name:         c.name,
      totalVacs,
      sources:      [...c.sources],
      avgSalary,
      hasSalary:    c.salaries.length > 0,
      seniorities:  c.seniorities,
      minDaysAgo:   c.minDaysAgo,
      isProduct:    c.isProduct,
      accessScore:  Math.round(accessScore),
      attractScore: Math.round(attractScore),
      finalScore,
      // Ярлик доступності
      accessLabel:  accessScore >= 70 ? 'Легко' : accessScore >= 50 ? 'Реально' : accessScore >= 35 ? 'Середньо' : 'Складно',
      accessClass:  accessScore >= 70 ? 'easy'  : accessScore >= 50 ? 'medium'  : accessScore >= 35 ? 'hard'     : 'very-hard',
      // Посилання для швидкого фільтру
      filterUrl:    `/vacancies?company=${encodeURIComponent(c.name)}`,
    });
  }

  // Сортуємо за нашим фінальним рейтингом
  companies.sort((a, b) => b.finalScore - a.finalScore);

  // ═══ 3. АНАЛІЗ TECH STACK ═══════════════════════════════════

  const techCount = {};
  for (const tech of TECH_STACK) techCount[tech.key] = 0;

  for (const v of vacancies) {
    const text = `${v.title} ${v.description || ''}`;
    for (const tech of TECH_STACK) {
      if (tech.re.test(text)) techCount[tech.key]++;
    }
  }

  const techStack = TECH_STACK
    .map(t => ({ key: t.key, count: techCount[t.key] }))
    .filter(t => t.count > 0)
    .sort((a, b) => b.count - a.count);

  // Максимум для нормалізації прогрес-бару
  const maxTech = techStack[0]?.count || 1;
  techStack.forEach(t => { t.pct = Math.round((t.count / maxTech) * 100); });

  // ═══ 4. ЗАГАЛЬНА СТАТИСТИКА ══════════════════════════════════

  const totalWithSalary   = vacancies.filter(v => v.salary).length;
  const totalWithCompany  = vacancies.filter(v => v.company).length;
  const allSalaries       = vacancies.map(v => parseSalary(v.salary)).filter(Boolean);
  const avgGlobalSalary   = allSalaries.length
    ? Math.round(allSalaries.reduce((a, b) => a + b, 0) / allSalaries.length)
    : null;
  const maxGlobalSalary   = allSalaries.length ? Math.max(...allSalaries) : null;

  // Розподіл за рівнями
  const seniorityDist = { junior: 0, middle: 0, senior: 0, lead: 0, unspecified: 0 };
  for (const v of vacancies) {
    const s = detectSeniority(v.title);
    if (s === 'unknown') seniorityDist.unspecified++;
    else seniorityDist[s]++;
  }

  // Активні компанії (5+ вакансій)
  const activeCompanies = companies.filter(c => c.totalVacs >= 3).length;

  // Свіжі вакансії (за останні 7 днів)
  const freshVacancies = vacancies.filter(v => daysAgo(v.created_at.slice(0,10)) <= 7).length;

  return {
    empty:       false,
    total:       vacancies.length,
    companies:   companies.slice(0, 100), // топ-100 компаній
    topPicks:    companies.filter(c => c.totalVacs >= 1).slice(0, 15), // топ-15 "першочергових"
    techStack,
    stats: {
      totalCompanies:  companies.length,
      activeCompanies,
      withSalary:      totalWithSalary,
      withSalaryPct:   Math.round(totalWithSalary / vacancies.length * 100),
      avgSalary:       avgGlobalSalary,
      maxSalary:       maxGlobalSalary,
      freshVacancies,
      seniorityDist,
      totalWithCompany,
    },
  };
}

// API: вакансії конкретної компанії
function getCompanyVacancies(companyName) {
  return db.prepare(`
    SELECT * FROM vacancies
    WHERE company LIKE ?
    ORDER BY created_at DESC
  `).all(`%${companyName}%`);
}

module.exports = { buildAnalytics, getCompanyVacancies, detectSeniority, parseSalary };
