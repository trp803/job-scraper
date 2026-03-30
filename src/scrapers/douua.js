// douua.js — парсер jobs.dou.ua
// DOU.ua — головний IT-портал України
// Перші 20 вакансій рендеряться в HTML, решта завантажується через AJAX
// AJAX endpoint: POST /vacancies/xhr-load/?category=DevOps (категорія в URL!)
// Параметр count в тілі POST = скільки вже завантажено (offset)
// Відповідь: { html: "...", last: true/false, num: N }

const cheerio = require('cheerio');
const { get, sleep, cleanText } = require('./utils');
const axios = require('axios');

const SOURCE = 'dou.ua';

// Категорії DevOps на DOU (назви мають відповідати їхнім URL-параметрам)
const CATEGORIES = [
  { name: 'DevOps', url: 'DevOps' },
  { name: 'SRE',    url: 'SRE' },
];

// Заголовки для AJAX запитів
const AJAX_HEADERS_BASE = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'X-Requested-With': 'XMLHttpRequest',
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
};

// Витягти вакансії з HTML (cheerio object)
function extractVacancies($, seen) {
  const results = [];

  $('li.l-vacancy').each((_, el) => {
    const $el = $(el);

    // Заголовок і посилання
    const $link = $el.find('a.vt').first();
    const title = cleanText($link.text());
    const href = $link.attr('href');
    if (!title || !href) return;
    if (seen.has(href)) return;
    seen.add(href);

    // Компанія: a.company
    const company = cleanText($el.find('a.company').text()) || null;

    // Зарплата: span.salary
    const salary = cleanText($el.find('span.salary').text()) || null;

    // Локація: span.cities (може бути кілька міст через кому)
    const location = cleanText($el.find('span.cities').text()) || 'Україна';

    // Дата публікації
    const published_at = cleanText($el.find('div.date').text()) || null;

    // Короткий опис
    const desc = cleanText($el.find('p.sh-info').text()).slice(0, 300) || null;

    results.push({
      source: SOURCE,
      title,
      company,
      location,
      salary,
      url: href,
      description: desc,
      published_at,
    });
  });

  return results;
}

async function scrapeCategory(categoryUrl) {
  const results = [];
  const seen = new Set();

  const pageUrl = `https://jobs.dou.ua/vacancies/?category=${categoryUrl}`;
  const xhrUrl  = `https://jobs.dou.ua/vacancies/xhr-load/?category=${categoryUrl}`;

  console.log(`[dou.ua] Категорія: ${categoryUrl}`);

  // ─── Крок 1: Основна сторінка (перші 20 вакансій) ───────────
  let html;
  try {
    html = await get(pageUrl, {
      headers: { 'Referer': 'https://dou.ua/' },
    });
  } catch (err) {
    console.error(`[dou.ua] Помилка GET: ${err.message}`);
    return results;
  }

  // Витягуємо CSRF та cookies з відповіді
  const setCookies = html.headers['set-cookie'] || [];
  const cookieStr  = setCookies.map(c => c.split(';')[0]).join('; ');
  const csrf = cookieStr.match(/csrftoken=([^;]+)/)?.[1] || '';

  const $first = cheerio.load(html.data);
  const firstBatch = extractVacancies($first, seen);
  results.push(...firstBatch);
  console.log(`[dou.ua]   Основна сторінка: ${firstBatch.length} вакансій`);

  // ─── Крок 2: AJAX пагінація ──────────────────────────────────
  // DOU підвантажує по 40 вакансій за раз
  // count = кількість вже завантажених (офсет)
  let count = firstBatch.length;
  let iteration = 0;

  while (true) {
    iteration++;
    let ajaxResp;
    try {
      ajaxResp = await axios.post(xhrUrl, `count=${count}`, {
        headers: {
          ...AJAX_HEADERS_BASE,
          'X-CSRFToken': csrf,
          'Referer': pageUrl,
          'Cookie': cookieStr,
        },
        timeout: 15000,
      });
    } catch (err) {
      console.error(`[dou.ua] Помилка AJAX ітерація ${iteration}: ${err.message}`);
      break;
    }

    const data = ajaxResp.data;
    const $ajax = cheerio.load(data.html || '');
    const batch = extractVacancies($ajax, seen);
    results.push(...batch);
    count += batch.length;

    console.log(`[dou.ua]   AJAX [${iteration}]: +${batch.length}, загально: ${count}, last: ${data.last}`);

    // Зупиняємось коли last === true або нема нових вакансій
    if (data.last === true || batch.length === 0) break;

    // Пауза між запитами (щоб не навантажувати сервер)
    await sleep(1000);
  }

  return results;
}

async function scrape() {
  const allResults = [];
  const globalSeen = new Set();

  for (const cat of CATEGORIES) {
    const catResults = await scrapeCategory(cat.url);
    // Глобальна дедупликація між категоріями (SRE може перетинатись з DevOps)
    for (const v of catResults) {
      if (!globalSeen.has(v.url)) {
        globalSeen.add(v.url);
        allResults.push(v);
      }
    }
    await sleep(2000); // пауза між категоріями
  }

  console.log(`[dou.ua] Всього знайдено: ${allResults.length} вакансій`);
  return allResults;
}

module.exports = { scrape, SOURCE };
