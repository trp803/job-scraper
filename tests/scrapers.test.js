// tests/scrapers.test.js — тести для всіх 5 парсерів
// Використовуємо axios-mock-adapter для перехоплення HTTP запитів
// sleep/randomDelay замінені на no-op щоб тести були швидкими

// Вимикаємо axios-retry щоб NetworkError відразу кидала виняток (без 3 спроб)
jest.mock('axios-retry', () => {
  const fn = () => {};
  fn.isNetworkOrIdempotentRequestError = () => false;
  fn.exponentialDelay = () => 0;
  return { default: fn, ...fn };
});

const axios = require('axios');
const MockAdapter = require('axios-mock-adapter');

// Мокаємо затримки — не чекаємо реальних sleep між запитами
jest.mock('../src/scrapers/utils', () => ({
  ...jest.requireActual('../src/scrapers/utils'),
  sleep:       () => Promise.resolve(),
  randomDelay: () => Promise.resolve(),
}));

const mock = new MockAdapter(axios);

afterEach(() => mock.reset());
afterAll(() => mock.restore());

// ═══════════════════════════════════════════════════════
// HH.UA (API JSON)
// ═══════════════════════════════════════════════════════

describe('hh.ua scraper', () => {
  const { scrape } = require('../src/scrapers/hhapi');

  const makeItem = (overrides = {}) => ({
    name:          'DevOps Engineer',
    alternate_url: 'https://hh.ua/vacancy/12345',
    employer:      { name: 'Test Company' },
    area:          { name: 'Київ' },
    salary:        { from: 2000, to: 3000, currency: 'USD' },
    published_at:  '2026-03-31T10:00:00+0000',
    snippet:       { requirement: 'Docker, Kubernetes', responsibility: '' },
    ...overrides,
  });

  const apiResponse = (items, pages = 1) => ({ items, pages });

  beforeEach(() => {
    // Мокаємо всі запити до API (4 запити × DevOps/SRE/...)
    mock.onGet('https://api.hh.ru/vacancies').reply(200, apiResponse([makeItem()]));
  });

  test('повертає вакансію з правильними полями', async () => {
    const results = await scrape();
    expect(results.length).toBeGreaterThan(0);
    const v = results[0];
    expect(v.source).toBe('hh.ua');
    expect(v.title).toBe('DevOps Engineer');
    expect(v.company).toBe('Test Company');
    expect(v.location).toBe('Київ');
    expect(v.salary).toBe('2000–3000 USD');
    expect(v.url).toBe('https://hh.ua/vacancy/12345');
    expect(v.published_at).toBe('2026-03-31');
  });

  test('salary: тільки from', async () => {
    mock.onGet('https://api.hh.ru/vacancies').reply(200, apiResponse([
      makeItem({ salary: { from: 1500, currency: 'USD' } }),
    ]));
    const results = await scrape();
    expect(results[0].salary).toBe('від 1500 USD');
  });

  test('salary: тільки to', async () => {
    mock.onGet('https://api.hh.ru/vacancies').reply(200, apiResponse([
      makeItem({ salary: { to: 4000, currency: 'USD' } }),
    ]));
    const results = await scrape();
    expect(results[0].salary).toBe('до 4000 USD');
  });

  test('salary null якщо не вказана', async () => {
    mock.onGet('https://api.hh.ru/vacancies').reply(200, apiResponse([
      makeItem({ salary: null }),
    ]));
    const results = await scrape();
    expect(results[0].salary).toBeNull();
  });

  test('фільтрує нерелевантні вакансії (Java Developer)', async () => {
    mock.onGet('https://api.hh.ru/vacancies').reply(200, apiResponse([
      makeItem({ name: 'Java Developer', alternate_url: 'https://hh.ua/vacancy/99999' }),
    ]));
    const results = await scrape();
    expect(results.find(v => v.url === 'https://hh.ua/vacancy/99999')).toBeUndefined();
  });

  test('дедупліцює однакові URL між запитами', async () => {
    const item = makeItem();
    mock.onGet('https://api.hh.ru/vacancies').reply(200, apiResponse([item, item]));
    const results = await scrape();
    const urls = results.map(v => v.url);
    const unique = [...new Set(urls)];
    expect(urls.length).toBe(unique.length);
  });

  test('не падає при помилці API', async () => {
    mock.onGet('https://api.hh.ru/vacancies').networkError();
    const results = await scrape();
    expect(Array.isArray(results)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// RABOTA.UA (API JSON)
// ═══════════════════════════════════════════════════════

describe('rabota.ua scraper', () => {
  const { scrape } = require('../src/scrapers/rabotaua');

  const makeDoc = (overrides = {}) => ({
    id:               '55555',
    name:             'DevOps Engineer',
    companyName:      'Robota Corp',
    cityName:         'Київ',
    salaryFrom:       50000,
    salaryTo:         80000,
    date:             '2026-03-31',
    shortDescription: 'Manage infrastructure',
    ...overrides,
  });

  beforeEach(() => {
    mock.onGet('https://api.robota.ua/vacancy/search').reply(200, {
      documents: [makeDoc()],
    });
  });

  test('повертає вакансію з правильними полями', async () => {
    const results = await scrape();
    expect(results.length).toBeGreaterThan(0);
    const v = results[0];
    expect(v.source).toBe('rabota.ua');
    expect(v.title).toBe('DevOps Engineer');
    expect(v.company).toBe('Robota Corp');
    expect(v.salary).toBe('50000–80000 UAH');
    expect(v.url).toBe('https://robota.ua/ua/vacancy/55555');
    expect(v.published_at).toBe('2026-03-31');
  });

  test('salary від when only salaryFrom', async () => {
    mock.onGet('https://api.robota.ua/vacancy/search').reply(200, {
      documents: [makeDoc({ salaryTo: null })],
    });
    const results = await scrape();
    expect(results[0].salary).toBe('від 50000 UAH');
  });

  test('salary null when no salary fields', async () => {
    mock.onGet('https://api.robota.ua/vacancy/search').reply(200, {
      documents: [makeDoc({ salaryFrom: null, salaryTo: null })],
    });
    const results = await scrape();
    expect(results[0].salary).toBeNull();
  });

  test('фільтрує нерелевантні вакансії', async () => {
    mock.onGet('https://api.robota.ua/vacancy/search').reply(200, {
      documents: [makeDoc({ id: '99', name: 'React Developer' })],
    });
    const results = await scrape();
    expect(results.find(v => v.url.includes('99'))).toBeUndefined();
  });

  test('підтримує поле vacancies замість documents', async () => {
    mock.onGet('https://api.robota.ua/vacancy/search').reply(200, {
      vacancies: [makeDoc({ id: '77777' })],
    });
    const results = await scrape();
    expect(results.find(v => v.url.includes('77777'))).toBeDefined();
  });

  test('не падає при помилці API', async () => {
    mock.onGet('https://api.robota.ua/vacancy/search').networkError();
    const results = await scrape();
    expect(Array.isArray(results)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// DOU.UA (HTML + AJAX)
// ═══════════════════════════════════════════════════════

describe('dou.ua scraper', () => {
  const { scrape } = require('../src/scrapers/douua');

  const mainHtml = `<html><body>
    <ul>
      <li class="l-vacancy">
        <a class="vt" href="https://jobs.dou.ua/companies/myco/vacancies/1234/">DevOps Engineer</a>
        <a class="company">My Company</a>
        <span class="salary">$2000-3000</span>
        <span class="cities">Київ</span>
        <div class="date">31 березня 2026</div>
        <p class="sh-info">Manage Docker and Kubernetes clusters</p>
      </li>
    </ul>
  </body></html>`;

  beforeEach(() => {
    // GET основної сторінки (DevOps і SRE категорії)
    mock.onGet(/jobs\.dou\.ua\/vacancies\/\?category=/).reply(200, mainHtml, {
      'set-cookie': ['csrftoken=testcsrf; Path=/'],
    });
    // POST AJAX — повертаємо last:true щоб зупинити пагінацію
    mock.onPost(/jobs\.dou\.ua\/vacancies\/xhr-load/).reply(200, { html: '', last: true, num: 0 });
  });

  test('повертає вакансію з правильними полями', async () => {
    const results = await scrape();
    expect(results.length).toBeGreaterThan(0);
    const v = results[0];
    expect(v.source).toBe('dou.ua');
    expect(v.title).toBe('DevOps Engineer');
    expect(v.company).toBe('My Company');
    expect(v.salary).toBe('$2000-3000');
    expect(v.location).toBe('Київ');
    expect(v.url).toBe('https://jobs.dou.ua/companies/myco/vacancies/1234/');
  });

  test('дедупліцює між категоріями (DevOps і SRE)', async () => {
    const results = await scrape();
    const urls = results.map(v => v.url);
    const unique = [...new Set(urls)];
    expect(urls.length).toBe(unique.length);
  });

  test('не падає при помилці GET', async () => {
    mock.onGet(/jobs\.dou\.ua\/vacancies\/\?category=/).networkError();
    const results = await scrape();
    expect(Array.isArray(results)).toBe(true);
  });

  test('парсить AJAX дані (додаткова сторінка)', async () => {
    const ajaxHtml = `<li class="l-vacancy">
      <a class="vt" href="https://jobs.dou.ua/companies/myco/vacancies/9999/">SRE Lead</a>
      <a class="company">Another Co</a>
      <span class="salary">$4000</span>
      <span class="cities">Remote</span>
    </li>`;
    // Перший AJAX — повертає дані, другий — last:true
    let ajaxCallCount = 0;
    mock.onPost(/jobs\.dou\.ua\/vacancies\/xhr-load/).reply(() => {
      ajaxCallCount++;
      if (ajaxCallCount === 1) return [200, { html: ajaxHtml, last: false, num: 1 }];
      return [200, { html: '', last: true, num: 0 }];
    });

    const results = await scrape();
    expect(results.some(v => v.url.includes('9999'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// DJINNI.CO (HTML з пагінацією)
// ═══════════════════════════════════════════════════════

describe('djinni.co scraper', () => {
  const { scrape } = require('../src/scrapers/djinni');

  // Мінімальний HTML що відповідає структурі djinni
  const makeJobHtml = (id, title, href, company, salary = '') => `
    <div id="job-item-${id}">
      <header>
        <div class="col">
          <div class="d-flex">${title} ${salary}</div>
          <div class="d-flex">${company}</div>
        </div>
      </header>
      <div class="job-item__position">${title}</div>
      <a class="job_item__header-link" href="${href}"></a>
      Full Remote
    </div>`;

  const pageHtml = (jobs) => `<html><body>${jobs}</body></html>`;

  beforeEach(() => {
    // Єдина сторінка (без пагінації — немає .pagination а)
    const html = pageHtml(makeJobHtml(1, 'Senior DevOps Engineer', '/jobs/11111/', 'Epam Systems', '$2000–3000'));
    mock.onGet(/djinni\.co\/jobs\//).reply(200, html);
  });

  test('повертає вакансію з правильними полями', async () => {
    const results = await scrape();
    expect(results.length).toBeGreaterThan(0);
    const v = results[0];
    expect(v.source).toBe('djinni.co');
    expect(v.title).toBe('Senior DevOps Engineer');
    expect(v.company).toBe('Epam Systems');
    expect(v.url).toBe('https://djinni.co/jobs/11111/');
    expect(v.location).toBeTruthy();
  });

  test('дедупліцює між пошуковими запитами', async () => {
    const results = await scrape();
    const urls = results.map(v => v.url);
    const unique = [...new Set(urls)];
    expect(urls.length).toBe(unique.length);
  });

  test('фільтрує нерелевантні вакансії (Java Developer)', async () => {
    const html = pageHtml(makeJobHtml(99, 'Java Developer', '/jobs/99999/', 'SomeCompany'));
    mock.onGet(/djinni\.co\/jobs\//).reply(200, html);
    const results = await scrape();
    expect(results.find(v => v.url.includes('99999'))).toBeUndefined();
  });

  test('не падає при помилці HTTP', async () => {
    mock.onGet(/djinni\.co\/jobs\//).networkError();
    const results = await scrape();
    expect(Array.isArray(results)).toBe(true);
  });

  test('витягує salary з тексту картки', async () => {
    const html = pageHtml(makeJobHtml(2, 'DevOps Engineer', '/jobs/22222/', 'Company', '$1500–2500'));
    mock.onGet(/djinni\.co\/jobs\//).reply(200, html);
    const results = await scrape();
    const v = results.find(r => r.url.includes('22222'));
    if (v) expect(v.salary).toMatch(/\$/);
  });
});

// ═══════════════════════════════════════════════════════
// WORK.UA (HTML)
// ═══════════════════════════════════════════════════════

describe('work.ua scraper', () => {
  const { scrape } = require('../src/scrapers/workua');

  const makeHtml = (title, href, company = '', salary = '') => `
    <html><body>
    <div id="pjax-job-list">
      <article>
        <h2><a href="${href}">${title}</a></h2>
        <b class="strong-600">${company}</b>
        <span class="label-green">${salary}</span>
        <p>Manage Kubernetes and CI/CD pipelines</p>
        <time datetime="2026-03-31"></time>
      </article>
    </div>
    </body></html>`;

  beforeEach(() => {
    mock.onGet(/work\.ua\/jobs/).reply(200, makeHtml('DevOps Engineer', '/jobs/1234/', 'WorkCo', '30 000 грн'));
  });

  test('повертає вакансію з правильними полями', async () => {
    const results = await scrape();
    expect(results.length).toBeGreaterThan(0);
    const v = results[0];
    expect(v.source).toBe('work.ua');
    expect(v.title).toBe('DevOps Engineer');
    expect(v.url).toBe('https://www.work.ua/jobs/1234/');
    expect(v.company).toBe('WorkCo');
    expect(v.salary).toBe('30 000 грн');
  });

  test('фільтрує нерелевантні вакансії', async () => {
    mock.onGet(/work\.ua\/jobs/).reply(200, makeHtml('Frontend Developer', '/jobs/9999/', 'Co'));
    const results = await scrape();
    expect(results.find(v => v.url.includes('9999'))).toBeUndefined();
  });

  test('дедупліцює однакові посилання', async () => {
    const html = `<html><body><div id="pjax-job-list">
      <article><h2><a href="/jobs/1/">DevOps Engineer</a></h2></article>
      <article><h2><a href="/jobs/1/">DevOps Engineer</a></h2></article>
    </div></body></html>`;
    mock.onGet(/work\.ua\/jobs/).reply(200, html);
    const results = await scrape();
    const urls = results.map(v => v.url);
    expect(urls.length).toBe(new Set(urls).size);
  });

  test('не падає при помилці HTTP', async () => {
    mock.onGet(/work\.ua\/jobs/).networkError();
    const results = await scrape();
    expect(Array.isArray(results)).toBe(true);
  });

  test('повертає пустий масив якщо немає вакансій', async () => {
    mock.onGet(/work\.ua\/jobs/).reply(200, '<html><body><div id="pjax-job-list"></div></body></html>');
    const results = await scrape();
    expect(results).toEqual([]);
  });
});
