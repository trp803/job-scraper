// utils.js — общие утилиты для всех парсеров

const axios = require('axios');
const axiosRetry = require('axios-retry').default;

// Настраиваем axios: 3 попытки с экспоненциальной задержкой
// Если сайт временно не отвечает — ждём и пробуем снова
axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,  // 1s, 2s, 4s
  retryCondition: (error) => {
    // Повторяем при сетевых ошибках и статусах 429, 5xx
    return axiosRetry.isNetworkOrIdempotentRequestError(error)
      || (error.response && error.response.status === 429);
  },
});

// Реалистичный User-Agent — чтобы не блокировали как бота
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Базовые заголовки для всех запросов
const DEFAULT_HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'uk-UA,uk;q=0.9,ru;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
};

// GET запрос с таймаутом и заголовками
async function get(url, options = {}) {
  const response = await axios.get(url, {
    headers: { ...DEFAULT_HEADERS, ...options.headers },
    timeout: 15000,  // 15 секунд
    ...options,
  });
  return response;
}

// Пауза между запросами — вежливый парсер не нагружает сервер
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Случайная задержка между min и max мс (меньше детектится как бот)
function randomDelay(min = 1000, max = 3000) {
  return sleep(Math.floor(Math.random() * (max - min) + min));
}

// Обрезать и почистить текст (убрать лишние пробелы, переносы)
function cleanText(text) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

module.exports = { get, sleep, randomDelay, cleanText };
