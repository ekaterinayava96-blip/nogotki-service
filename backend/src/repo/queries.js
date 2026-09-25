'use strict';

// Единый слой доступа к данным для API. Все запросы — подготовленные
// выражения node:sqlite. Здесь же — сериализация ответов (без паролей и
// чужих персональных данных, сумма в копейках, время наружу в UTC).

const db = require('./connection');
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

function touchLastLogin(id) {
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowDbLocal(), Number(id));
}

function publicUser(row, { clientId = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    is_active: !!row.is_active,
    ...(clientId ? { client_id: clientId } : {}),
  };
}

// ---------- Каталоги ----------

// client_id текущего пользователя (для role='client'), иначе null
function clientIdForUser(userId) {
  const row = db.prepare('SELECT id FROM clients WHERE user_id = ?').get(Number(userId));
  return row ? row.id : null;
}

function clientById(id) {
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(id));
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
      SELECT m.id, m.name, m.role, m.experience_years, m.photo_path,
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
      bookings_count: m.bookings_count,
      services: servicesOfMaster(m.id),
    }));
}

function servicesOfMaster(masterId) {
  return db
    .prepare(`
      SELECT s.id, s.name, s.price_kopecks, s.duration_minutes
      FROM master_services ms JOIN services s ON s.id = ms.service_id
      WHERE ms.master_id = ? AND s.is_active = 1
      ORDER BY s.id`)
    .all(Number(masterId));
}

function masterById(id) {
  return db.prepare('SELECT * FROM masters WHERE id = ?').get(Number(id));
}

function serviceById(id) {
  return db.prepare('SELECT * FROM services WHERE id = ?').get(Number(id));
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

function createHold({ masterId, startsAtLocal, endsAtLocal, totalMinutes, tokenHash, createdBy, expiresAtLocal }) {
  const info = db
    .prepare(`
      INSERT INTO slot_holds
        (master_id, starts_at, ends_at, duration_minutes, status, token_hash, created_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
    .run(
      Number(masterId), startsAtLocal, endsAtLocal, Number(totalMinutes),
      tokenHash, Number(createdBy), nowDbLocal(), expiresAtLocal
    );
  return info.lastInsertRowid;
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

// Единственная функция вставки записи в bookings (рантайм и сид).
// status передаёт только сид (confirmed/wait); API всегда создаёт 'wait'.
function createBooking({ clientId, serviceId, masterId, startsAtLocal, endsAtLocal, comment, source, forceOverride = 0, status = 'wait' }) {
  const info = db
    .prepare(`
      INSERT INTO bookings (client_id, service_id, master_id, starts_at, ends_at, status, comment, source, force_override, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(Number(clientId), Number(serviceId), Number(masterId), startsAtLocal, endsAtLocal, status, comment, source, forceOverride ? 1 : 0, nowDbLocal());
  return info.lastInsertRowid;
}

function bookingById(id) {
  return db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(id));
}

function setBookingStatus(id, status) {
  db.prepare(
    'UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?'
  ).run(status, nowDbLocal(), Number(id));
}

function moveBooking(id, startsAtLocal, endsAtLocal) {
  db.prepare(
    'UPDATE bookings SET starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?'
  ).run(startsAtLocal, endsAtLocal, nowDbLocal(), Number(id));
}

// Деталь для отдачи наружу: без паролей, суммы в копейках, время в UTC.
function bookingDetail(id) {
  const row = db
    .prepare(`
      SELECT b.id, b.starts_at, b.ends_at, b.status, b.comment, b.source, b.force_override, b.created_at, b.updated_at,
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

function serializeBooking(row) {
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
    service: {
      id: row.service_id,
      name: row.service_name,
      price_kopecks: row.service_price,
      duration_minutes: row.service_duration,
    },
    master: {
      id: row.master_id,
      name: row.master_name,
      role: row.master_role,
    },
  };
}

function listBookings({ clientId = null, masterId = null, status = null, fromLocal = null, toLocal = null }) {
  const conds = ['1=1'];
  const params = [];
  if (clientId) { conds.push('b.client_id = ?'); params.push(clientId); }
  if (masterId) { conds.push('b.master_id = ?'); params.push(masterId); }
  if (status) { conds.push('b.status = ?'); params.push(status); }
  if (fromLocal) { conds.push('b.starts_at >= ?'); params.push(fromLocal); }
  if (toLocal) { conds.push('b.starts_at < ?'); params.push(toLocal); }

  const rows = db
    .prepare(`
      SELECT b.id, b.starts_at, b.ends_at, b.status, b.comment, b.source, b.force_override, b.created_at, b.updated_at,
             c.id AS client_id, c.name AS client_name, c.phone AS client_phone,
             s.id AS service_id, s.name AS service_name, s.price_kopecks AS service_price, s.duration_minutes AS service_duration,
             m.id AS master_id, m.name AS master_name, m.role AS master_role
      FROM bookings b
      JOIN clients c ON c.id = b.client_id
      JOIN services s ON s.id = b.service_id
      JOIN masters m ON m.id = b.master_id
      WHERE ${conds.join(' AND ')}
      ORDER BY b.starts_at`)
    .all(...params);
  return rows.map(serializeBooking);
}

function countBookingsFor(masterId) {
  const r = db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE master_id = ?').get(Number(masterId));
  return r.n;
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
  touchLastLogin,
  publicUser,
  clientIdForUser,
  clientById,
  listServices,
  listMasters,
  servicesOfMaster,
  masterById,
  serviceById,
  scheduleForWeekday,
  getBusyIntervals,
  createHold,
  holdByTokenHash,
  holdById,
  deleteHold,
  markHoldCanceled,
  markHoldUsed,
  purgeExpiredHolds,
  createBooking,
  bookingById,
  setBookingStatus,
  moveBooking,
  bookingDetail,
  serializeBooking,
  listBookings,
  countBookingsFor,
  lastBookingConflictAt,
};