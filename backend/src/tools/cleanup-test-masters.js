'use strict';

// Разовая уборка тестовых данных, оставшихся после проверок.
//
// В базе 14 мастеров вместо трёх: кроме сидовых Екатерины, Анны и Ольги там
// мастера, которых создали тестовые прогоны («Мастер снимка …», «Мастер А …»).
// Удаляем всех, кого нет в списке сида, вместе со всем, что на них ссылается:
// записи, удержания слотов, расписание и блокировки. Сидовых мастеров и их
// записи не трогаем.
//
// Запуск: node src/tools/cleanup-test-masters.js [--dry-run]
// С --dry-run скрипт только показывает, что собирается удалить.

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const config = require('../config');

// Ровно те, что создаёт backend/src/db/seed.js. Порядок как в сиде.
const SEED_MASTERS = ['Екатерина', 'Анна', 'Ольга'];

const dryRun = process.argv.includes('--dry-run');
const db = new DatabaseSync(config.dbPath);

const keepIds = db
  .prepare('SELECT id, name FROM masters')
  .all()
  .filter((m) => SEED_MASTERS.includes(m.name))
  .map((m) => m.id);

const extra = db
  .prepare('SELECT id, name FROM masters ORDER BY id')
  .all()
  .filter((m) => !keepIds.includes(m.id));

if (!keepIds.length) {
  console.error('Ни одного сидового мастера не найдено — останавливаюсь, чтобы не удалить всё.');
  process.exit(1);
}

console.log('Оставляю мастеров сида:');
db.prepare('SELECT id, name FROM masters ORDER BY id').all()
  .filter((m) => keepIds.includes(m.id))
  .forEach((m) => console.log('  #' + m.id + '  ' + m.name));

console.log('\nК удалению тестовых мастеров: ' + extra.length);
if (!extra.length) {
  console.log('  (нечего удалять)');
} else {
  extra.forEach((m) => {
    const bookings = db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE master_id = ?').get(m.id).n;
    const holds = db.prepare('SELECT COUNT(*) AS n FROM slot_holds WHERE master_id = ?').get(m.id).n;
    console.log('  #' + m.id + '  ' + m.name + '  — записей: ' + bookings + ', удержаний: ' + holds);
  });
}

if (dryRun) {
  console.log('\nЭто был --dry-run: ничего не удалено.');
  db.close();
  process.exit(0);
}

const ids = extra.map((m) => m.id);
const list = ids.join(', ');
let removed = { bookings: 0, booking_services: 0, holds: 0, hold_services: 0, schedule: 0, blocks: 0, services: 0, users: 0 };

db.exec('BEGIN');
try {
  if (ids.length) {
    // Порядок важен: сначала строки, ссылающиеся на мастера, потом сам мастер.
    removed.hold_services = db.prepare(
      'DELETE FROM hold_services WHERE hold_id IN (SELECT id FROM slot_holds WHERE master_id IN (' + list + '))'
    ).run().changes;
    removed.holds = db.prepare('DELETE FROM slot_holds WHERE master_id IN (' + list + ')').run().changes;

    removed.bookings = db.prepare('DELETE FROM bookings WHERE master_id IN (' + list + ')').run().changes;
    removed.booking_services = db.prepare(
      'DELETE FROM booking_services WHERE booking_id NOT IN (SELECT id FROM bookings)'
    ).run().changes;

    removed.schedule = db.prepare('DELETE FROM master_schedule WHERE master_id IN (' + list + ')').run().changes;
    removed.blocks = db.prepare('DELETE FROM work_blocks WHERE master_id IN (' + list + ')').run().changes;
    // Пользователи не удаляются: учётка мастера может остаться в системе, у неё
    // просто перестаёт быть мастер. users.master_id обнуляется.
    removed.users = db.prepare('UPDATE users SET master_id = NULL WHERE master_id IN (' + list + ')').run().changes;

    db.prepare('DELETE FROM master_services WHERE master_id IN (' + list + ')').run();
    db.prepare('DELETE FROM masters WHERE id IN (' + list + ')').run();
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('Откат, ничего не удалено: ' + err.message);
  db.close();
  process.exit(1);
}

console.log('\nУдалено:');
Object.entries(removed).forEach(([k, v]) => { if (v) console.log('  ' + k + ': ' + v); });
console.log('  мастеров: ' + ids.length);

console.log('\nОсталось мастеров:');
db.prepare('SELECT id, name, role, experience_years, is_active FROM masters ORDER BY id').all()
  .forEach((m) => console.log('  #' + m.id + '  ' + m.name + '  | ' + m.role + '  | активен=' + m.is_active));

db.close();