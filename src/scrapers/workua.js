// workua.js — парсер work.ua

const cheerio = require('cheerio');
const { get, randomDelay, cleanText, isDevOpsTitle } = require('./utils');

const SOURCE = 'work.ua';

// work.ua має категорію IT + пошук по запиту
// Використовуємо rubric=1 (IT) щоб одразу звузити до IT-вакансій
const SEARCH_QUERIES = ['DevOps', 'SRE'];

async function scrape() {
  const results = [];
  const seen = new Set();

  for (const query of SEARCH_QUERIES) {
    // rubric=1 — IT і комп'ютери, advs=1 — розширений пошук по назві
    const url = `https://www.work.ua/jobs/?city=1&q=${encodeURIComponent(query)}&rubric=1&advs=1`;

    console.log(`[work.ua] Парсим: ${url}`);
    let html;
    try {
      html = await get(url);
    } catch (err) {
      console.error(`[work.ua] Помилка: ${err.message}`);
      continue;
    }
    const $ = cheerio.load(html.data);

    $('div#pjax-job-list article, div#pjax-job-list .card').each((_, el) => {
      const $el = $(el);

      const $link = $el.find('h2 a, h3 a').first();
      const title = cleanText($link.text());
      const href  = $link.attr('href');
      if (!title || !href) return;

      // Фільтр: тільки DevOps-релевантні назви
      if (!isDevOpsTitle(title)) return;

      const jobUrl = `https://www.work.ua${href}`;
      if (seen.has(jobUrl)) return;
      seen.add(jobUrl);

      const company    = cleanText($el.find('.add-top-sm .strong-600, b.strong-600').first().text());
      const salaryEl   = $el.find('.label-green, .label-salary, span[title*="грн"], span[title*="$"]').first();
      const salary     = cleanText(salaryEl.text()) || null;
      const desc       = cleanText($el.find('p').first().text()).slice(0, 300) || null;
      const dateEl     = $el.find('time').attr('datetime') || $el.find('.pull-right .text-muted').text();
      const published_at = cleanText(dateEl) || null;

      results.push({ source: SOURCE, title, company: company || null,
        location: 'Київ', salary, url: jobUrl, description: desc, published_at });
    });

    await randomDelay(2000, 4000);
  }

  console.log(`[work.ua] Знайдено: ${results.length} вакансій`);
  return results;
}

module.exports = { scrape, SOURCE };
