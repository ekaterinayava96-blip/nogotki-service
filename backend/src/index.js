'use strict';

// Точка входа API: запускает стартовую последовательность (миграции, обработчики
// сбоев, graceful shutdown), открывает HTTP-сервер и фоновую чистку истёкших
// удержаний слотов.

const config = require('./config');
const { boot } = require('./startup');
const app = require('./app');
const q = require('./repo/queries');

if (!config.authSecret) {
  console.error('[api] AUTH_SECRET не задан — поставьте его в backend/.env (см. .env.example).');
  process.exit(1);
}

const HOLD_CLEANUP_INTERVAL_MS = 60 * 1000; // раз в минуту

function startHoldCleanup() {
  const cleanup = () => {
    try {
      const removed = q.purgeExpiredHolds();
      if (removed > 0) console.log(`[holds] Удалено истёкших удержаний: ${removed}`);
    } catch (err) {
      console.error('[holds] Ошибка очистки удержаний:', err);
    }
  };
  cleanup();
  const timer = setInterval(cleanup, HOLD_CLEANUP_INTERVAL_MS);
  timer.unref(); // не держим процесс из-за таймера
  return timer;
}

const server = app.listen(config.port, () => {
  console.log(`API запущен на порту ${config.port} (NODE_ENV=${config.nodeEnv}).`);
});

boot({ server });
startHoldCleanup();

module.exports = { server };