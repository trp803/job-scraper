#!/usr/bin/env bash
# change-password.sh — зміна логіну та паролю для сайту
# Записує в .env файл і перезапускає контейнер

set -e
cd "$(dirname "$0")/.."

echo "════════════════════════════════════════"
echo "  Job Scraper — Зміна паролю"
echo "════════════════════════════════════════"
echo ""

ENV_FILE=".env"

# Поточні значення (з .env або docker-compose defaults)
CURRENT_USER=$(grep "^AUTH_USER=" "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo "admin")
echo "Поточний логін: ${CURRENT_USER}"
echo ""

# Новий логін
read -rp "Новий логін [Enter = залишити '${CURRENT_USER}']: " NEW_USER
NEW_USER="${NEW_USER:-$CURRENT_USER}"

# Новий пароль
while true; do
  read -rsp "Новий пароль: " NEW_PASS
  echo ""
  if [ -z "$NEW_PASS" ]; then
    echo "❌ Пароль не може бути порожнім"
    continue
  fi
  if [ ${#NEW_PASS} -lt 6 ]; then
    echo "❌ Пароль має бути не менше 6 символів"
    continue
  fi
  read -rsp "Підтвердіть пароль: " NEW_PASS2
  echo ""
  if [ "$NEW_PASS" != "$NEW_PASS2" ]; then
    echo "❌ Паролі не збігаються"
    continue
  fi
  break
done

# Генеруємо новий SESSION_SECRET
NEW_SECRET=$(openssl rand -hex 32)

# Записуємо або оновлюємо .env
touch "$ENV_FILE"

update_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}

update_env "AUTH_USER"      "$NEW_USER"
update_env "AUTH_PASS"      "$NEW_PASS"
update_env "SESSION_SECRET" "$NEW_SECRET"

echo ""
echo "✓ Дані оновлено в .env"
echo ""

# Перезапускаємо контейнер щоб підтягнути нові env
echo "▸ Перезапускаємо контейнер..."
docker compose up -d --force-recreate job-scraper

echo ""
echo "✓ Готово! Новий логін: ${NEW_USER}"
echo "  Всі активні сесії скинуто."
