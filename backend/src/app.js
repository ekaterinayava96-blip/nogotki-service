'use strict';

// Сборка Express-приложения: JSON-парсер, маршруты, 404 и обработчик ошибок.

const express = require('express');

const authRoutes = require('./routes/auth');
const catalogRoutes = require('./routes/catalog');
const holdsRoutes = require('./routes/holds');
const bookingRoutes = require('./routes/bookings');
const adminRoutes = require('./routes/admin');

const app = express();

app.disable('x-powered-by');
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
app.use('/api', bookingRoutes);
app.use('/api/admin', adminRoutes);

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
  res.status(status).json({ error: { message } });
});

module.exports = app;