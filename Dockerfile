# Dockerfile — образ для job-scraper
# Multi-stage не нужен — нет компиляции

FROM node:20-alpine

# Рабочая директория
WORKDIR /app

# Зависимости для better-sqlite3 (нативный модуль, нужен компилятор)
RUN apk add --no-cache python3 make g++

# Сначала копируем package.json — кешируем зависимости
COPY package*.json ./
RUN npm ci --omit=dev

# Исходный код
COPY . .

# Папка для БД (монтируется как volume)
RUN mkdir -p /app/data

# Непривилегированный пользователь
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

# Порт приложения
EXPOSE 3333

# Проверка здоровья: HTTP запрос к себе
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://localhost:3333/ | grep -q 'DevOps Jobs' || exit 1

CMD ["node", "src/server.js"]
