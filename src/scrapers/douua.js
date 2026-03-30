// douua.js — парсер jobs.dou.ua
// DOU.ua — главный украинский IT-портал
// URL: https://jobs.dou.ua/vacancies/?city=Киев&category=DevOps
// Сайт рендерит HTML, доступен через cheerio

const cheerio = require('cheerio');
const { get, randomDelay, cleanText } = require('./utils');

const SOURCE = 'dou.ua';

async function scrape() {
  const results = [];
  const seen = new Set();

  // DOU разделяет по категориям
  const urls = [
    'https://jobs.dou.ua/vacancies/?city=%D0%9A%D0%B8%D1%97%D0%B2&category=DevOps',
    'https://jobs.dou.ua/vacancies/?city=%D0%9A%D0%B8%D1%97%D0%B2&category=SRE',
  ];

  for (const url of urls) {
    console.log(`[dou.ua] Парсим: ${url}`);

    const html = await get(url, {
      headers: {
        // DOU требует Referer для некоторых запросов
        'Referer': 'https://dou.ua/',
        'Cookie': 'csrftoken=stub',  // базовая кука
      },
    });

    const $ = cheerio.load(html.data);

    // DOU — каждая вакансия: li.l-vacancy
    $('li.l-vacancy').each((_, el) => {
      const $el = $(el);

      // Заголовок и ссылка
      const $link = $el.find('a.vt').first();
      const title = cleanText($link.text());
      const href = $link.attr('href');
      if (!title || !href) return;
      if (seen.has(href)) return;
      seen.add(href);

      // Компания: span.company > a
      const company = cleanText($el.find('a.company').text());

      // Зарплата: div.salary
      const salary = cleanText($el.find('span.salary').text()) || null;

      // Метаданные: місто, дата
      const location = cleanText($el.find('span.cities').text()) || 'Київ';

      // Дата: dd.mm.yyyy формат
      const published_at = cleanText($el.find('div.date').text()) || null;

      // Краткое описание
      const desc = cleanText($el.find('p.sh-info').text()).slice(0, 300) || null;

      results.push({
        source: SOURCE,
        title,
        company: company || null,
        location,
        salary,
        url: href,
        description: desc,
        published_at,
      });
    });

    await randomDelay(2000, 5000);
  }

  console.log(`[dou.ua] Знайдено: ${results.length} вакансій`);
  return results;
}

module.exports = { scrape, SOURCE };
