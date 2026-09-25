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
const { hashPassword, verifyPassword } = require('../lib/passwords');
const { asyncH } = require('../lib/http');
const { issueToken, revokeToken, authRequired } = require('../middleware/auth');
const { createLimiter } = require('../middleware/rateLimit');
const { nowDbLocal } = require('../lib/time');

const router = express.Router();

const loginLimiter = createLimiter({ windowMs: 60 * 1000, max: 5 });
const registerLimiter = createLimiter({ windowMs: 60 * 1000, max: 5 });

// Регистрация клиентского аккаунта: users + роль client + профиль clients.
router.post('/register', registerLimiter, asyncH(async (req, res) => {
  const username = v.username(req.body.username);
  const password = v.password(req.body.password);
  const name = v.name(req.body.name);
  const phone = v.phone(req.body.phone);

  if (!registerLimiter.allowKeyed(`login:${username.toLowerCase()}`)) {
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
  return res.status(201).json({
    token,
    user: { id: userId, username, roles: ['client'], client_id: q.clientIdForUser(userId) },
  });
}));

// Вход по логину и паролю
router.post('/login', loginLimiter, asyncH(async (req, res) => {
  const username = v.username(req.body.username);
  const password = v.password(req.body.password);

  if (!loginLimiter.allowKeyed(`login:${username.toLowerCase()}`)) {
    return res.status(429).json({
      error: { message: 'Слишком много попыток. Попробуйте позже.', code: 'RATE_LIMITED' },
    });
  }

  const user = q.userByUsername(username);
  if (!user || user.is_active !== 1 || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({
      error: { message: 'Неверный логин или пароль.', code: 'INVALID_CREDENTIALS' },
    });
  }
  q.touchLastLogin(user.id);
  const roles = q.userRoles(user.id);
  const clientId = roles.includes('client') ? q.clientIdForUser(user.id) : null;
  const token = issueToken(user);
  return res.json({ token, user: q.publicUser(user, { roles, clientId }) });
}));

// Выход: сессия отзывается в БД (revoked_at) сразу — до срока действия.
router.post('/logout', authRequired, asyncH(async (req, res) => {
  const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  revokeToken(token);
  return res.status(204).end();
}));

module.exports = router;