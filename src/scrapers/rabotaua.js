// rabotaua.js — парсер rabota.ua
// rabota.ua — SPA на React, но у них есть API для поиска вакансий
// Используем их внутренний API (он публичен, без ключа)

const { get, randomDelay, cleanText } = require('./utils');

const SOURCE = 'rabota.ua';

// Ключові слова для перевірки — API rabota.ua не фільтрує точно за назвою
const KEYWORDS = ['devops', 'sre', 'site reliability', 'cloud', 'infrastructure', 'infra',
                  'kubernetes', 'k8s', 'terraform', 'ansible', 'ci/cd', 'platform engineer'];

// API robota.ua (rabota.ua перейменувалась в robota.ua)
const API_URL = 'https://api.robota.ua/vacancy/search';

async function scrape() {
  const results = [];
  const seen = new Set();

  const queries = ['devops', 'devops engineer', 'sre'];

  for (const query of queries) {
    console.log(`[rabota.ua] Запит: "${query}"`);

    let data;
    try {
      const resp = await get(API_URL, {
        params: {
          keywords: query,  // robota.ua використовує 'keywords' (не 'keyword')
          cityId: 1,        // 1 = Київ
          page: 0,
          count: 40,
        },
        headers: {
          'Origin': 'https://robota.ua',
          'Referer': 'https://robota.ua/',
        },
      });
      data = resp.data;
    } catch (err) {
      console.error(`[rabota.ua] Помилка: ${err.message}`);
      continue;
    }

    const vacancies = data?.documents || data?.vacancies || data?.items || [];

    for (const item of vacancies) {
      // ID и URL вакансии
      const id = item.id || item.notebookId;
      if (!id) continue;

      const jobUrl = `https://robota.ua/ua/vacancy/${id}`;
      if (seen.has(jobUrl)) continue;
      seen.add(jobUrl);

      // Зарплата
      let salary = null;
      if (item.salaryFrom && item.salaryTo) {
        salary = `${item.salaryFrom}–${item.salaryTo} UAH`;
      } else if (item.salaryFrom) {
        salary = `від ${item.salaryFrom} UAH`;
      }

      // Дата публикации (ISO формат → дата)
      const published_at = (item.date || item.datePublished)
        ? (item.date || item.datePublished).slice(0, 10)
        : null;

      const title = cleanText(item.name || item.vacancy || item.title || '');
      if (!title) continue;

      // Перевіряємо що вакансія стосується DevOps (API rabota.ua не фільтрує точно)
      const titleLower = title.toLowerCase();
      const isRelevant = KEYWORDS.some(kw => titleLower.includes(kw));
      if (!isRelevant) continue;

      results.push({
        source: SOURCE,
        title,
        company: cleanText(item.companyName || item.company || '') || null,
        location: cleanText(item.cityName || '') || 'Київ',
        salary,
        url: jobUrl,
        description: cleanText(item.shortDescription || '').slice(0, 300) || null,
        published_at,
      });
    }

    await randomDelay(2000, 4000);
  }

  console.log(`[rabota.ua] Знайдено: ${results.length} вакансій`);
  return results;
}

module.exports = { scrape, SOURCE };
