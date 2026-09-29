'use strict';

// Регистрация, вход, выход.
// Пароли хешируются встроенным crypto.scrypt (либ. passwords), токены —
// случайные, в БД только их SHA-256. Вход/регистрация ограничены по частоте.
// Роль клиенту выбрать НЕЛЬЗЯ: открытая регистрация всегда создаёт 'client'
// (лишние поля тела запроса отбрасываются).

const express = require('express');

const db = require('../db/connection');
const q = require('../repo/queries');
const v = require('../lib/validate');
const { hashPassword, verifyPassword, DUMMY_HASH } = require('../lib/passwords');
const { asyncH } = require('../lib/http');
const {
  issueToken, revokeToken, authRequired, extract, setSessionCookie, clearSessionCookie,
} = require('../middleware/auth');
const { createLimiter } = require('../middleware/rateLimit');
const { nowDbLocal } = require('../lib/time');

const router = express.Router();

const loginLimiter = createLimiter({ windowMs: 60 * 1000, max: 5 });
const registerLimiter = createLimiter({ windowMs: 60 * 1000, max: 5 });

// Ключ rate limit по логину: «IP:username». IP включён в ключ намеренно —
// иначе несколько атакующих с разных адресов могли бы «заморозить» вход
// жертвы на окно лимита (pre-auth DoS). Сам IP уже ограничен лимитером-
// мидлварой (max=5/мин), поэтому в защите от подбора ничего не теряем.
function loginKey(req, username) {
  return `${(req.ip || req.socket.remoteAddress || 'unknown')}:${String(username).toLowerCase()}`;
}

// Регистрация клиентского аккаунта: users + роль client + профиль clients.
router.post('/register', registerLimiter, asyncH(async (req, res) => {
  const username = v.username(req.body.username);
  const password = v.password(req.body.password);
  const name = v.name(req.body.name);
  const phone = v.phone(req.body.phone);

  if (!registerLimiter.allowKeyed(loginKey(req, username))) {
    return res.status(429).json({
      error: { message: 'Слишком много попыток. Попробуйте позже.', code: 'RATE_LIMITED' },
    });
  }

  if (q.userByUsername(username)) {
    return res.status(409).json({
      error: { message: 'Логин уже занят.', code: 'USERNAME_TAKEN' },
    });
  }
  if (db.prepare('SELECT 1 AS hit FROM clients WHERE phone = ?').get(phone)) {
    return res.status(409).json({
      error: { message: 'Телефон уже зарегистрирован.', code: 'PHONE_TAKEN' },
    });
  }

  const userId = db.transaction(() => {
    const uid = db
      .prepare("INSERT INTO users (username, password_hash, is_active) VALUES (?, ?, 1)")
      .run(username, hashPassword(password)).lastInsertRowid;
    db.prepare("INSERT INTO user_roles (user_id, role) VALUES (?, 'client')").run(Number(uid));
    db.prepare('INSERT INTO clients (name, phone, user_id, created_at) VALUES (?, ?, ?, ?)')
      .run(name, phone, Number(uid), nowDbLocal());
    return uid;
  })();

  const token = issueToken({ id: userId, username });
  // Веб-фронт не хранит токен: сессия доезжает до браузера в httpOnly-куке.
  setSessionCookie(res, token);
  return res.status(201).json({
    token,
    user: { id: userId, username, roles: ['client'], client_id: q.clientIdForUser(userId) },
  });
}));

// Вход по логину и паролю
router.post('/login', loginLimiter, asyncH(async (req, res) => {
  const username = v.username(req.body.username);
  const password = v.password(req.body.password);

  if (!loginLimiter.allowKeyed(loginKey(req, username))) {
    return res.status(429).json({
      error: { message: 'Слишком много попыток. Попробуйте позже.', code: 'RATE_LIMITED' },
    });
  }

  const user = q.userByUsername(username);
  // При несуществующем/неактивном логине проверяем «пустышку» DUMMY_HASH:
  // scrypt считается в любом случае, и по времени ответа нельзя определить,
  // существует ли такой аккаунт (защита от username-энумерации через timing).
  const storedHash = user && user.is_active === 1 ? user.password_hash : DUMMY_HASH;
  if (!verifyPassword(password, storedHash)) {
    return res.status(401).json({
      error: { message: 'Неверный логин или пароль.', code: 'INVALID_CREDENTIALS' },
    });
  }
  q.touchLastLogin(user.id);
  const roles = q.userRoles(user.id);
  const clientId = roles.includes('client') ? q.clientIdForUser(user.id) : null;
  const token = issueToken(user);
  // Кука как транспорт сессии для веб-фронта (токен на клиенте не хранится).
  setSessionCookie(res, token);
  return res.json({ token, user: q.publicUser(user, { roles, clientId }) });
}));

// Кто я: текущий пользователь по куке/Bearer. Нужен веб-фронту, чтобы «помнить»
// пользователя между страницами без хранения токена на клиенте (localStorage).
router.get('/me', authRequired, asyncH(async (req, res) => {
  const roles = req.user.roles;
  const clientId = roles.includes('client') ? q.clientIdForUser(req.user.id) : null;
  const user = q.publicUser(req.user, { roles, clientId });
  // Данные клиента из БД: имя для приветствия на кабинете, телефон — для
  // формы подтверждения записи (Booking 04). Отдаём оба, иначе клиент без
  // записей пришёл бы на экран с пустым телефоном и вводил его заново.
  if (clientId) {
    const client = q.clientById(clientId);
    if (client) {
      user.client_name = client.name;
      user.client_phone = client.phone;
    }
  }
  return res.json({ user });
}));

// PATCH /auth/me — контакты клиента (имя, телефон) из формы подтверждения
// записи (Booking 04). Меняются только свои данные и только у роли client:
// у мастера и владельца профиля клиента нет, поэтому такой правке не под что.
// Поля необязательные — приходят только изменённые, остальные не затираются.
router.patch('/me', authRequired, asyncH(async (req, res) => {
  const clientId = q.clientIdForUser(req.user.id);
  if (!clientId) {
    return res.status(403).json({
      error: { message: 'Изменять контакты может только клиент.', code: 'FORBIDDEN' },
    });
  }

  const body = req.body || {};
  const name = body.name === undefined ? undefined : v.name(body.name);
  const phone = body.phone === undefined ? undefined : v.phone(body.phone);
  if (name === undefined && phone === undefined) {
    return res.status(400).json({
      error: { message: 'Передайте name или phone.', code: 'NOTHING_TO_UPDATE' },
    });
  }

  // Телефон уникален в БД, поэтому занятый проверяем сами: без этой проверки
  // клиент получил бы 500 от UNIQUE-ограничения вместо понятного ответа.
  if (phone !== undefined) {
    const taken = db
      .prepare('SELECT 1 AS hit FROM clients WHERE phone = ? AND id != ?')
      .get(phone, clientId);
    if (taken) {
      return res.status(409).json({
        error: { message: 'Телефон уже зарегистрирован.', code: 'PHONE_TAKEN' },
      });
    }
  }

  const client = q.updateClient(clientId, { name, phone });
  const user = q.publicUser(req.user, { roles: req.user.roles, clientId });
  // user отдаём с обновлёнными контактами — тем же, что и client: иначе
  // вызывающий код, читающий только user, получил бы старый телефон.
  return res.json({
    client: { id: client.id, name: client.name, phone: client.phone },
    user: { ...user, client_name: client.name, client_phone: client.phone },
  });
}));

// Выход: сессия отзывается в БД (revoked_at) сразу — до срока действия.
// Токен берём из Bearer или куки; куку снимаем.
router.post('/logout', authRequired, asyncH(async (req, res) => {
  revokeToken(extract(req));
  clearSessionCookie(res);
  return res.status(204).end();
}));

module.exports = router;