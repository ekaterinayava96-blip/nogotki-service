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
const { resolveExternalIdentity, YandexNotConfiguredError } = require('../lib/yandex');

const router = express.Router();

const loginLimiter = createLimiter({ windowMs: 60 * 1000, max: 5 });
const registerLimiter = createLimiter({ windowMs: 60 * 1000, max: 5 });
// Внешний вход тоже ограничен: пока подключения нет, это единственная точка,
// которой можно было бы посылать запросы подряд.
const externalLimiter = createLimiter({ windowMs: 60 * 1000, max: 10 });

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

// Внешний вход (Яндекс).
//
// Эндпоинт принимает почту и имя от внешнего сервиса. Настоящего обмена пока
// нет — сервис не опубликован и постоянного адреса для возврата не существует,
// поэтому обращение к Яндексу заменено заглушкой (lib/yandex.js).
//
// Пока подключения нет, тело запроса намеренно НЕ используется: почта и имя
// берутся из настроек заглушки. Иначе любой мог бы отправить сюда чужую почту и
// войти под этим человеком. Когда появится настоящий код, вход будет вызываться
// с кодом из query, и подделать его будет нельзя.
router.post('/external/yandex', externalLimiter, asyncH(async (req, res) => {
  // Определяем личность вне нашего кода: здесь и заглушка, и будущий обмен.
  let identity;
  try {
    identity = await resolveExternalIdentity({
      code: req.query.code,
      state: req.query.state,
    });
  } catch (err) {
    if (err instanceof YandexNotConfiguredError) {
      // 503: подключение ещё не настроено, это не ошибка пользователя.
      return res.status(503).json({
        error: { message: err.message, code: err.code },
      });
    }
    throw err;
  }

  const email = v.email(identity.email);
  const displayName = identity.name ? v.name(identity.name) : null;

  // 1. Ищем человека по почте. provider_id внешнего сервиса для поиска не
  //    годится: он известен только после обмена, а вот почта приходит всегда.
  //    Если у сервиса почты нет — вход невозможен, и это видно сразу.
  const existing = q.userByEmail(email);

  let user;
  if (existing) {
    // 2. Аккаунт с такой почтой уже есть — второй не создаём, а привязываем
    //    внешний вход к нему. Пароль при этом сохраняется: человек может
    //    входить обоими способами.
    if (existing.provider_id && existing.provider !== 'yandex') {
      return res.status(409).json({
        error: {
          message: 'Этот аккаунт уже привязан к другому способу входа.',
          code: 'PROVIDER_CONFLICT',
        },
      });
    }
    user = q.linkExternalIdentity(existing.id, 'yandex', identity.providerId || email, email);
  } else {
    // 3. Почты в базе нет — создаём новый аккаунт. Роль всегда 'client':
    //    роль из тела запроса не читается, другой путь выдать её не позволяет.
    //    password_hash остаётся NULL — вход только через внешний сервис.
    const username = q.uniqueUsernameFromEmail(email);
    user = q.createExternalUser({
      username,
      email,
      provider: 'yandex',
      providerId: identity.providerId || email,
      role: 'client',
    });
  }

  // 4. Отключённый аккаунт остаётся отключённым: внешний вход не должен
  //    обходить блокировку, иначе её можно было бы снять чужим входом.
  if (user.is_active !== 1) {
    return res.status(403).json({
      error: { message: 'Аккаунт отключён.', code: 'ACCOUNT_DISABLED' },
    });
  }

  // 5. Свой токен сервиса — ровно тот же, что и при обычном входе: те же сроки
  //    жизни, то же хеширование, та же кука. Токен Яндекса сюда не попадает.
  q.touchLastLogin(user.id);
  const roles = q.userRoles(user.id);
  const clientId = roles.includes('client') ? q.clientIdForUser(user.id) : null;
  const token = issueToken(user);
  setSessionCookie(res, token);
  return res.json({
    token,
    user: q.publicUser(user, { roles, clientId }),
    // Пригодится, чтобы записать в журнал, что вход был внешний и заглушкой.
    source: identity.source,
    linked: Boolean(existing),
  });
}));

// Восстановление пароля.
//
// Отдельного эндпоинта сброса в API до этого не было: экран отправлял запрос и
// получал 404. Здесь решается только одно — как ответить клиенту.
//
// Письма сервис не отправляет: почтового провайдера в проекте нет, и подменять
// его заглушкой, как вход, мы не будем — это молчаливое обещание, что письмо
// дойдёт. Вместо этого отвечаем, что произошло.
router.post('/password/forgot', loginLimiter, asyncH(async (req, res) => {
  const username = v.username(req.body.username);
  const user = q.userByUsername(username);

  // Аккаунта нет — отвечаем тем же, что и при успехе, чтобы по ответу нельзя
  // было перебирать существующие логины.
  if (!user) {
    return res.json({ sent: true });
  }

  // 4. Ключевой случай: пароля у аккаунта нет, он входит через Яндекс.
  //    Сбрасывать нечего, и письмо отправлять незачем.
  //    Отвечаем 200, а не ошибкой: это не сбой, а ответ на вопрос «как мне
  //    восстановить доступ». Иначе клиент показал бы это красной ошибкой.
  if (user.password_hash === null) {
    return res.json({ sent: true, method: 'yandex' });
  }

  // Обычный аккаунт. Письма мы не отправляем (провайдера нет), поэтому честно
  // говорим об этом, а не делаем вид, что письмо ушло.
  return res.status(501).json({
    error: {
      message: 'Восстановление пароля пока не подключено. Попробуйте «Войти через Яндекс» или напишите в студию.',
      code: 'PASSWORD_RESET_UNAVAILABLE',
    },
  });
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