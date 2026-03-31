// telegram.js — сповіщення про нові вакансії через Telegram Bot API
// Налаштування: TELEGRAM_BOT_TOKEN і TELEGRAM_CHAT_ID в .env або docker-compose env

const axios = require('axios');

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const APP_URL = process.env.APP_URL || 'http://localhost:3333';

// Відправити повідомлення в Telegram
async function sendMessage(text) {
  if (!TOKEN || !CHAT_ID) return;
  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id:                  CHAT_ID,
    text,
    parse_mode:               'Markdown',
    disable_web_page_preview: true,
  }, { timeout: 10000 });
}

// Сповістити про нові вакансії після скрейпу
async function notifyNewJobs(newVacancies) {
  if (!TOKEN || !CHAT_ID) return;
  if (!newVacancies || newVacancies.length === 0) return;

  const count = newVacancies.length;
  const top   = newVacancies.slice(0, 5);

  const lines = top.map(v => {
    let line = `• [${escapeMarkdown(v.title)}](${v.url})`;
    if (v.company) line += ` — ${escapeMarkdown(v.company)}`;
    if (v.salary)  line += ` | ${escapeMarkdown(v.salary)}`;
    return line;
  });

  const extra = count > 5 ? `\n_...та ще ${count - 5} вакансій_` : '';

  const msg = [
    `🔍 *DevOps Jobs* — знайдено *${count}* нових вакансій!`,
    '',
    lines.join('\n'),
    extra,
    '',
    `[Відкрити всі →](${APP_URL})`,
  ].join('\n');

  await sendMessage(msg);
}

// Екранування спец-символів Markdown v1
function escapeMarkdown(str) {
  if (!str) return '';
  return String(str).replace(/([_*[\]()])/g, '\\$1');
}

module.exports = { notifyNewJobs, sendMessage };
