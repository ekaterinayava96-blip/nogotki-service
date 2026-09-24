'use strict';

// Пересоздание базы с нуля: закрывает подключение, удаляет файл БД
// (и побочные файлы WAL), затем заново применяет все миграции.
// ВНИМАНИЕ: все данные будут безвозвратно удалены.

const fs = require('fs');
const config = require('../config');

if (config.nodeEnv === 'production') {
  console.error('[db:reset] Запрещено в production: команда безвозвратно удаляет базу данных.');
  process.exit(1);
}

// Закрыть текущее подключение, чтобы файл можно было удалить
try {
  const db = require('./connection');
  db.close();
  delete require.cache[require.resolve('./connection')];
} catch (_) {
  // подключения ещё не было — не страшно
}

// Удалить файл БД и его WAL-побочники
for (const suffix of ['', '-wal', '-shm']) {
  const file = config.dbPath + suffix;
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    console.log('Удалён:', file);
  }
}

// Применить миграции заново
const { run } = require('./runMigrations');
run();

console.log('База пересоздана с нуля.');