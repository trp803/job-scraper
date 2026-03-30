// workua.js — парсер work.ua
// work.ua рендерит HTML на сервере, поэтому cheerio работает без браузера
// URL: https://www.work.ua/jobs-devops/?city=1 (city=1 — Киев)

const cheerio = require('cheerio');
const { get, randomDelay, cleanText } = require('./utils');

const SOURCE = 'work.ua';

// Слова для поиска DevOps вакансий
const SEARCH_QUERIES = ['devops', 'DevOps Engineer', 'SRE'];

async function scrape() {
  const results = [];
  const seen = new Set(); // дедупликация по URL внутри запуска

  for (const query of SEARCH_QUERIES) {
    const url = `https://www.work.ua/jobs/?city=1&q=${encodeURIComponent(query)}&advs=1`;

    console.log(`[work.ua] Парсим: ${url}`);
    const html = await get(url);
    const $ = cheerio.load(html.data);

    // Каждая вакансия — карточка с классом .job-link или article в списке
    // Структура: h2.h2 > a (заголовок), div.add-top-sm (компания, локация)
    $('div#pjax-job-list article, div#pjax-job-list .card').each((_, el) => {
      const $el = $(el);

      // Ссылка и заголовок
      const $link = $el.find('h2 a, h3 a').first();
      const title = cleanText($link.text());
      const href = $link.attr('href');
      if (!title || !href) return;

      const jobUrl = `https://www.work.ua${href}`;
      if (seen.has(jobUrl)) return;
      seen.add(jobUrl);

      // Компания
      const company = cleanText($el.find('.add-top-sm .strong-600, b.strong-600').first().text());

      // Зарплата — если указана, обычно в тексте карточки
      const salaryEl = $el.find('.label-green, .label-salary, span[title*="грн"], span[title*="$"]').first();
      const salary = cleanText(salaryEl.text()) || null;

      // Краткое описание (первые 200 символов из тела карточки)
      const desc = cleanText($el.find('p').first().text()).slice(0, 300) || null;

      // Дата публикации
      const dateEl = $el.find('time').attr('datetime') || $el.find('.pull-right .text-muted').text();
      const published_at = cleanText(dateEl) || null;

      results.push({
        source: SOURCE,
        title,
        company: company || null,
        location: 'Київ',
        salary,
        url: jobUrl,
        description: desc,
        published_at,
      });
    });

    await randomDelay(2000, 4000);
  }

  console.log(`[work.ua] Знайдено: ${results.length} вакансій`);
  return results;
}

module.exports = { scrape, SOURCE };
