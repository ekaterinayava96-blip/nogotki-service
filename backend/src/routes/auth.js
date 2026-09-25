'use strict';

// Регистрация, вход, выход.

const express = require('express');
const bcrypt = require('bcryptjs');

const db = require('../db/connection');
const q = require('../repo/queries');
const v = require('../lib/validate');
const { asyncH } = require('../lib/http');
const { issueToken, revokeJti, authRequired } = require('../middleware/auth');
const { nowDbLocal } = require('../lib/time');

const router = express.Router();

// Регистрация клиентского аккаунта: создаёт users(role=client) и профиль clients.
// Открытая регистрация только с ролью client; мастера/владельца заводит админ.
router.post(
  '/register',
  asyncH(async (req, res) => {
    const username = v.username(req.body.username);
    const password = v.password(req.body.password);
    const name = v.name(req.body.name);
    const phone = v.phone(req.body.phone);

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

    const hash = bcrypt.hashSync(password, 12);
    const userId = db
      .prepare("INSERT INTO users (username, password_hash, role, is_active) VALUES (?, ?, 'client', 1)")
      .run(username, hash).lastInsertRowid;
    const clientId = db
      .prepare("INSERT INTO clients (name, phone, user_id, created_at) VALUES (?, ?, ?, ?)")
      .run(name, phone, userId, nowDbLocal()).lastInsertRowid;

    const token = issueToken({ id: userId, role: 'client', username });
    return res.status(201).json({
      token,
      user: { id: userId, username, role: 'client', client_id: clientId },
    });
  })
);

// Вход по логину и паролю
router.post(
  '/login',
  asyncH(async (req, res) => {
    const username = v.username(req.body.username);
    const password = v.password(req.body.password);

    const user = q.userByUsername(username);
    if (!user || user.is_active !== 1 || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({
        error: { message: 'Неверный логин или пароль.', code: 'INVALID_CREDENTIALS' },
      });
    }
    q.touchLastLogin(user.id);
    const token = issueToken(user);
    const clientId = user.role === 'client' ? q.clientIdForUser(user.id) : null;
    return res.json({ token, user: q.publicUser(user, { clientId }) });
  })
);

// Выход: токен попадает в чёрный список до конца срока действия
router.post('/logout', authRequired, asyncH(async (req, res) => {
  const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const parts = token.split('.');
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload.jti) revokeJti(payload.jti);
  } catch (_) { /* токен уже не валиден */ }
  return res.status(204).end();
}));

module.exports = router;