'use strict';

// Сборка Express-приложения: JSON-парсер, маршруты, 404 и обработчик ошибок.

const express = require('express');
const path = require('path');

const config = require('./config');
const authRoutes = require('./routes/auth');
const catalogRoutes = require('./routes/catalog');
const holdsRoutes = require('./routes/holds');
const bookingRoutes = require('./routes/bookings');
const feedbackRoutes = require('./routes/feedback');
const adminRoutes = require('./routes/admin');

const app = express();

app.disable('x-powered-by');
// За reverse-proxy (nginx и т.п.) rate limit и req.ip должны видеть IP клиента,
// а не адрес прокси. Число доверенных прокси задаётся в TRUST_PROXY (.env).
if (config.trustProxy) {
  app.set('trust proxy', config.trustProxy);
}
app.use(express.json({ limit: '64kb' }));

// Для запросов без JSON-тела express.json оставляет req.body = undefined;
// приводим к {} — валидаторы во роутах безопасно обращаются к полям.
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

// Простой «ping» для проверки живости
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api', catalogRoutes);
app.use('/api', holdsRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/admin', adminRoutes);

// Боевой веб-фронтенд: статика из web/. Монтируется раньше чернового
// backend/public, чтобы корень '/' отдавал боевой лендинг (web/index.html).
app.use(express.static(path.join(__dirname, '..', '..', 'web')));

// Черновой тестовый фронтенд: статика из backend/public. Сервится тем же
// сервером, что и API (один origin — CORS не нужен), файл / -> index.html.
app.use(express.static(path.join(__dirname, '..', 'public')));

// 404
app.use((req, res) => {
  res.status(404).json({ error: { message: `Маршрут ${req.method} ${req.path} не найден.`, code: 'NOT_FOUND' } });
});

// Централизованный обработчик ошибок
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500) {
    console.error('[api] Ошибка:', err);
  }
  // Наружу не упускаем технические детали (текст ошибки БД/триггеров, стек,
  // внутренние пути). Для 4xx — то, что положили в err.message валидаторы и
  // маршруты; для 5xx — общее сообщение.
  const message = status >= 500
    ? 'Внутренняя ошибка сервера.'
    : (err.message || 'Ошибка запроса.');
  // Машиночитаемый код отдаём только для клиентских ошибок, которые его положили
  // (валидаторы, маршруты): фронт различает по нему HOLD_EXPIRED, SLOT_CONFLICT и т.п.
  const body = { error: { message } };
  if (status < 500 && typeof err.code === 'string') body.error.code = err.code;
  res.status(status).json(body);
});

module.exports = app;