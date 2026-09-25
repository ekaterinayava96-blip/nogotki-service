'use strict';

// Аутентификация и авторизация. Токен: «Authorization: Bearer <jwt>».
// В payload: sub (id пользователя), role, username, jti, iat, exp.

const config = require('../config');
const { sign, verify } = require('../lib/tokens');

// Чёрный список отозванных jti (для «выхода»): до их срока действия.
// Память процесса: на самом деле достаточно, т.к. токены короткоживущие.
const revoked = new Map();

function secret() {
  if (!config.authSecret) {
    throw new Error('[auth] AUTH_SECRET не задан — API не может выпускать токены.');
  }
  return config.authSecret;
}

function issueToken(user) {
  const jti = require('crypto').randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: user.id,
    role: user.role,
    username: user.username,
    jti,
    iat: now,
    exp: now + config.authTtlSeconds,
  };
  return sign(payload, secret());
}

function revokeJti(jti) {
  if (typeof jti !== 'string') return;
  revoked.set(jti, Date.now());
}

function extract(req) {
  const h = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

function authenticate(req) {
  const token = extract(req);
  if (!token) return null;
  const payload = verify(token, secret());
  if (!payload) return null;
  if (revoked.has(payload.jti)) return null;
  if (isExpired(payload)) return null;
  if (typeof payload.sub !== 'number' && typeof payload.sub !== 'string') return null;
  req.user = { id: payload.sub, role: payload.role, username: payload.username };
  return req.user;
}

function isExpired(payload) {
  const now = Math.floor(Date.now() / 1000);
  return typeof payload.exp !== 'number' || now >= payload.exp;
}

// Требует вход; иначе 401
function authRequired(req, res, next) {
  const user = authenticate(req);
  if (!user) {
    return res.status(401).json({ error: { message: 'Требуется авторизация.', code: 'UNAUTHORIZED' } });
  }
  next();
}

// Требует вход и одну из ролей; иначе 403
function requireRole(...roles) {
  return (req, res, next) => {
    const user = authenticate(req);
    if (!user) {
      return res.status(401).json({ error: { message: 'Требуется авторизация.', code: 'UNAUTHORIZED' } });
    }
    req.user = user;
    if (!roles.includes(user.role)) {
      return res.status(403).json({ error: { message: 'Недостаточно прав.', code: 'FORBIDDEN' } });
    }
    next();
  };
}

module.exports = {
  issueToken,
  revokeJti,
  authRequired,
  requireRole,
};