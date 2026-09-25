'use strict';

// Простой раннер миграций: применяет .sql файлы из папки migrations/ в
// алфавитном порядке и запоминает применённые в таблице schema_migrations.
// Повторный запуск безопасен: уже применённые миграции пропускаются.

const fs = require('fs');
const path = require('path');

const db = require('./connection');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function appliedMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name      TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  return db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name);
}

function run() {
  const applied = new Set(appliedMigrations());
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // Миграция 004 пересоздаёт таблицу bookings (DROP TABLE + ALTER RENAME).
  // Чтобы это было безопасно при внешних ключах (payments -> bookings),
  // FK временно отключаем на весь прогон — иначе DROP TABLE с referencing
  // строками завершится ошибкой ограничения. После прогона включаем обратно.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip   ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
          file,
          new Date().toISOString()
        );
      })();
      console.log(`apply  ${file}`);
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

if (require.main === module) {
  run();
  console.log('Миграции завершены: база готова.');
}

module.exports = { run };