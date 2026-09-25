'use strict';

// Аутентификация и авторизация. Токен: «Authorization: Bearer <random>».
// Сам токен клиенту выдаётся один раз и нигде не сохраняется полностью:
// в БД (auth_sessions) лежит только его SHA-256 + срок действия + отзыв.
// Роли читаются из user_roles на КАЖДЫЙ запрос — не из payload токена и
// не из данных запроса. Права: «есть ли у пользователя нужная роль».

const crypto = require('crypto');

const config = require('../config');
const q = require('../repo/queries');
const { toDbLocal } = require('../lib/time');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

// Выпуск сессии: создаёт случайный токен, в БД кладёт его хеш + срок жизни.
function issueToken(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = sha256Hex(token);
  const expiresAtLocal = toDbLocal(
    new Date(Date.now() + config.authTtlSeconds * 1000)
  );
  q.createSession({
    userId: user.id,
    tokenHash,
    expiresAtLocal,
  });
  return token;
}

function extract(req) {
  const h = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

// Проверка токена по БД. Роли загружаются каждый раз из user_roles.
function authenticate(req) {
  const token = extract(req);
  if (!token) return null;
  const session = q.sessionByTokenHash(sha256Hex(token));
  if (!session) return null;
  const user = q.userById(session.user_id);
  if (!user || user.is_active !== 1) return null;
  req.user = {
    id: user.id,
    username: user.username,
    roles: q.userRoles(user.id),
    master_id: user.master_id,
    is_active: !!user.is_active,
  };
  return req.user;
}

// «Есть ли у пользователя роль» (роли — список).
function hasRole(user, role) {
  return !!user && Array.isArray(user.roles) && user.roles.includes(role);
}

// Требует вход; иначе 401
function authRequired(req, res, next) {
  const user = authenticate(req);
  if (!user) {
    return res.status(401).json({ error: { message: 'Требуется авторизация.', code: 'UNAUTHORIZED' } });
  }
  req.user = user;
  next();
}

// Требует вход и НАЛИЧИЕ хотя бы одной из ролей; иначе 403
function requireRole(...roles) {
  return (req, res, next) => {
    const user = authenticate(req);
    if (!user) {
      return res.status(401).json({ error: { message: 'Требуется авторизация.', code: 'UNAUTHORIZED' } });
    }
    req.user = user;
    const ok = roles.some((r) => hasRole(user, r));
    if (!ok) {
      return res.status(403).json({ error: { message: 'Недостаточно прав.', code: 'FORBIDDEN' } });
    }
    next();
  };
}

// Отзыв сессии по выданному (нехешированному) токену.
function revokeToken(token) {
  if (typeof token !== 'string' || token === '') return;
  q.revokeSessionByTokenHash(sha256Hex(token));
}

module.exports = {
  issueToken,
  extract,
  authenticate,
  hasRole,
  revokeToken,
  authRequired,
  requireRole,
};