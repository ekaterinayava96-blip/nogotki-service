'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const config = require('../config');

// Гарантируем, что папка для файла БД существует
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

// Открываем базу; файл создаётся автоматически, если его нет.
// Встроенный node:sqlite (Node >= 22.13) — внешняя библиотека не нужна.
const db = new DatabaseSync(config.dbPath);

// PRAGMA-настройки: в node:sqlite нет метода .pragma(), задаём через exec
// Ждём до 5 с, пока блокировка записи освободится, вместо мгновенного
// падения с SQLITE_BUSY при одновременных записях от двух процессов
db.exec('PRAGMA busy_timeout = 5000');

// FK в SQLite выключены по умолчанию — включаем при каждом подключении
db.exec('PRAGMA foreign_keys = ON');

// Мягкий режим WAL: читатели и писатель не блокируют друг друга
db.exec('PRAGMA journal_mode = WAL');

// WAL + NORMAL: быстрее FULL; при сбое ОС/питания база остаётся целостной
// (откатиться может только самая свежая транзакция)
db.exec('PRAGMA synchronous = NORMAL');

// Совместимость с API better-sqlite3: db.transaction(fn) возвращает функцию,
// которая выполняет fn внутри транзакции с COMMIT/ROLLBACK.
//
// BEGIN IMMEDIATE, а не BEGIN: обычный BEGIN (дефолтный BEGIN DEFERRED) не берёт
// блокировку на запись до первой вставки/обновления. Два параллельных запроса
// на создание записи могли бы оба прочитать «слот свободен» и только потом
// конкурировать на записи. BEGIN IMMEDIATE снимает RESERVED-блокировку сразу:
// второй процесс будет ждать (busy_timeout) завершения первого, затем его
// триггер/уникальный индекс увидят уже закоммиченную конфликтующую запись и
// отдадут ошибку вместо тихого задвоения.
db.transaction = (fn) => (...args) => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(...args);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
};

module.exports = db;