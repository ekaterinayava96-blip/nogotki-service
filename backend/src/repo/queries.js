'use strict';

// Единый слой доступа к данным для API. Все запросы — подготовленные
// выражения node:sqlite. Здесь же — сериализация ответов (без паролей и
// чужих персональных данных, сумма в копейках, время наружу в UTC).

const db = require('../db/connection');
const { toDbLocal, nowDbLocal, dbLocalToUtcIso } = require('../lib/time');

function getOr404(table, id, columns = '*') {
  const row = db
    .prepare(`SELECT ${columns} FROM ${table} WHERE id = ?`)
    .get(Number(id));
  if (!row) {
    const err = new Error(`Запись ${table}#${id} не найдена.`);
    err.status = 404;
    throw err;
  }
  return row;
}

// ---------- Аутентификация ----------

function userByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function userById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
}

// Внешний вход ищет человека по почте: она приходит из внешнего сервиса и
// служит тем же ключом, что логин для обычного входа. Регистр не важен,
// поэтому ищем по lower(): 'Ivan@mail.ru' и 'ivan@mail.ru' — один человек.
function userByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(String(email));
}

function userByProviderId(provider, providerId) {
  return db
    .prepare('SELECT * FROM users WHERE provider = ? AND provider_id = ?')
    .get(String(provider), String(providerId));
}

// Привязка внешнего входа к уже существующему аккаунту. Пароль не трогаем:
// он остаётся, и человек может входить обоими способами.
function linkExternalIdentity(userId, provider, providerId, email) {
  db.prepare(
    `UPDATE users
        SET provider = ?, provider_id = ?,
            email = COALESCE(email, ?)
      WHERE id = ?`
  ).run(String(provider), String(providerId), email ? String(email) : null, Number(userId));
  return userById(userId);
}

// Аккаунт без пароля: password_hash остаётся NULL, что и читается как
// «вход только через внешний сервис». Логин придумываем от почты.
function createExternalUser({ username, email, provider, providerId, role }) {
  return db.transaction(() => {
    const uid = db
      .prepare(
        `INSERT INTO users (username, password_hash, email, provider, provider_id, is_active)
         VALUES (?, NULL, ?, ?, ?, 1)`
      )
      .run(String(username), String(email), String(provider), String(providerId)).lastInsertRowid;
    db.prepare('INSERT INTO user_roles (user_id, role) VALUES (?, ?)').run(Number(uid), role);
    return userById(uid);
  })();
}

// Свободный логин на основе почты. Логин у пользователей уникален, а почта
// может совпасть с чужим логином — поэтому при совпадении добавляем номер.
function uniqueUsernameFromEmail(email) {
  const base = String(email).split('@')[0].replace(/[^a-zA-Z0-9_.]/g, '').slice(0, 24) || 'user';
  let candidate = base;
  let n = 1;
  while (userByUsername(candidate)) {
    n += 1;
    candidate = `${base}${n}`;
  }
  return candidate;
}

function touchLastLogin(id) {
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowDbLocal(), Number(id));
}

function publicUser(row, { roles = [], clientId = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    roles,
    is_active: !!row.is_active,
    ...(clientId ? { client_id: clientId } : {}),
  };
}

// Роли пользователя — список (несколько ролей у одного человека).
function userRoles(userId) {
  return db
    .prepare('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role')
    .all(Number(userId))
    .map((r) => r.role);
}

function hasRole(userId, role) {
  return !!db
    .prepare('SELECT 1 AS hit FROM user_roles WHERE user_id = ? AND role = ?')
    .get(Number(userId), role);
}

// ---------- Сессии входа ----------

// Выдаём клиенту случайный токен, в БД храним только его SHA-256:
// createSession возвращает { token, tokenHash, expiresAtUtc }.
// expiresAtLocal — локальное время истечения (БД хранит локальное время салона).
function createSession({ userId, tokenHash, expiresAtLocal }) {
  const info = db
    .prepare('INSERT INTO auth_sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(Number(userId), tokenHash, nowDbLocal(), expiresAtLocal);
  return info.lastInsertRowid;
}

function sessionByTokenHash(tokenHash) {
  return db
    .prepare('SELECT id, user_id FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?')
    .get(tokenHash, nowDbLocal());
}

function revokeSessionByTokenHash(tokenHash) {
  db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?').run(nowDbLocal(), tokenHash);
}

// Cleanup-задача: удаляем истёкшие и отозванные сессии.
function purgeExpiredSessions() {
  const info = db
    .prepare('DELETE FROM auth_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL')
    .run(nowDbLocal());
  return info.changes;
}

// ---------- Каталоги ----------

// client_id текущего пользователя (для роли 'client'), иначе null
function clientIdForUser(userId) {
  const row = db.prepare('SELECT id FROM clients WHERE user_id = ?').get(Number(userId));
  return row ? row.id : null;
}

function clientById(id) {
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(id));
}

// Правка контактов клиента из формы подтверждения записи (Booking 04).
// undefined означает «поле не передавали, не трогаем» — частичное обновление,
// чтобы не затирать имя, если клиент поменял только телефон.
function updateClient(id, { name, phone }) {
  const sets = [];
  const params = [];
  if (name !== undefined) { sets.push('name = ?'); params.push(name); }
  if (phone !== undefined) { sets.push('phone = ?'); params.push(phone); }
  if (sets.length) {
    params.push(Number(id));
    db.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }
  return clientById(id);
}

function listServices({ activeOnly = true } = {}) {
  const where = activeOnly ? 'WHERE is_active = 1' : '';
  return db
    .prepare(`SELECT id, name, description, price_kopecks, duration_minutes, is_active FROM services ${where} ORDER BY id`)
    .all();
}

function listMasters({ activeOnly = true } = {}) {
  const where = activeOnly ? 'WHERE m.is_active = 1' : '';
  return db
    .prepare(`
      SELECT m.id, m.name, m.role, m.experience_years, m.photo_path, m.is_active,
             (SELECT COUNT(*) FROM bookings b WHERE b.master_id = m.id) AS bookings_count
      FROM masters m
      ${where}
      ORDER BY m.id`)
    .all()
    .map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      experience_years: m.experience_years,
      photo_path: m.photo_path,
      // Считается по всем записям мастера, включая отменённые: это служебная
      // цифра для панели владельца. В публичный каталог она не попадает
      // (routes/catalog.js отдаёт только поля витрины).
      bookings_count: m.bookings_count,
      // is_active обязан быть в SELECT выше: без него поле было бы всегда
      // false, и панель владельца показала бы всех мастеров выключенными, а
      // сохранение карточки тихо деактивировало бы мастера.
      is_active: !!m.is_active,
      // activeOnly:true — клиентский запрос: показываем только активные услуги.
      // activeOnly:false — панель владельца: она перечисляет и отключённых
      // мастеров, и по тем же логике показывает полный набор их услуг.
      services: servicesOfMaster(m.id, { activeOnly: activeOnly }),
    }));
}

// Услуги мастера. activeOnly — по умолчанию только активные: клиенту отключённые
// предлагать нельзя. Панели владельца нужен полный набор (activeOnly: false),
// иначе в форме мастера нельзя было бы увидеть и снять связь с отключённой
// услугой — она пропадала бы молча, и администратор не понимал бы почему.
function servicesOfMaster(masterId, { activeOnly = true } = {}) {
  const where = activeOnly ? 'AND s.is_active = 1' : '';
  return db
    .prepare(`
      SELECT s.id, s.name, s.price_kopecks, s.duration_minutes, s.is_active
      FROM master_services ms JOIN services s ON s.id = ms.service_id
      WHERE ms.master_id = ? ${where}
      ORDER BY s.id`)
    .all(Number(masterId))
    .map((s) => ({ ...s, is_active: !!s.is_active }));
}

function masterById(id) {
  return db.prepare('SELECT * FROM masters WHERE id = ?').get(Number(id));
}

function serviceById(id) {
  return db.prepare('SELECT * FROM services WHERE id = ?').get(Number(id));
}

// ---------- Информация о студии ----------

// Одна строка studio_info (обычно id = 1). null — если сид ещё не засеял.
function studioInfo() {
  return db
    .prepare('SELECT id, studio_name, address, phone, telegram, map_hint, free_cancel_hours, updated_at FROM studio_info ORDER BY id LIMIT 1')
    .get();
}

// Правило бесплатной отмены: сколько часов до визита клиент может отменить
// запись без предупреждения. Пишет владелец через PATCH /admin/studio.
// Значение из БД всегда wins, DEFAULT 12 в схеме — только подстраховка.
function setFreeCancelHours(hours) {
  db.prepare('UPDATE studio_info SET free_cancel_hours = ?, updated_at = ? WHERE id = 1').run(
    Number(hours),
    new Date().toISOString()
  );
}

// ---------- Расписание мастера (админ-управление) ----------

function masterSchedule(masterId) {
  return db
    .prepare('SELECT id, master_id, weekday, start_minutes, end_minutes FROM master_schedule WHERE master_id = ? ORDER BY weekday')
    .all(Number(masterId));
}

// Полная замена расписания недели мастера: DELETE + INSERT в одной транзакции.
// rows: [{ weekday, start_minutes, end_minutes }] — без id (идемпотентно).
function replaceMasterSchedule(masterId, rows) {
  db.transaction(() => {
    db.prepare('DELETE FROM master_schedule WHERE master_id = ?').run(Number(masterId));
    const ins = db.prepare(
      'INSERT INTO master_schedule (master_id, weekday, start_minutes, end_minutes) VALUES (?, ?, ?, ?)'
    );
    for (const r of rows) {
      ins.run(Number(masterId), Number(r.weekday), Number(r.start_minutes), Number(r.end_minutes));
    }
  })();
}

// ---------- Блокировки времени мастера (перерывы, выходные и т.п.) ----------

function listWorkBlocks(masterId, fromLocal = null, toLocal = null) {
  const conds = ['master_id = ?'];
  const params = [Number(masterId)];
  if (fromLocal) { conds.push('ends_at > ?'); params.push(fromLocal); }
  if (toLocal) { conds.push('starts_at < ?'); params.push(toLocal); }
  return db
    .prepare(`SELECT id, master_id, starts_at, ends_at, reason FROM work_blocks WHERE ${conds.join(' AND ')} ORDER BY starts_at`)
    .all(...params);
}

function workBlockById(id) {
  return db.prepare('SELECT id, master_id, starts_at, ends_at, reason FROM work_blocks WHERE id = ?').get(Number(id));
}

function createWorkBlock({ masterId, startsAtLocal, endsAtLocal, reason = 'break' }) {
  const info = db
    .prepare('INSERT INTO work_blocks (master_id, starts_at, ends_at, reason) VALUES (?, ?, ?, ?)')
    .run(Number(masterId), startsAtLocal, endsAtLocal, reason);
  return info.lastInsertRowid;
}

function deleteWorkBlock(id) {
  return db.prepare('DELETE FROM work_blocks WHERE id = ?').run(Number(id));
}

// ---------- Обратная связь клиентов (отзывы, жалобы, вопросы) ----------

function createFeedback({ clientId, text }) {
  const info = db
    .prepare("INSERT INTO client_feedback (client_id, text, status, created_at) VALUES (?, ?, 'new', ?)")
    .run(Number(clientId), text, nowDbLocal());
  return info.lastInsertRowid;
}

function feedbackById(id) {
  const row = db
    .prepare(`
      SELECT f.id, f.text, f.status, f.created_at,
             c.id AS client_id, c.name AS client_name, c.phone AS client_phone
      FROM client_feedback f JOIN clients c ON c.id = f.client_id
      WHERE f.id = ?`)
    .get(Number(id));
  return row;
}

// Отзыв для ответа — имя/телефон клиента допустимы для владельца и мастера.
function serializeFeedback(row) {
  return {
    id: row.id,
    text: row.text,
    status: row.status,
    created_at: dbLocalToUtcIso(row.created_at),
    client: row.client_id
      ? { id: row.client_id, name: row.client_name, phone: row.client_phone }
      : null,
  };
}

// Свои отзывы клиента (для GET /feedback)
function listFeedback({ clientId = null, status = null } = {}) {
  const conds = ['1=1'];
  const params = [];
  if (clientId) { conds.push('f.client_id = ?'); params.push(clientId); }
  if (status) { conds.push('f.status = ?'); params.push(status); }
  const rows = db
    .prepare(`
      SELECT f.id, f.text, f.status, f.created_at,
             c.id AS client_id, c.name AS client_name, c.phone AS client_phone
      FROM client_feedback f JOIN clients c ON c.id = f.client_id
      WHERE ${conds.join(' AND ')}
      ORDER BY f.created_at DESC`)
    .all(...params);
  return rows.map(serializeFeedback);
}

function setFeedbackStatus(id, status) {
  db.prepare('UPDATE client_feedback SET status = ? WHERE id = ?').run(status, Number(id));
}

// ---------- Статистика для админ-панели ----------

// Дашборд (прототип admin.html#statCounts): итого записей, активные,
// сумма активных (цена услуги на момент), число мастеров.
function statsDashboard() {
  const totals = db
    .prepare(`
      SELECT
        COUNT(*) AS total_bookings,
        SUM(CASE WHEN status IN ('wait','confirmed') THEN 1 ELSE 0 END) AS active_bookings,
        -- Итоговая сумма записей: перебираем состав записи (booking_services),
        -- а не берём service_price из services: цена в записи фиксируется на
        -- момент брони и не меняется задним числом при правке прайса.
        SUM(CASE WHEN status IN ('wait','confirmed') THEN
          (SELECT COALESCE(SUM(bs.price_kopecks), 0) FROM booking_services bs WHERE bs.booking_id = b.id)
        ELSE 0 END) AS active_sum_kopecks
      FROM bookings b`)
    .get();
  const mastersCount = db.prepare('SELECT COUNT(*) AS n FROM masters').get().n;
  return {
    total_bookings: totals.total_bookings,
    active_bookings: totals.active_bookings || 0,
    active_sum_kopecks: totals.active_sum_kopecks || 0,
    masters_count: mastersCount,
  };
}

// Статистика за период. Тот же счётчик, что и statsDashboard, но ограниченный
// датами, плюс разбивка по статусам, мастерам и дням: владельцу одного числа
// «записей за месяц» мало, ему видеть, кто загружен и в какие дни поток.
//
// Период приходит уже в салонном локальном времени (routes/admin.js переводит
// UTC через toDbLocal), поэтому группировка по дням — это substr(starts_at, 1, 10):
// это и есть дата визита в календаре студии, без обратного пересчёта по TZ.
function statsPeriod({ fromLocal = null, toLocal = null }) {
  const { where, params } = bookingFilterConds({ fromLocal, toLocal });

  const totals = db
    .prepare(`
      SELECT
        COUNT(*) AS total_bookings,
        SUM(CASE WHEN status IN ('wait','confirmed') THEN 1 ELSE 0 END) AS active_bookings,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_bookings,
        SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END) AS canceled_bookings,
        COALESCE(SUM(
          (SELECT COALESCE(SUM(bs.price_kopecks), 0) FROM booking_services bs WHERE bs.booking_id = b.id)
        ), 0) AS total_sum_kopecks
      FROM bookings b
      WHERE ${where}`)
    .get(...params);

  const byMaster = db
    .prepare(`
      SELECT m.id, m.name,
             COUNT(*) AS bookings,
             COALESCE(SUM(
               (SELECT COALESCE(SUM(bs.price_kopecks), 0) FROM booking_services bs WHERE bs.booking_id = b.id)
             ), 0) AS sum_kopecks
      FROM bookings b
      JOIN masters m ON m.id = b.master_id
      WHERE ${where}
      GROUP BY m.id, m.name
      ORDER BY bookings DESC, m.name`)
    .all(...params);

  const byDay = db
    .prepare(`
      SELECT substr(starts_at, 1, 10) AS day,
             COUNT(*) AS bookings,
             COALESCE(SUM(
               (SELECT COALESCE(SUM(bs.price_kopecks), 0) FROM booking_services bs WHERE bs.booking_id = b.id)
             ), 0) AS sum_kopecks
      FROM bookings b
      WHERE ${where}
      GROUP BY day
      ORDER BY day`)
    .all(...params);

  return {
    from: fromLocal,
    to: toLocal,
    total_bookings: totals.total_bookings,
    active_bookings: totals.active_bookings || 0,
    done_bookings: totals.done_bookings || 0,
    canceled_bookings: totals.canceled_bookings || 0,
    total_sum_kopecks: totals.total_sum_kopecks || 0,
    by_master: byMaster,
    by_day: byDay,
  };
}

// ---------- Свободное время / конфликты ----------

function scheduleForWeekday(masterId, weekday) {
  return db
    .prepare('SELECT start_minutes, end_minutes FROM master_schedule WHERE master_id = ? AND weekday = ?')
    .get(Number(masterId), Number(weekday));
}

function getBusyIntervals(masterId, dateStartLocal, dateEndLocal, excludeBookingId = null) {
  const rows = [];
  const s0 = toDbLocal(dateStartLocal);
  const s1 = toDbLocal(dateEndLocal);

  // Записи (кроме отменённых), пересекающие [s0, s1)
  const bookings = db
    .prepare(`
      SELECT starts_at, ends_at FROM bookings
      WHERE master_id = ? AND status != 'canceled'
        AND starts_at < ? AND ends_at > ?
        ${excludeBookingId ? 'AND id != ?' : ''}`)
    .all(Number(masterId), s1, s0, ...(excludeBookingId ? [excludeBookingId] : []));
  rows.push(...bookings.map((r) => ({ from: r.starts_at, to: r.ends_at, kind: 'booking' })));

  // Блокировки времени мастера
  const blocks = db
    .prepare(`
      SELECT starts_at, ends_at FROM work_blocks
      WHERE master_id = ? AND starts_at < ? AND ends_at > ?`)
    .all(Number(masterId), s1, s0);
  rows.push(...blocks.map((r) => ({ from: r.starts_at, to: r.ends_at, kind: 'block' })));

  // Закрытия студии
  const closures = db
    .prepare(`
      SELECT starts_at, ends_at FROM studio_closures
      WHERE starts_at < ? AND ends_at > ?`)
    .all(s1, s0);
  rows.push(...closures.map((r) => ({ from: r.starts_at, to: r.ends_at, kind: 'closure' })));

  // Активные удержания (не истёкшие)
  const holds = db
    .prepare(`
      SELECT starts_at, ends_at FROM slot_holds
      WHERE master_id = ? AND status = 'active' AND expires_at > ?
        AND starts_at < ? AND ends_at > ?`)
    .all(Number(masterId), nowDbLocal(), s1, s0);
  rows.push(...holds.map((r) => ({ from: r.starts_at, to: r.ends_at, kind: 'hold' })));

  return rows;
}

// ---------- Удержания (slot_holds) ----------

function createHold({ masterId, startsAtLocal, endsAtLocal, totalMinutes, tokenHash, createdBy, expiresAtLocal, serviceIds = null }) {
  const info = db
    .prepare(`
      INSERT INTO slot_holds
        (master_id, starts_at, ends_at, duration_minutes, status, token_hash, created_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
    .run(
      Number(masterId), startsAtLocal, endsAtLocal, Number(totalMinutes),
      tokenHash, Number(createdBy), nowDbLocal(), expiresAtLocal
    );
  const holdId = info.lastInsertRowid;
  // Услуги удержания запоминаем, чтобы при создании записи сверять набор, а не
  // только суммарную длительность (наборы с одинаковыми минутами разные).
  if (serviceIds && serviceIds.length) {
    insertHoldServices(holdId, serviceIds);
  }
  return holdId;
}

function insertHoldServices(holdId, serviceIds) {
  const ins = db.prepare('INSERT OR IGNORE INTO hold_services (hold_id, service_id) VALUES (?, ?)');
  for (const id of serviceIds) ins.run(Number(holdId), Number(id));
}

function holdServiceIds(holdId) {
  return db
    .prepare('SELECT service_id FROM hold_services WHERE hold_id = ? ORDER BY service_id')
    .all(Number(holdId))
    .map((r) => r.service_id);
}

function holdByTokenHash(tokenHash) {
  return db.prepare('SELECT * FROM slot_holds WHERE token_hash = ?').get(tokenHash);
}

function holdById(id) {
  return db.prepare('SELECT * FROM slot_holds WHERE id = ?').get(Number(id));
}

function deleteHold(id) {
  return db.prepare('DELETE FROM slot_holds WHERE id = ?').run(Number(id));
}

function markHoldCanceled(id) {
  return db.prepare("UPDATE slot_holds SET status = 'canceled' WHERE id = ?").run(Number(id));
}

function markHoldUsed(id) {
  const info = db.prepare("UPDATE slot_holds SET status = 'used' WHERE id = ?").run(Number(id));
  return info.changes;
}

function purgeExpiredHolds() {
  const info = db
    .prepare("DELETE FROM slot_holds WHERE status = 'active' AND expires_at <= ?")
    .run(nowDbLocal());
  return info.changes;
}

// ---------- Записи (bookings) ----------

// Услуги записи в порядке выбора клиента (booking_services.position).
// Цена и длительность — снимок на момент записи, название — из каталога.
function servicesOfBooking(bookingId) {
  return db
    .prepare(`
      SELECT bs.service_id AS id, s.name, bs.price_kopecks, bs.duration_minutes
      FROM booking_services bs
      JOIN services s ON s.id = bs.service_id
      WHERE bs.booking_id = ?
      ORDER BY bs.position`)
    .all(Number(bookingId));
}

// Те же услуги пачкой для списка записей: один запрос вместо запроса на запись.
// Возвращает Map <booking_id, services[]>.
function bookingServicesMap(bookingIds) {
  const map = new Map();
  const ids = bookingIds.map(Number).filter((id) => Number.isInteger(id));
  if (!ids.length) return map;
  // Плейсхолдеры собираются по длине массива, значения идут параметрами.
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`
      SELECT bs.booking_id, bs.service_id AS id, s.name, bs.price_kopecks, bs.duration_minutes
      FROM booking_services bs
      JOIN services s ON s.id = bs.service_id
      WHERE bs.booking_id IN (${placeholders})
      ORDER BY bs.booking_id, bs.position`)
    .all(...ids);
  for (const r of rows) {
    if (!map.has(r.booking_id)) map.set(r.booking_id, []);
    map.get(r.booking_id).push({
      id: r.id, name: r.name, price_kopecks: r.price_kopecks, duration_minutes: r.duration_minutes,
    });
  }
  return map;
}

// Записи, созданные напрямую в SQL (сид старой схемы, тесты, ручной разбор),
// могут не иметь строк в booking_services. Для них набор услуг = одна услуга
// bookings.service_id — иначе такие записи выглядели бы «без услуг».
function bookingServicesOf(row, services) {
  if (services && services.length) return services;
  return [{
    id: row.service_id,
    name: row.service_name,
    price_kopecks: row.service_price,
    duration_minutes: row.service_duration,
  }];
}

// Единственная функция вставки записи в bookings (рантайм и сид).
// status передаёт только сид (confirmed/wait); API всегда создаёт 'wait'.
// serviceIds — услуги записи (одна или несколько); serviceId оставлен для
// обратной совместимости вызовов сида. bookings.service_id = первая услуга,
// полный список — в booking_services (со снимком цены и длительности).
function createBooking({ clientId, serviceId, serviceIds, masterId, startsAtLocal, endsAtLocal, comment, source, forceOverride = 0, status = 'wait', conflictNote = null }) {
  const ids = (serviceIds && serviceIds.length ? serviceIds : [serviceId]).map(Number);
  if (!ids.length || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error('createBooking: переданы некорректные услуги.');
  }
  const info = db
    .prepare(`
      INSERT INTO bookings (client_id, service_id, master_id, starts_at, ends_at, status, comment, source, force_override, conflict_note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(Number(clientId), ids[0], Number(masterId), startsAtLocal, endsAtLocal, status, comment, source, forceOverride ? 1 : 0, conflictNote, nowDbLocal());
  const bookingId = Number(info.lastInsertRowid);
  // Снимок цены и длительности берём из каталога на момент записи.
  // Плейсхолдеры: booking_id, position, service_id.
  const ins = db.prepare(`
    INSERT INTO booking_services (booking_id, service_id, position, price_kopecks, duration_minutes)
    SELECT ?, id, ?, price_kopecks, duration_minutes FROM services WHERE id = ?`);
  ids.forEach((id, i) => ins.run(bookingId, i + 1, id));
  return bookingId;
}

function bookingById(id) {
  return db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(id));
}

// Смена статуса. Если статус становится 'canceled', запись остаётся строкой
// (ничего не удаляется) и рядом пишется, кто отменил и почему. Время при этом
// освобождается само: getBusyIntervals() берёт записи по status != 'canceled',
// поэтому отменённая строка перестаёт занимать слот.
function setBookingStatus(id, status, { canceledBy = null, canceledReason = null } = {}) {
  if (status === 'canceled') {
    db.prepare(
      'UPDATE bookings SET status = ?, updated_at = ?, canceled_by = ?, canceled_reason = ?, canceled_at = ? WHERE id = ?'
    ).run(status, nowDbLocal(), canceledBy, canceledReason, nowDbLocal(), Number(id));
    return;
  }
  // Возврат из отмены в активный статус затирает след отмены: иначе панель
  // показывала бы «отменял X» у действующей записи.
  db.prepare(
    `UPDATE bookings SET status = ?, updated_at = ?,
       canceled_by = NULL, canceled_reason = NULL, canceled_at = NULL
     WHERE id = ?`
  ).run(status, nowDbLocal(), Number(id));
}

// Журнал переносов: откуда ушли, куда пришли, кто переносил. Перенос меняет
// время той же записи, поэтому каждый перенос — одна строка здесь, а не новая
// запись в bookings. Клиент уведомлений на два раза не получает именно потому,
// что второй записи не появляется.
function addBookingMove({ bookingId, fromAtLocal, toAtLocal, fromMaster = null, toMaster = null, movedBy = null }) {
  const info = db.prepare(
    `INSERT INTO booking_moves (booking_id, from_at, to_at, from_master, to_master, moved_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    Number(bookingId), fromAtLocal, toAtLocal,
    fromMaster ? Number(fromMaster) : null,
    toMaster ? Number(toMaster) : null,
    movedBy ? Number(movedBy) : null,
    nowDbLocal()
  );
  return Number(info.lastInsertRowid);
}

function bookingMoves(bookingId) {
  return db
    .prepare(`
      SELECT bm.id, bm.from_at, bm.to_at, bm.created_at, bm.moved_by,
             bm.from_master, mf.name AS from_master_name,
             bm.to_master, mt.name AS to_master_name,
             u.username AS moved_by_username
      FROM booking_moves bm
      LEFT JOIN masters mf ON mf.id = bm.from_master
      LEFT JOIN masters mt ON mt.id = bm.to_master
      LEFT JOIN users u ON u.id = bm.moved_by
      WHERE bm.booking_id = ?
      ORDER BY bm.created_at, bm.id`)
    .all(Number(bookingId));
}

function lastBookingMove(bookingId) {
  return bookingMoves(bookingId).slice(-1)[0] || null;
}

function moveBooking(id, startsAtLocal, endsAtLocal, masterId = null, { forceOverride = 0, conflictNote = null } = {}) {
  db.prepare(
    `UPDATE bookings
     SET starts_at = ?, ends_at = ?, master_id = COALESCE(?, master_id),
         force_override = ?, conflict_note = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    startsAtLocal, endsAtLocal, masterId ? Number(masterId) : null,
    forceOverride ? 1 : 0, conflictNote, nowDbLocal(), Number(id)
  );
}

// Кто занимает это время по-настоящему — интервалы пересекаются, а не «начало
// попало в диапазон». Нужен, чтобы найти пострадавшего при наложении: запись,
// начавшаяся ДО новой и закончившаяся внутри неё, по фильтру «начало в
// диапазоне» не находилась бы вовсе.
function overlappingBookings(masterId, startsAtLocal, endsAtLocal, excludeId = null) {
  return db
    .prepare(`
      SELECT id FROM bookings
      WHERE master_id = ? AND status != 'canceled'
        AND starts_at < ? AND ends_at > ?
        ${excludeId ? 'AND id != ?' : ''}
      ORDER BY id`)
    .all(Number(masterId), endsAtLocal, startsAtLocal, ...(excludeId ? [Number(excludeId)] : []));
}

// Деталь для отдачи наружу: без паролей, суммы в копейках, время в UTC.
function bookingDetail(id) {
  const row = db
    .prepare(`
      SELECT b.id, b.starts_at, b.ends_at, b.status, b.comment, b.source, b.force_override, b.created_at, b.updated_at,
             b.canceled_by, b.canceled_reason, b.canceled_at, b.conflict_note,
             c.id AS client_id, c.name AS client_name, c.phone AS client_phone,
             s.id AS service_id, s.name AS service_name, s.price_kopecks AS service_price, s.duration_minutes AS service_duration,
             m.id AS master_id, m.name AS master_name, m.role AS master_role
      FROM bookings b
      JOIN clients c ON c.id = b.client_id
      JOIN services s ON s.id = b.service_id
      JOIN masters m ON m.id = b.master_id
      WHERE b.id = ?`)
    .get(Number(id));
  return row;
}

function serializeBooking(row, services = null) {
  const list = bookingServicesOf(row, services);
  return {
    id: row.id,
    starts_at: dbLocalToUtcIso(row.starts_at),
    ends_at: dbLocalToUtcIso(row.ends_at),
    status: row.status,
    comment: row.comment,
    source: row.source,
    force_override: !!row.force_override,
    created_at: dbLocalToUtcIso(row.created_at),
    updated_at: row.updated_at ? dbLocalToUtcIso(row.updated_at) : null,
    client: {
      id: row.client_id,
      name: row.client_name,
      phone: row.client_phone,
    },
    // service — первая услуга записи (обратная совместимость для старых
    // клиентов и админки), services — весь набор.
    service: list[0],
    services: list,
    total_price_kopecks: list.reduce((sum, s) => sum + s.price_kopecks, 0),
    total_duration_minutes: list.reduce((sum, s) => sum + s.duration_minutes, 0),
    master: {
      id: row.master_id,
      name: row.master_name,
      role: row.master_role,
    },
    // Отмена: кто и почему. Клиент в кабинете видит, что визит отменён и по
    // какой причине — иначе запись просто исчезла бы из его списка.
    cancellation: row.canceled_at ? {
      canceled_at: dbLocalToUtcIso(row.canceled_at),
      reason: row.canceled_reason || null,
      by: row.canceled_by ? { user_id: row.canceled_by, is_staff: true } : { user_id: null, is_staff: false },
    } : null,
    // Пометка администратора: запись создана поверх занятого времени.
    conflict_note: row.conflict_note || null,
  };
}

// Запись целиком для ответа API: деталь + её набор услуг. Единая точка,
// чтобы список услуг не забывали приложить (в serializeBooking без второго
// аргумента он берётся из bookings.service_id, то есть только первая услуга).
function serializedBooking(id) {
  const row = bookingDetail(id);
  if (!row) return null;
  return serializeBooking(row, servicesOfBooking(id));
}

// Условия выборки записок одинаковы для списка и для его счётчика: собираем
// их в одном месте, иначе «всего 12» и показанные 12 строк разъедутся, как
// только фильтры заработают не на глаз.
function bookingFilterConds({ clientId = null, masterId = null, status = null, fromLocal = null, toLocal = null }) {
  const conds = ['1=1'];
  const params = [];
  if (clientId) { conds.push('b.client_id = ?'); params.push(clientId); }
  if (masterId) { conds.push('b.master_id = ?'); params.push(masterId); }
  if (status) { conds.push('b.status = ?'); params.push(status); }
  if (fromLocal) { conds.push('b.starts_at >= ?'); params.push(fromLocal); }
  if (toLocal) { conds.push('b.starts_at < ?'); params.push(toLocal); }
  return { where: conds.join(' AND '), params };
}

function countBookings(filter) {
  const { where, params } = bookingFilterConds(filter);
  return db.prepare(`SELECT COUNT(*) AS n FROM bookings b WHERE ${where}`).get(...params).n;
}

function listBookings({ clientId = null, masterId = null, status = null, fromLocal = null, toLocal = null, limit = null, offset = 0 }) {
  const { where, params } = bookingFilterConds({ clientId, masterId, status, fromLocal, toLocal });

  const rows = db
    .prepare(`
      SELECT b.id, b.starts_at, b.ends_at, b.status, b.comment, b.source, b.force_override, b.created_at, b.updated_at,
             b.canceled_by, b.canceled_reason, b.canceled_at, b.conflict_note,
             c.id AS client_id, c.name AS client_name, c.phone AS client_phone,
             s.id AS service_id, s.name AS service_name, s.price_kopecks AS service_price, s.duration_minutes AS service_duration,
             m.id AS master_id, m.name AS master_name, m.role AS master_role
      FROM bookings b
      JOIN clients c ON c.id = b.client_id
      JOIN services s ON s.id = b.service_id
      JOIN masters m ON m.id = b.master_id
      WHERE ${where}
      ORDER BY b.starts_at
      ${limit === null ? '' : 'LIMIT ? OFFSET ?'}`)
    .all(...params, ...(limit === null ? [] : [Number(limit), Number(offset)]));
  const services = bookingServicesMap(rows.map((r) => r.id));
  return rows.map((row) => serializeBooking(row, services.get(row.id)));
}

function countBookingsFor(masterId) {
  const r = db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE master_id = ?').get(Number(masterId));
  return r.n;
}

// Сколько записей ссылается на услугу — и по главной ссылке записи, и по составу
// комплекса. Нужна панели владельца: пока записи есть, услугу нельзя удалить,
// только отключить (DELETE /api/admin/services/:id).
function countBookingsWithService(serviceId) {
  const direct = db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE service_id = ?').get(Number(serviceId));
  const inSet = db.prepare('SELECT COUNT(*) AS n FROM booking_services WHERE service_id = ?').get(Number(serviceId));
  return Number(direct.n) + Number(inSet.n);
}

// Запись для панели владельца: всё то же плюс след отмены и перенос.
// Отдельная функция, а не serializeBooking: панели нужны имена «кто отменил»
// и «кто переносил», а клиенту такие подробности не показывают.
// Список записей дня для панели. Время отдаётся как есть (dbLocal, салонное),
// а экран переводит в HH:MM через window.api.hour() — так же, как клиентские
// страницы. Дополнительно каждая строка получает moved_last и overlap:
// «перенесён» и «на это время два визита».
function adminBookings({ masterId = null, status = null, fromLocal = null, toLocal = null, limit = null, offset = 0 }) {
  const { where, params } = bookingFilterConds({ masterId, status, fromLocal, toLocal });
  const rows = db
    .prepare(`
      SELECT b.id, b.starts_at, b.ends_at, b.status, b.comment, b.source, b.force_override, b.created_at, b.updated_at,
             b.canceled_by, b.canceled_reason, b.canceled_at, b.conflict_note,
             c.id AS client_id, c.name AS client_name, c.phone AS client_phone,
             s.id AS service_id, s.name AS service_name, s.price_kopecks AS service_price, s.duration_minutes AS service_duration,
             m.id AS master_id, m.name AS master_name, m.role AS master_role
      FROM bookings b
      JOIN clients c ON c.id = b.client_id
      JOIN services s ON s.id = b.service_id
      JOIN masters m ON m.id = b.master_id
      WHERE ${where}
      ORDER BY b.starts_at
      ${limit === null ? '' : 'LIMIT ? OFFSET ?'}`)
    .all(...params, ...(limit === null ? [] : [Number(limit), Number(offset)]));
  const services = bookingServicesMap(rows.map((r) => r.id));
  return rows.map((row) => {
    const base = serializeBooking(row, services.get(row.id));
    const moves = bookingMoves(row.id);
    const overlap = bookingHasOverlap(row.id);
    const cancelUser = row.canceled_by
      ? db.prepare('SELECT username FROM users WHERE id = ?').get(Number(row.canceled_by))
      : null;
    return {
      ...base,
      canceled_reason: row.canceled_reason || null,
      canceled_at: row.canceled_at ? dbLocalToUtcIso(row.canceled_at) : null,
      canceled_by_username: cancelUser ? cancelUser.username : null,
      moved_last: moves.length ? moves[moves.length - 1] : null,
      moves_count: moves.length,
      // На это время назначено два визита: помечаем в списке дня.
      overlap: !!overlap,
      overlap_with: overlap ? overlap.booking_id : null,
    };
  });
}

function adminBooking(bookingId) {
  const row = db
    .prepare(`
      SELECT b.id, b.starts_at, b.ends_at, b.status, b.comment, b.source, b.force_override, b.created_at, b.updated_at,
             b.canceled_by, b.canceled_reason, b.canceled_at, b.conflict_note,
             c.id AS client_id, c.name AS client_name, c.phone AS client_phone,
             s.id AS service_id, s.name AS service_name, s.price_kopecks AS service_price, s.duration_minutes AS service_duration,
             m.id AS master_id, m.name AS master_name, m.role AS master_role
      FROM bookings b
      JOIN clients c ON c.id = b.client_id
      JOIN services s ON s.id = b.service_id
      JOIN masters m ON m.id = b.master_id
      WHERE b.id = ?`)
    .get(Number(bookingId));
  if (!row) return null;
  const base = serializeBooking(row, servicesOfBooking(bookingId));
  const cancelUser = row.canceled_by
    ? db.prepare('SELECT username FROM users WHERE id = ?').get(Number(row.canceled_by))
    : null;
  const moves = bookingMoves(bookingId);
  return {
    ...base,
    canceled_by: row.canceled_by,
    // Причина и время отмены — подняты на верхний уровень, иначе панели
    // пришлось бы лезть в cancellation.reason за тем же самым.
    canceled_reason: row.canceled_reason || null,
    canceled_at: row.canceled_at ? dbLocalToUtcIso(row.canceled_at) : null,
    canceled_by_username: cancelUser ? cancelUser.username : null,
    moves,
    moves_count: moves.length,
    moved_last: moves.length ? moves[moves.length - 1] : null,
    overlap: !!bookingHasOverlap(bookingId),
  };
}

// Есть ли в это время ещё одна запись того же мастера. Панель помечает такие
// строки: запись, созданная поверх занятого времени, видна как «двойная».
function bookingHasOverlap(bookingId) {
  const row = db.prepare('SELECT master_id, starts_at, ends_at FROM bookings WHERE id = ?').get(Number(bookingId));
  if (!row) return null;
  const other = db
    .prepare(`
      SELECT id FROM bookings
      WHERE master_id = ? AND status != 'canceled' AND id != ?
        AND starts_at < ? AND ends_at > ?
      LIMIT 1`)
    .get(Number(row.master_id), Number(bookingId), row.ends_at, row.starts_at);
  return other ? { booking_id: other.id, starts_at: other.starts_at } : null;
}

function lastBookingConflictAt(masterId, excludeBookingId, startsLocal, endsLocal) {
  const row = db
    .prepare(`
      SELECT 1 AS hit FROM bookings
      WHERE master_id = ? AND status != 'canceled'
        AND id != COALESCE(?, -1)
        AND starts_at < ? AND ends_at > ?
      LIMIT 1`)
    .get(Number(masterId), excludeBookingId ? Number(excludeBookingId) : null, endsLocal, startsLocal);
  return !!row;
}

module.exports = {
  getOr404,
  userByUsername,
  userById,
  userByEmail,
  userByProviderId,
  linkExternalIdentity,
  createExternalUser,
  uniqueUsernameFromEmail,
  touchLastLogin,
  publicUser,
  userRoles,
  hasRole,
  createSession,
  sessionByTokenHash,
  revokeSessionByTokenHash,
  purgeExpiredSessions,
  clientIdForUser,
  clientById,
  updateClient,
  listServices,
  listMasters,
  servicesOfMaster,
  masterById,
  serviceById,
  studioInfo,
  setFreeCancelHours,
  masterSchedule,
  replaceMasterSchedule,
  listWorkBlocks,
  workBlockById,
  createWorkBlock,
  deleteWorkBlock,
  statsDashboard,
  statsPeriod,
  createFeedback,
  feedbackById,
  serializeFeedback,
  listFeedback,
  setFeedbackStatus,
  scheduleForWeekday,
  getBusyIntervals,
  createHold,
  insertHoldServices,
  holdServiceIds,
  holdByTokenHash,
  holdById,
  deleteHold,
  markHoldCanceled,
  markHoldUsed,
  purgeExpiredHolds,
  createBooking,
  servicesOfBooking,
  bookingServicesMap,
  bookingById,
  setBookingStatus,
  addBookingMove,
  overlappingBookings,
  adminBookings,
  bookingMoves,
  lastBookingMove,
  adminBooking,
  bookingHasOverlap,
  moveBooking,
  bookingDetail,
  serializedBooking,
  serializeBooking,
  listBookings,
  countBookings,
  countBookingsFor,
  countBookingsWithService,
  lastBookingConflictAt,
};