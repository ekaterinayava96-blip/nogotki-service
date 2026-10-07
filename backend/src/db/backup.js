'use strict';

// Резервная копия базы + расписание.
//
// Раньше копия снималась только вручную: условие `require.main === module`
// пропускало вызов, когда скрипт запускали как программу, и больше
// копирование не вызывалось НИГДЕ. Планировщик ОС был описан лишь в
// комментарии и на сервере не настроен — копий не существовало вовсе.
// Теперь приложение снимает копию само, по расписанию из переменных окружения.
//
// Ручной запуск по-прежнему работает: npm run db:backup / node src/db/backup.js

const fs = require('fs');
const path = require('path');

const config = require('../config');
const db = require('./connection');

// Сколько последних копий хранить. Переопределяется BACKUP_KEEP,
// по умолчанию 14 — две недели ежедневных копий.
const KEEP = config.backupKeep;

function backupDir() {
  return path.join(path.dirname(config.dbPath), 'backups');
}

async function backup() {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const target = path.join(dir, `nogotki-${stamp}.db`);
  if (fs.existsSync(target)) fs.unlinkSync(target);

  // node:sqlite не имеет db.backup(); VACUUM INTO даёт консистентную копию
  // работающей базы без её остановки.
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  console.log('[db:backup] Бэкап создан:', target);

  // Ретеншн: оставляем KEEP самых свежих (имена сортируются хронологично)
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('nogotki-') && f.endsWith('.db'))
    .sort();
  while (files.length > KEEP) {
    const old = files.shift();
    fs.unlinkSync(path.join(dir, old));
    console.log('[db:backup] Удалён старый бэкап:', old);
  }
  return target;
}

// Расписание внутри приложения.
//
// setInterval, а не цепочка setTimeout: сбои не должны копиться, а при ошибке
// копирование просто повторится на следующем интервале. Таймер помечен
// unref(), чтобы не держать процесс — как и таймер чистки в index.js.
function startBackupSchedule() {
  const hours = config.backupIntervalHours;
  const dir = backupDir();

  if (!hours) {
    console.log('[db:backup] Расписание отключено (BACKUP_INTERVAL_HOURS=0).');
    return null;
  }
  if (!fs.existsSync(path.dirname(config.dbPath))) {
    console.error('[db:backup] Каталога с базой нет, расписание не запущено:',
      path.dirname(config.dbPath));
    return null;
  }
  // Копий ещё не было ни разу — сообщаем, что папка появится при первом запуске.
  if (!fs.existsSync(dir)) {
    console.log('[db:backup] Папка копий будет создана при первом копировании:', dir);
  }

  const run = async (reason) => {
    try {
      await backup();
    } catch (err) {
      // Сбой копирования не должен ронять сервис: теряется одна копия,
      // а не работающий сайт. Пишем в журнал и ждём следующего интервала.
      console.error(`[db:backup] Ошибка копирования (${reason}):`,
        err && err.message ? err.message : err);
    }
  };

  if (config.backupOnStart) {
    // Не ждём: первый прогон не должен задерживать открытие порта.
    setImmediate(() => run('при старте'));
  }

  const timer = setInterval(() => run('по расписанию'), hours * 60 * 60 * 1000);
  timer.unref();
  console.log(`[db:backup] Копирование включено: раз в ${hours} ч., храним ${KEEP} копий.`);
  return timer;
}

if (require.main === module) {
  backup()
    .then(() => db.close())
    .catch((err) => {
      console.error('[db:backup] Ошибка:', err);
      process.exit(1);
    });
}

module.exports = { backup, startBackupSchedule };