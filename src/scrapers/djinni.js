// djinni.js — парсер djinni.co
// Djinni — популярна IT-площадка для України
// Структура: div[id^="job-item-"] > div.d-flex > a.job_item__header-link (заголовок)

const cheerio = require('cheerio');
const { get, randomDelay, cleanText } = require('./utils');

const SOURCE = 'djinni.co';

const PAGES = [
  'https://djinni.co/jobs/?primary_keyword=DevOps&location=ukraine',
  'https://djinni.co/jobs/?primary_keyword=SRE&location=ukraine',
];

async function scrape() {
  const results = [];
  const seen = new Set();

  for (const url of PAGES) {
    console.log(`[djinni.co] Парсим: ${url}`);

    let html;
    try {
      html = await get(url, {
        headers: { 'Referer': 'https://djinni.co/' },
      });
    } catch (err) {
      console.error(`[djinni.co] Помилка: ${err.message}`);
      continue;
    }

    const $ = cheerio.load(html.data);

    // Кожна вакансія: div з id "job-item-XXXXXX" та класом що містить "job-item"
    $('div[id^="job-item-"]').each((_, el) => {
      const $el = $(el);

      // Заголовок: елемент з класом job-item__position всередині картки
      // Посилання на вакансію: a.job_item__header-link
      const $link = $el.find('a.job_item__header-link').first();
      const href = $link.attr('href');
      // Чистий заголовок без дочірніх елементів ($$$$ та компанія)
      const title = cleanText($el.find('.job-item__position').first().text());
      if (!title || !href) return;

      const jobUrl = `https://djinni.co${href}`;
      if (seen.has(jobUrl)) return;
      seen.add(jobUrl);

      // Текст всього блоку для витягування компанії та інфо
      // Структура тексту: "Назва $$$$ Компанія Локація · деталі"
      const fullText = cleanText($el.find('.d-flex').text());

      // Компанія: текст після "$$$$" до кінця рядка з компанією
      // У Djinni символи $$$$ позначають рівень зарплати (не реальна зарплата)
      let company = null;
      const afterDollars = fullText.split('$$$$').slice(1).join('').trim();
      if (afterDollars) {
        // Беремо перше слово/фразу до " Full Remote" або " Ukraine" або " ·"
        const companyMatch = afterDollars.match(/^([^·\n]+?)(?:\s+(?:Full Remote|Part|Ukraine|Remote|Responds))/);
        company = companyMatch ? cleanText(companyMatch[1]) : cleanText(afterDollars.split('·')[0]);
      }

      // Зарплата: в Djinni частіше пишуть "$1000–2000" в тексті картки
      const salaryMatch = fullText.match(/\$[\d,]+[\s–-]+[\d,]+|\$[\d,]+\+?|\d+[\s–-]+\d+\s*\$/);
      const salary = salaryMatch ? salaryMatch[0] : null;

      // Теги: знаходимо span з технологіями
      const tags = $el.find('.badge, span[class*="tag"], .nobr')
        .map((_, t) => cleanText($(t).text()))
        .get()
        .filter(t => t && t.length < 30)
        .slice(0, 5)
        .join(', ');

      results.push({
        source: SOURCE,
        title,
        company: company || null,
        location: 'Україна/Remote',
        salary,
        url: jobUrl,
        description: tags || null,
        published_at: null,
      });
    });

    await randomDelay(2000, 4000);
  }

  console.log(`[djinni.co] Знайдено: ${results.length} вакансій`);
  return results;
}

module.exports = { scrape, SOURCE };
