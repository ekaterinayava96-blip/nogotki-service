'use strict';

// Разовая утилита: создать пользователя с ролью прямо в базе.
// Запуск: node src/tools/create-user.js <логин> <пароль> <роль> [имя] [телефон]
//
// Зачем отдельный инструмент: роль owner назначается ТОЛЬКО в базе данных.
// Ни форма регистрации, ни какой-либо эндпоинт её не выдают — POST
// /api/auth/register жёстко пишет роль client. Поэтому завести администратора
// можно лишь таким скриптом, в обход API.
//
// Пароль хешируется тем же hashPassword, что и при регистрации, — открытым
// текстом он в базе не лежит.

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const { hashPassword } = require('../lib/passwords');
const config = require('../config');
const { toDbLocal } = require('../lib/time');

const ALLOWED_ROLES = ['client', 'master', 'owner'];
const USERNAME_RE = /^[a-zA-Z0-9_.]{3,32}$/;

function fail(message) {
  console.error('Ошибка: ' + message);
  process.exit(1);
}

const [username, password, role, name, phone] = process.argv.slice(2);

if (!username || !password || !role) {
  console.error('Использование: node src/tools/create-user.js <логин> <пароль> <роль> [имя] [телефон]');
  console.error('Роли: ' + ALLOWED_ROLES.join(', '));
  process.exit(1);
}

// Те же правила, что на сервере: логин 3–32 символа, пароль не короче 8,
// роль из списка. Иначе созданного пользователя нельзя было бы войти.
if (!USERNAME_RE.test(username)) {
  fail('логин: только латиница, цифры, «_» и «.», от 3 до 32 символов');
}
if (String(password).length < 8) {
  fail('пароль должен быть не короче 8 символов');
}
if (!ALLOWED_ROLES.includes(role)) {
  fail('роль должна быть одной из: ' + ALLOWED_ROLES.join(', '));
}

const db = new DatabaseSync(config.dbPath);

const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (existing) {
  fail(`логин «${username}» уже занят`);
}

const now = toDbLocal(new Date());

// У мастера есть строка в masters, на которую ссылается users.master_id.
// Профиль клиента лежит в clients и связан с пользователем через
// clients.user_id — отдельной client_id в users нет.
// Владельцу (owner) не нужно ни то, ни другое: его кабинет закрыт, а записи
// он смотрит все студии, а не свои.
const masterId = role === 'master' ? insertMaster(name, now) : null;

const info = db.prepare(
  'INSERT INTO users (username, password_hash, master_id, is_active, last_login_at)' +
  ' VALUES (?, ?, ?, 1, NULL)'
).run(username, hashPassword(password), masterId);
const userId = Number(info.lastInsertRowid);

db.prepare('INSERT INTO user_roles (user_id, role) VALUES (?, ?)').run(userId, role);

// Клиентский профиль обязателен для client: без него кабинет не найдёт имя и
// телефон для приветствия и контактов записи.
const clientId = role === 'client' ? insertClient(name, phone, now, userId) : null;

const row = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
const roles = db.prepare('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role').all(userId).map((r) => r.role);

console.log('Создан пользователь:');
console.log('  id       ' + row.id);
console.log('  логин    ' + row.username);
console.log('  роли     ' + roles.join(', '));
if (clientId) console.log('  client_id ' + clientId);
if (masterId) console.log('  master_id ' + masterId);
console.log('  пароль   ' + password + ' (в базе хранится только scrypt-хеш)');

function insertClient(clientName, clientPhone, ts, userId) {
  const nm = String(clientName || username).trim();
  const ph = String(clientPhone || '').trim();
  if (!nm) fail('для роли client нужно имя');
  if (!/^\+7\d{10}$/.test(ph)) {
    fail('для роли client нужен телефон в формате +7 и 10 цифр, например +79001234567');
  }
  if (db.prepare('SELECT id FROM clients WHERE phone = ?').get(ph)) {
    fail('телефон ' + ph + ' уже привязан к другому клиенту');
  }
  const info = db.prepare(
    'INSERT INTO clients (name, phone, user_id, created_at) VALUES (?, ?, ?, ?)'
  ).run(nm, ph, userId, ts);
  return Number(info.lastInsertRowid);
}

function insertMaster(masterName, ts) {
  const nm = String(masterName || username).trim();
  const info = db.prepare(
    'INSERT INTO masters (name, role, experience_years, photo_path, is_active, created_at)' +
    " VALUES (?, 'Мастер', 0, NULL, 1, ?)"
  ).run(nm, ts);
  return Number(info.lastInsertRowid);
}