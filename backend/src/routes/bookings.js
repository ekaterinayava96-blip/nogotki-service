'use strict';

// Записи: создание (в т.ч. по удержанию), просмотр своих, детали,
// перенос и отмена.

const express = require('express');
const crypto = require('crypto');

const db = require('../db/connection');
const q = require('../repo/queries');
const { parseUtcIso, toDbLocal, salonDayStart, nowDbLocal } = require('../lib/time');
const v = require('../lib/validate');
const { asyncH, isBookingTimeConflict, sendSlotConflict } = require('../lib/http');
const { requireRole, authRequired } = require('../middleware/auth');
const { freeSlots } = require('../lib/availability');

const router = express.Router();

const SOURCE = 'web'; // API-записи приходят из веб-формы сайта

// Проверка, что интервал [startUtc, endUtc) свободен у мастера (без записи
// произвольного перекрытия). Используем вычисление свободных слотов с шагом 1.
function assertSlotFree(masterId, startUtc, endUtc) {
  const totalMinutes = (endUtc.getTime() - startUtc.getTime()) / 60000;
  const slots = freeSlots({
    masterId,
    dateStartUtc: salonDayStart(startUtc),
    totalMinutes,
    stepMinutes: 1,
  });
  const exact = slots.some((s) => s.starts_at === startUtc.toISOString());
  if (!exact) {
    const err = new Error('Слот занят.');
    err.status = 409;
    throw err;
  }
}

// POST /bookings — создать запись.
// body: { service_id, master_id, starts_at (UTC ISO), hold_token?, comment?, force_override? }
// С hold_token: слот уже удержан входящим клиентом (конфликт исключён).
// Без hold_token: проверяем, что слот свободен прямо сейчас.
//
// force_override (признак осознанного наложения) может выставить ТОЛЬКО
// роль owner. Для client/master значение поля игнорируется намеренно:
// брать его не принято (см. ниже), а не отклонять запрос с ошибкой.
router.post(
  '/',
  requireRole('client', 'master', 'owner'),
  asyncH(async (req, res) => {
    const serviceId = v.intId(req.body.service_id, 'service_id');
    const masterId = v.intId(req.body.master_id, 'master_id');
    const comment = req.body.comment === undefined ? null : v.str(req.body.comment, 'comment', { max: 500 });
    const holdToken = req.body.hold_token;
    const useHold = holdToken !== undefined && holdToken !== null && holdToken !== '';

    // Проверка роли: признак наложения создаёт запись поверх занятого времени,
    // поэтому это административная возможность. У client/master поле в запросе
    // просто не читается — эффект тот же, что и при отсутствии поля.
    const wantForce = v.bool(req.body.force_override, 'force_override');
    const forceOverride = req.user.role === 'owner' ? (wantForce ?? 0) : 0;

    const service = q.serviceById(serviceId);
    if (!service || service.is_active !== 1) {
      return res.status(400).json({ error: { message: 'Услуга не найдена.', code: 'UNKNOWN_SERVICE' } });
    }
    const master = q.masterById(masterId);
    if (!master || master.is_active !== 1) {
      return res.status(400).json({ error: { message: 'Мастер не найден.', code: 'UNKNOWN_MASTER' } });
    }
    const can = db
      .prepare('SELECT 1 AS hit FROM master_services WHERE master_id = ? AND service_id = ?')
      .get(masterId, serviceId);
    if (!can) {
      return res.status(400).json({
        error: { message: 'Мастер не выполняет эту услугу.', code: 'MASTER_SERVICE_MISMATCH' },
      });
    }

    // Мастер (роль) создаёт записи только в свой график — отличия в правах
    // ролей допустимы, сам путь создания записи общий (createBooking).
    if (req.user.role === 'master') {
      const user = q.userById(req.user.id);
      if (!user || !user.master_id || masterId !== user.master_id) {
        return res.status(403).json({ error: { message: 'Мастер может создавать записи только в свой график.', code: 'FORBIDDEN' } });
      }
    }

    // Клиент, на которого создаём запись.
    // owner/master записывают клиента по client_id из тела (административная
    // функция сотрудника), client — всегда сам.
    let clientId;
    if (req.user.role === 'owner' || req.user.role === 'master') {
      clientId = req.body.client_id === undefined ? null : v.intId(req.body.client_id, 'client_id');
      if (!clientId || !q.clientById(clientId)) {
        return res.status(400).json({ error: { message: 'Укажите существующего клиента (client_id).', code: 'CLIENT_REQUIRED' } });
      }
    } else {
      clientId = q.clientIdForUser(req.user.id);
      if (!clientId) {
        return res.status(403).json({ error: { message: 'Профиль клиента не найден.', code: 'NO_CLIENT_PROFILE' } });
      }
    }

    let startsLocal;
    let endsLocal;
    let tokenHash = null;

    // Путь 1: создаём по удержанному слоту
    if (useHold) {
      tokenHash = crypto.createHash('sha256').update(String(holdToken)).digest('hex');
      const hold = q.holdByTokenHash(tokenHash);
      if (!hold) {
        return res.status(409).json({ error: { message: 'Удержание не найдено.', code: 'HOLD_NOT_FOUND' } });
      }
      if (hold.status !== 'active') {
        return res.status(409).json({ error: { message: 'Удержание уже неактивно.', code: 'HOLD_INACTIVE' } });
      }
      if (hold.expires_at <= nowDbLocal()) {
        q.purgeExpiredHolds();
        return res.status(409).json({ error: { message: 'Удержание истекло — повторите выбор времени.', code: 'HOLD_EXPIRED' } });
      }
      if (hold.created_by !== req.user.id && req.user.role !== 'owner') {
        return res.status(403).json({ error: { message: 'Недостаточно прав.', code: 'FORBIDDEN' } });
      }
      if (hold.master_id !== masterId || hold.duration_minutes !== service.duration_minutes) {
        return res.status(400).json({
          error: { message: 'Удержание не соответствует выбранным услуге/мастеру.', code: 'HOLD_MISMATCH' },
        });
      }
      startsLocal = hold.starts_at;
      endsLocal = hold.ends_at;
    } else {
      // Путь 2: без удержания — слот должен быть свободен в момент запроса.
      // Осознанное наложение (force_override, только owner) пропускает эту
      // проверку: её заменит сам триггер, который для force_override = 1
      // разрешает пересечение с другими записями мастера.
      const startUtc = parseUtcIso(req.body.starts_at);
      const endsAtUtc = new Date(startUtc.getTime() + service.duration_minutes * 60000);
      if (!forceOverride) {
        assertSlotFree(masterId, startUtc, endsAtUtc);
      }
      startsLocal = toDbLocal(startUtc);
      endsLocal = toDbLocal(endsAtUtc);
    }

    let bookingId;
    try {
      bookingId = db.transaction(() => {
        // Помечаем удержание «used» атомарно внутри транзакции: если другой
        // запрос уже успел создать запись по этому же токену, changes будет 0.
        if (useHold && tokenHash) {
          const hold = q.holdByTokenHash(tokenHash);
          const ok = hold && q.markHoldUsed(hold.id);
          if (!ok) {
            const err = new Error('Удержание уже использовано — слот мог быть занят другим клиентом.');
            err.status = 409;
            throw err;
          }
        }
        return q.createBooking({
          clientId, serviceId, masterId, startsAtLocal: startsLocal, endsAtLocal: endsLocal,
          comment, source: SOURCE, forceOverride,
        });
      })();
    } catch (err) {
      // Триггер trg_bookings_no_overlap_insert запретил пересечение.
      if (isBookingTimeConflict(err)) {
        return sendSlotConflict(res, masterId, service.duration_minutes);
      }
      throw err;
    }

    return res.status(201).json({ booking: q.serializeBooking(q.bookingDetail(bookingId)) });
  })
);

// GET /bookings — записи текущего пользователя.
// client — свои; master — записи своего мастера; owner — все (фильтры из query).
router.get(
  '/',
  authRequired,
  asyncH(async (req, res) => {
    if (req.user.role === 'client') {
      const clientId = q.clientIdForUser(req.user.id);
      return res.json({ bookings: clientId ? q.listBookings({ clientId }) : [] });
    }
    if (req.user.role === 'master') {
      const user = q.userById(req.user.id);
      return res.json({ bookings: user && user.master_id ? q.listBookings({ masterId: user.master_id }) : [] });
    }
    // owner — все записи с опциональными фильтрами
    const { status } = req.query;
    const statusOut = status === undefined
      ? null
      : v.enumValue(status, 'status', ['wait', 'confirmed', 'done', 'canceled']);
    const fromLocal = req.query.from === undefined ? undefined : toDbLocal(parseUtcIso(req.query.from));
    const toLocal = req.query.to === undefined ? undefined : toDbLocal(parseUtcIso(req.query.to));
    const bookings = q.listBookings({ status: statusOut, fromLocal, toLocal });
    return res.json({ bookings });
  })
);

// GET /bookings/:id — детали записи.
router.get(
  '/:id',
  authRequired,
  asyncH(async (req, res) => {
    const bookingId = v.intId(req.params.id, 'id');
    const row = q.bookingDetail(bookingId);
    if (!row) return res.status(404).json({ error: { message: 'Запись не найдена.', code: 'NOT_FOUND' } });
    checkAccess(req.user, row);
    return res.json({ booking: q.serializeBooking(row) });
  })
);

// PATCH /bookings/:id — перенос записи на другое время.
// body: { starts_at (UTC ISO) }
router.patch(
  '/:id',
  authRequired,
  asyncH(async (req, res) => {
    const bookingId = v.intId(req.params.id, 'id');
    const row = q.bookingDetail(bookingId);
    if (!row) return res.status(404).json({ error: { message: 'Запись не найдена.', code: 'NOT_FOUND' } });
    checkAccess(req.user, row);
    if (!['wait', 'confirmed'].includes(row.status)) {
      return res.status(400).json({
        error: { message: 'Переносить можно только активную запись.', code: 'BOOKING_NOT_MOVABLE' },
      });
    }

    const startUtc = parseUtcIso(req.body.starts_at);
    const totalMinutes = row.service_duration;
    const endUtc = new Date(startUtc.getTime() + totalMinutes * 60000);
    assertSlotFree(row.master_id, startUtc, endUtc);

    try {
      db.transaction(() => {
        q.moveBooking(bookingId, toDbLocal(startUtc), toDbLocal(endUtc));
      })();
    } catch (err) {
      // Триггер trg_bookings_no_overlap_update запретил перенос на занятое время.
      if (isBookingTimeConflict(err)) {
        return sendSlotConflict(res, row.master_id, totalMinutes);
      }
      throw err;
    }

    return res.json({ booking: q.serializeBooking(q.bookingDetail(bookingId)) });
  })
);

// POST /bookings/:id/cancel — отмена записи.
router.post(
  '/:id/cancel',
  authRequired,
  asyncH(async (req, res) => {
    const bookingId = v.intId(req.params.id, 'id');
    const row = q.bookingDetail(bookingId);
    if (!row) return res.status(404).json({ error: { message: 'Запись не найдена.', code: 'NOT_FOUND' } });
    checkAccess(req.user, row);
    if (!['wait', 'confirmed'].includes(row.status)) {
      return res.status(400).json({
        error: { message: 'Отменить можно только активную запись.', code: 'BOOKING_NOT_CANCELABLE' },
      });
    }
    q.setBookingStatus(bookingId, 'canceled');
    return res.json({ booking: q.serializeBooking(q.bookingDetail(bookingId)) });
  })
);

function checkAccess(user, row) {
  if (user.role === 'owner') return;
  if (user.role === 'master') {
    const u = q.userById(user.id);
    if (u && u.master_id === row.master_id) return;
  }
  if (user.role === 'client') {
    const clientId = q.clientIdForUser(user.id);
    if (clientId === row.client_id) return;
  }
  const err = new Error('Недостаточно прав.');
  err.status = 403;
  throw err;
}

module.exports = router;