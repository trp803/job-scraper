// hhapi.js — парсер через официальный API hh.ua / hh.ru
// hh.ua имеет открытый REST API — не нужен браузер, не блокируется
// Документация: https://github.com/hhru/api
// Лимит: 50 вакансий за запрос, можно пагинировать

const { get, sleep, cleanText, isDevOpsTitle } = require('./utils');

const SOURCE = 'hh.ua';

// area: 115 = Украина, 85 = Киев (в hh.ru базе)
const API_URL = 'https://api.hh.ru/vacancies';

async function scrape() {
  const results = [];
  const seen = new Set();

  const queries = ['DevOps', 'SRE', 'Site Reliability Engineer', 'DevOps Engineer'];

  for (const query of queries) {
    let page = 0;
    let totalPages = 1;

    while (page < totalPages && page < 3) { // максимум 3 страницы (150 вакансий)
      console.log(`[hh.ua] Запит: "${query}", сторінка ${page}`);

      let data;
      try {
        const resp = await get(API_URL, {
          params: {
            text: query,
            area: [115, 85],  // Украина + Киев
            per_page: 50,
            page,
            search_field: 'name',  // искать только в названии
            period: 30,             // вакансии за последние 30 дней
          },
          headers: {
            'HH-User-Agent': 'job-scraper/1.0 (personal project)',
          },
        });
        data = resp.data;
      } catch (err) {
        console.error(`[hh.ua] API помилка: ${err.message}`);
        break;
      }

      totalPages = data.pages || 1;

      for (const item of data.items || []) {
        const jobUrl = item.alternate_url;
        if (!jobUrl || seen.has(jobUrl)) continue;
        seen.add(jobUrl);

        // Зарплата (структурированная)
        let salary = null;
        if (item.salary) {
          const { from, to, currency } = item.salary;
          if (from && to) salary = `${from}–${to} ${currency}`;
          else if (from) salary = `від ${from} ${currency}`;
          else if (to) salary = `до ${to} ${currency}`;
        }

        // Локация
        const location = item.area?.name || 'Київ';

        // Дата публикации (ISO формат → укороченный)
        const published_at = item.published_at
          ? item.published_at.slice(0, 10)
          : null;

        // Краткие требования из snippet
        const desc = cleanText(item.snippet?.requirement || item.snippet?.responsibility || '').slice(0, 300) || null;

        const title = cleanText(item.name);
        if (!isDevOpsTitle(title)) continue;

        results.push({
          source: SOURCE,
          title,
          company: cleanText(item.employer?.name) || null,
          location,
          salary,
          url: jobUrl,
          description: desc,
          published_at,
        });
      }

      page++;
      await sleep(500); // вежливая пауза между страницами API
    }
  }

  console.log(`[hh.ua] Знайдено: ${results.length} вакансій`);
  return results;
}

module.exports = { scrape, SOURCE };
