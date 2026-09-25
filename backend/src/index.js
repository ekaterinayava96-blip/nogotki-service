'use strict';

// Точка входа API: запускает стартовую последовательность (миграции, обработчики
// сбоев, graceful shutdown), открывает HTTP-сервер и фоновую чистку истёкших
// удержаний слотов.

const config = require('./config');
const { boot } = require('./startup');
const app = require('./app');
const q = require('./repo/queries');

const CLEANUP_INTERVAL_MS = 60 * 1000; // раз в минуту

function startCleanup() {
  const cleanup = () => {
    try {
      const removedHolds = q.purgeExpiredHolds();
      if (removedHolds > 0) console.log(`[holds] Удалено истёкших удержаний: ${removedHolds}`);
    } catch (err) {
      console.error('[holds] Ошибка очистки удержаний:', err);
    }
    try {
      const removedSessions = q.purgeExpiredSessions();
      if (removedSessions > 0) console.log(`[sessions] Удалено истёкших/отозванных сессий: ${removedSessions}`);
    } catch (err) {
      console.error('[sessions] Ошибка очистки сессий:', err);
    }
  };
  cleanup();
  const timer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
  timer.unref(); // не держим процесс из-за таймера
  return timer;
}

const server = app.listen(config.port, () => {
  console.log(`API запущен на порту ${config.port} (NODE_ENV=${config.nodeEnv}).`);
});

boot({ server });
startCleanup();

module.exports = { server };