'use strict';

// Резервная копия базы в отдельный файл + хранение последних 14 копий.
// Запуск: npm run db:backup
// По расписанию (ежедневно, например в 03:00):
//   cron:      0 3 * * * cd /путь/к/backend && npm run db:backup
//   Windows:   Планировщик заданий → действие node src\db\backup.js

const fs = require('fs');
const path = require('path');

const config = require('../config');
const db = require('./connection');

const KEEP = 14; // храним 2 недели ежедневных копий

async function backup() {
  const dir = path.join(path.dirname(config.dbPath), 'backups');
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const target = path.join(dir, `nogotki-${stamp}.db`);
  if (fs.existsSync(target)) fs.unlinkSync(target);

  // node:sqlite не имеет db.backup(); VACUUM INTO даёт консистентную копию
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  console.log('Бэкап создан:', target);

  // Ретеншн: оставляем KEEP самых свежих (имена сортируются хронологично)
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('nogotki-') && f.endsWith('.db'))
    .sort();
  while (files.length > KEEP) {
    const old = files.shift();
    fs.unlinkSync(path.join(dir, old));
    console.log('Удалён старый бэкап:', old);
  }
}

if (require.main === module) {
  backup()
    .then(() => db.close())
    .catch((err) => {
      console.error('[db:backup] Ошибка:', err);
      process.exit(1);
    });
}

module.exports = { backup };
