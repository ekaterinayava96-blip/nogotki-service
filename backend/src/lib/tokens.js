'use strict';

// Подписанные токены доступа (JWT-подобные, HMAC-SHA256, без внешней
// зависимости). Секрет берётся из конфигурации AUTH_SECRET.
// Токен валиден AUTH_TTL_SECONDS; «выход» — через чёрный список jti.

const crypto = require('crypto');

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

function b64url(s) {
  return Buffer.from(s).toString('base64url');
}

function sign(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(`${HEADER}.${body}`).digest('base64url');
  return `${HEADER}.${body}.${sig}`;
}

function verify(token, secret) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) return null;
  const [h, b, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url');
  // Сравнение без утечки по времени
  const a = Buffer.from(sig);
  const e = Buffer.from(expected);
  if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) return null;
  try {
    const payload = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
    if (typeof payload !== 'object' || payload === null) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

module.exports = { sign, verify };