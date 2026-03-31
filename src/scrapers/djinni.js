// djinni.js — парсер djinni.co
// Djinni — найбільша IT-площадка для України
//
// Структура пагінації:
//   /jobs/?primary_keyword=DevOps&page=N  (15 вакансій на сторінку)
//   Остання сторінка визначається з .pagination a (максимальне число)
//
// Стратегія пошуку:
//   1. primary_keyword=DevOps      — 16 стор. (~226 вакансій) — основна категорія
//   2. primary_keyword=Sysadmin    — 10 стор. (~136 вакансій) — Linux/system admin
//   3. all_keywords=SRE            — 1 стор.  (~14 вакансій)  — пошук по тексту
//   4. all_keywords=kubernetes     — 5 стор.  (~75 вакансій)  — технологічний пошук
//   5. all_keywords=terraform      — 4 стор.  (~60 вакансій)  — технологічний пошук
// Всі результати дедуплікуються по URL

const cheerio = require('cheerio');
const { get, sleep, cleanText, isDevOpsTitle } = require('./utils');

const SOURCE = 'djinni.co';

// Джерела пошуку: тільки категорійні фільтри (primary_keyword)
// all_keywords=kubernetes/terraform повертає будь-яких девів що згадують ці інструменти
const SEARCH_SOURCES = [
  { label: 'DevOps',   params: 'primary_keyword=DevOps' },
  { label: 'Sysadmin', params: 'primary_keyword=Sysadmin' },
  { label: 'SRE',      params: 'all_keywords=SRE' },
];

// Визначити останню сторінку з пагінації
function getLastPage($) {
  const nums = $('.pagination a, .page-item a')
    .map((_, el) => parseInt($(el).text().trim()))
    .get()
    .filter(n => !isNaN(n) && n > 0);
  return nums.length ? Math.max(...nums) : 1;
}

// Витягти вакансії з cheerio-об'єкта
function extractVacancies($, seen) {
  const results = [];

  $('div[id^="job-item-"]').each((_, el) => {
    const $el = $(el);

    // Заголовок: елемент .job-item__position (чистий текст без дочірніх span)
    const title = cleanText($el.find('.job-item__position').first().text());
    if (!title) return;

    // Фільтр релевантності — Sysadmin-категорія може містити не-DevOps ролі
    if (!isDevOpsTitle(title)) return;

    // Посилання: a.job_item__header-link
    const $link = $el.find('a.job_item__header-link').first();
    const href = $link.attr('href');
    if (!href) return;

    const jobUrl = `https://djinni.co${href}`;
    if (seen.has(jobUrl)) return;
    seen.add(jobUrl);

    // Компанія: другий div всередині header .col
    // Структура: header .col > .d-flex[0] = заголовок + рівень зп ($$$)
    //            header .col > .d-flex[1] = назва компанії
    const companyRaw = cleanText($el.find('header .col > .d-flex').eq(1).text());
    // Видаляємо маркетингові суфікси: "Top Employer", "Responds Quickly", "Verified Employer"
    const company = companyRaw
      .replace(/\s*(Top Employer|Responds Quickly|Verified Employer|Verified)\s*/gi, '')
      .trim() || null;

    // Зарплата: шукаємо патерн "$X–Y" або "$X+" в тексті всієї картки
    const cardText = cleanText($el.text());
    const salaryMatch = cardText.match(/\$[\d, ]+[–\-—]+[\d, ]+|\$[\d,]+\+?/);
    const salary = salaryMatch ? salaryMatch[0].trim() : null;

    // Локація
    const locationMatch = cardText.match(/Full Remote|Part.?time Remote|Remote|Kyiv|Lviv|Kharkiv/i);
    const location = locationMatch ? locationMatch[0] : 'Україна';

    results.push({
      source: SOURCE,
      title,
      company,
      location,
      salary,
      url: jobUrl,
      description: null,
      published_at: null,
    });
  });

  return results;
}

// Отримати всі вакансії за одним search source (з пагінацією)
async function scrapeSource(source, globalSeen) {
  const results = [];
  const baseUrl = `https://djinni.co/jobs/?${source.params}`;

  // Перша сторінка — визначаємо кількість сторінок
  let firstHtml;
  try {
    firstHtml = await get(baseUrl, { headers: { 'Referer': 'https://djinni.co/' } });
  } catch (err) {
    console.error(`[djinni.co] ${source.label} помилка: ${err.message}`);
    return results;
  }

  const $first = cheerio.load(firstHtml.data);
  const lastPage = getLastPage($first);
  const batch = extractVacancies($first, globalSeen);
  results.push(...batch);

  console.log(`[djinni.co] ${source.label}: стор. 1/${lastPage} → +${batch.length}`);

  // Перебираємо решту сторінок
  for (let page = 2; page <= lastPage; page++) {
    await sleep(1200);

    let html;
    try {
      html = await get(`${baseUrl}&page=${page}`, {
        headers: { 'Referer': baseUrl },
      });
    } catch (err) {
      console.error(`[djinni.co] ${source.label} стор.${page} помилка: ${err.message}`);
      continue;
    }

    const $ = cheerio.load(html.data);
    const pageBatch = extractVacancies($, globalSeen);
    results.push(...pageBatch);
    console.log(`[djinni.co] ${source.label}: стор. ${page}/${lastPage} → +${pageBatch.length}`);
  }

  return results;
}

async function scrape() {
  const allResults = [];
  const globalSeen = new Set(); // дедупліцюємо по URL між усіма запитами

  for (const source of SEARCH_SOURCES) {
    const batch = await scrapeSource(source, globalSeen);
    allResults.push(...batch);
    await sleep(2000); // пауза між різними джерелами
  }

  console.log(`[djinni.co] Всього знайдено: ${allResults.length} унікальних вакансій`);
  return allResults;
}

module.exports = { scrape, SOURCE };
