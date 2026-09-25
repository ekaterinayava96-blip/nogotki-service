'use strict';

// Простейший ограничитель частоты запросов (окно в памяти процесса).
// Защищает критичные точки входа (логин, регистрация) от подбора/спама.
// Ключ — IP клиента; для login/register дополнительно ключ по login.

function createLimiter({ windowMs = 60 * 1000, max = 5 } = {}) {
  const hits = new Map(); // key -> { firstTs, count }
  let lastPurge = 0;

  // Карта не должна расти бесконечно при спаме с уникальных ключей (IP/логинов):
  // раз в окно удаляем записи, чьё окно уже истекло.
  function prune(now) {
    if (now - lastPurge < windowMs) return;
    lastPurge = now;
    for (const [key, rec] of hits) {
      if (now - rec.firstTs >= windowMs) hits.delete(key);
    }
  }

  function allow(key) {
    const now = Date.now();
    prune(now);
    const rec = hits.get(key);
    if (!rec || now - rec.firstTs >= windowMs) {
      hits.set(key, { firstTs: now, count: 1 });
      return true;
    }
    rec.count += 1;
    return rec.count <= max;
  }

  function limiter(req, res, next) {
    const ip = (req.ip || req.socket.remoteAddress || 'unknown').toString();
    if (!allow(ip)) {
      return res.status(429).json({
        error: { message: 'Слишком много попыток. Попробуйте позже.', code: 'RATE_LIMITED' },
      });
    }
    next();
  }

  // Ключ с включением логина: атака с разных IP на один аккаунт тоже тормозится.
  limiter.allowKeyed = (key) => allow(key);
  return limiter;
}

module.exports = { createLimiter };