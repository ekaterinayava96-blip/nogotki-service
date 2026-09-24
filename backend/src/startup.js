'use strict';

// Боевая стартовая последовательность:
//   1) валидация конфигурации (config.js бросает ошибку при проблемах в проде);
//   2) миграции — ДО приёма запросов: нет готовой схемы — процесс падает сразу;
//   3) глобальные обработчики сбоев процесса;
//   4) при переданном server — корректная остановка по SIGTERM/SIGINT.
//
// Подключение из src/index.js (когда появится HTTP-сервер):
//   const { boot } = require('./startup');
//   const server = app.listen(config.port);
//   boot({ server });
//
// Автономная проверка старта (деплой-смоук): npm run start:check

const config = require('./config');
const migrations = require('./db/runMigrations');

let booted = false;

function boot({ server } = {}) {
  if (booted) return;
  booted = true;

  migrations.run();
  installProcessHandlers();
  if (server) installGracefulShutdown(server);

  console.log(`Стартовая подготовка завершена (NODE_ENV=${config.nodeEnv}).`);
}

function installProcessHandlers() {
  // Необработанная ошибка = аварийный выход с кодом 1, чтобы супервизор
  // (PM2/systemd) перезапустил процесс, а не держал «полуживой».
  process.on('uncaughtException', (err) => {
    console.error('[fatal] uncaughtException:', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandledRejection:', reason);
    process.exit(1);
  });
}

function installGracefulShutdown(server) {
  const db = require('./db/connection');
  let closing = false;

  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`Получен ${signal} — корректно останавливаюсь…`);

    const timer = setTimeout(() => {
      console.error('Таймаут остановки (5 с) — принудительный выход.');
      process.exit(1);
    }, 5000);
    timer.unref();

    server.close(() => {
      try {
        db.close();
      } catch (_) {
        // БД уже закрыта — не мешаем завершению
      }
      clearTimeout(timer);
      console.log('Остановлено.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  boot();
  require('./db/connection').close();
  console.log('Смоук-проверка пройдена: конфигурация и миграции в порядке.');
}

module.exports = { boot };
