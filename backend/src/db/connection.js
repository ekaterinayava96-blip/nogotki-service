'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const config = require('../config');

// Гарантируем, что папка для файла БД существует
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

// Открываем базу; файл создаётся автоматически, если его нет
const db = new Database(config.dbPath);

// Ждём до 5 с, пока блокировка записи освободится, вместо мгновенного
// падения с SQLITE_BUSY при одновременных записях от двух процессов
db.pragma('busy_timeout = 5000');

// FK в SQLite выключены по умолчанию — включаем при каждом подключении
db.pragma('foreign_keys = ON');

// Мягкий режим WAL: читатели и писатель не блокируют друг друга
db.pragma('journal_mode = WAL');

// WAL + NORMAL: быстрее FULL; при сбое ОС/питания база остаётся целостной
// (откатиться может только самая свежая транзакция)
db.pragma('synchronous = NORMAL');

module.exports = db;