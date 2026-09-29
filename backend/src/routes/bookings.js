'use strict';

// Записи: создание (в т.ч. по удержанию), просмотр своих, детали,
// перенос и отмена.

const express = require('express');
const crypto = require('crypto');

const db = require('../db/connection');
const q = require('../repo/queries');
const { parseUtcIso, toDbLocal, salonDayStart, nowDbLocal, assertNotPast } = require('../lib/time');
const v = require('../lib/validate');
const { asyncH, isBookingTimeConflict, sendSlotConflict } = require('../lib/http');
const { requireRole, authRequired, hasRole } = require('../middleware/auth');
const { freeSlots } = require('../lib/availability');

const router = express.Router();

const SOURCE = 'web'; // API-записи приходят из веб-формы сайта

// Проверка, что интервал [startUtc, endUtc) свободен у мастера (без записи
// произвольного перекрытия). Используем вычисление свободных слотов с шагом 1.
// Занятый слот — это 409 с nearest_free (sendSlotConflict), а не голый «Слот занят.»:
// клиентский экран показывает по этой подсказке ближайшие свободные окна, и без
// неё экран конфликта (Booking 04b) остаётся пустым.
function slotIsFree(masterId, startUtc, totalMinutes) {
  const slots = freeSlots({
    masterId,
    dateStartUtc: salonDayStart(startUtc),
    totalMinutes,
    stepMinutes: 1,
  });
  return slots.some((s) => s.starts_at === startUtc.toISOString());
}

// Проверка занятости с ответом клиенту. true — слот свободен и можно идти дальше;
// false — ответ с подсказками уже отправлен, обработчик обязан выйти.
function checkSlotFree(res, masterId, startUtc, totalMinutes) {
  if (slotIsFree(masterId, startUtc, totalMinutes)) return true;
  sendSlotConflict(res, masterId, totalMinutes);
  return false;
}

// Услуги записи из тела запроса: новый формат service_ids (одна или несколько
// услуг, порядок выбора сохраняется) и старый service_id (одна услуга).
function readBookingServiceIds(body) {
  const hasList = body.service_ids !== undefined && body.service_ids !== null && body.service_ids !== '';
  if (hasList) return v.idList(body.service_ids, 'service_ids');
  if (body.service_id === undefined || body.service_id === null || body.service_id === '') return [];
  return [v.intId(body.service_id, 'service_id')];
}

// Одинаковый состав услуг (порядок не важен).
function sameIdSet(a, b) {
  return a.length === b.length
    && [...a].sort((x, y) => x - y).join(',') === [...b].sort((x, y) => x - y).join(',');
}

// POST /bookings — создать запись.
// body: { service_ids: [..] (или service_id — одна услуга), master_id,
//         starts_at (UTC ISO), hold_token?, comment?, force_override? }
// Запись может закрывать несколько услуг: длительность слота и сумма считаются
// по всему набору, мастер должен выполнять каждую из них.
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
    const serviceIds = readBookingServiceIds(req.body);
    if (serviceIds.length === 0) {
      return res.status(400).json({ error: { message: 'Укажите услуги: service_ids или service_id.', code: 'MISSING_SERVICES' } });
    }
    const masterId = v.intId(req.body.master_id, 'master_id');
    const comment = req.body.comment === undefined ? null : v.str(req.body.comment, 'comment', { max: 500 });
    const holdToken = req.body.hold_token;
    const useHold = holdToken !== undefined && holdToken !== null && holdToken !== '';

    // Проверка роли: признак наложения создаёт запись поверх занятого времени,
    // поэтому это административная возможность. У client/master поле в запросе
    // просто не читается — эффект тот же, что и при отсутствии поля.
    const wantForce = v.bool(req.body.force_override, 'force_override');
    const forceOverride = hasRole(req.user, 'owner') ? (wantForce ?? 0) : 0;

    // Услуги в порядке выбора клиента. Суммарная длительность набора —
    // столько слот должен занять у мастера.
    const active = q.listServices({ activeOnly: true });
    const services = serviceIds.map((id) => active.find((s) => s.id === id));
    if (services.some((s) => !s)) {
      return res.status(400).json({ error: { message: 'Одна из услуг не найдена или отключена.', code: 'UNKNOWN_SERVICE' } });
    }
    const totalMinutes = services.reduce((sum, s) => sum + s.duration_minutes, 0);
    const master = q.masterById(masterId);
    if (!master || master.is_active !== 1) {
      return res.status(400).json({ error: { message: 'Мастер не найден.', code: 'UNKNOWN_MASTER' } });
    }
    // Мастер должен выполнять КАЖДУЮ услугу набора: комплекс из двух услуг, одну
    // из которых мастер не делает, у него принять нельзя.
    const masterServiceIds = db
      .prepare('SELECT service_id FROM master_services WHERE master_id = ?')
      .all(masterId)
      .map((r) => r.service_id);
    const missing = services.filter((s) => !masterServiceIds.includes(s.id));
    if (missing.length) {
      return res.status(400).json({
        error: {
          message: missing.length === 1
            ? 'Мастер не выполняет эту услугу.'
            : `Мастер не выполняет услуги: ${missing.map((s) => s.name).join(', ')}.`,
          code: 'MASTER_SERVICE_MISMATCH',
          services: missing.map((s) => ({ id: s.id, name: s.name })),
        },
      });
    }

    // Мастер (роль) создаёт записи только в свой график — отличия в правах
    // ролей допустимы, сам путь создания записи общий (createBooking).
    if (hasRole(req.user, 'master')) {
      const user = q.userById(req.user.id);
      if (!user || !user.master_id || masterId !== user.master_id) {
        return res.status(403).json({ error: { message: 'Мастер может создавать записи только в свой график.', code: 'FORBIDDEN' } });
      }
    }

    // Клиент, на которого создаём запись.
    // owner/master записывают клиента по client_id из тела (административная
    // функция сотрудника), client — всегда сам.
    let clientId;
    if (hasRole(req.user, 'owner') || hasRole(req.user, 'master')) {
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
      if (hold.created_by !== req.user.id && !hasRole(req.user, 'owner')) {
        return res.status(403).json({ error: { message: 'Недостаточно прав.', code: 'FORBIDDEN' } });
      }
      // Удержание сверяем по НАБОРУ услуг, а не по длительности: два разных
      // набора могут дать одинаковое число минут. Удержания, созданные до
      // миграции 008, услуг не хранят — для них остаётся сверка по минутам
      // (живут 10 минут, затем чистятся по expires_at).
      const holdServiceIds = q.holdServiceIds(hold.id);
      const holdMatches = holdServiceIds.length
        ? sameIdSet(holdServiceIds, serviceIds)
        : hold.duration_minutes === totalMinutes;
      if (hold.master_id !== masterId || !holdMatches) {
        return res.status(400).json({
          error: { message: 'Удержание не соответствует выбранным услугам/мастеру.', code: 'HOLD_MISMATCH' },
        });
      }
      startsLocal = hold.starts_at;
      endsLocal = hold.ends_at;
    } else {
      // Путь 2: без удержания — слот должен быть свободен в момент запроса.
      // Осознанное наложение (force_override, только owner) пропускает эту
      // проверку: её заменит сам триггер, который для force_override = 1
      // разрешает пересечение с другими записями мастера.
      const startUtc = assertNotPast(parseUtcIso(req.body.starts_at), 'starts_at');
      const endsAtUtc = new Date(startUtc.getTime() + totalMinutes * 60000);
      if (!forceOverride && !checkSlotFree(res, masterId, startUtc, totalMinutes)) return;
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
          clientId, serviceIds, masterId, startsAtLocal: startsLocal, endsAtLocal: endsLocal,
          comment, source: SOURCE, forceOverride,
        });
      })();
    } catch (err) {
      // Триггер trg_bookings_no_overlap_insert запретил пересечение.
      if (isBookingTimeConflict(err)) {
        return sendSlotConflict(res, masterId, totalMinutes);
      }
      throw err;
    }

    return res.status(201).json({ booking: q.serializedBooking(bookingId) });
  })
);

// GET /bookings — записи текущего пользователя.
// client — свои; master — записи своего мастера; owner — все (фильтры из query).
router.get(
  '/',
  authRequired,
  asyncH(async (req, res) => {
    if (hasRole(req.user, 'client')) {
      const clientId = q.clientIdForUser(req.user.id);
      return res.json({ bookings: clientId ? q.listBookings({ clientId }) : [] });
    }
    if (hasRole(req.user, 'master')) {
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
    return res.json({ booking: q.serializeBooking(row, q.servicesOfBooking(bookingId)) });
  })
);

// PATCH /bookings/:id — перенос записи на другое время.
// body: { starts_at (UTC ISO), master_id? }
// master_id необязателен: без него мастер записи сохраняется; с ним запись
// переносится на время этого мастера. Проверки (мастер выполняет услугу,
// слот свободен, триггер от пересечения) — те же, что при создании записи.
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

    let effectiveMasterId = row.master_id;
    // Длительность записи = сумма её услуг: перенос должен занять столько же
    // времени, сколько занимала сама запись.
    const bookingServices = q.servicesOfBooking(bookingId);
    const totalMinutes = (bookingServices.length ? bookingServices : [q.serviceById(row.service_id)])
      .reduce((sum, s) => sum + s.duration_minutes, 0);
    if (req.body.master_id !== undefined) {
      const masterId = v.intId(req.body.master_id, 'master_id');
      const master = q.masterById(masterId);
      if (!master || master.is_active !== 1) {
        return res.status(400).json({ error: { message: 'Мастер не найден.', code: 'UNKNOWN_MASTER' } });
      }
      // Новый мастер должен выполнять все услуги записи (как при создании).
      const masterServiceIds = db
        .prepare('SELECT service_id FROM master_services WHERE master_id = ?')
        .all(masterId)
        .map((r) => r.service_id);
      const missing = bookingServices.filter((s) => !masterServiceIds.includes(s.id));
      if (missing.length) {
        return res.status(400).json({
          error: {
            message: missing.length === 1
              ? 'Мастер не выполняет эту услугу.'
              : `Мастер не выполняет услуги: ${missing.map((s) => s.name).join(', ')}.`,
            code: 'MASTER_SERVICE_MISMATCH',
            services: missing.map((s) => ({ id: s.id, name: s.name })),
          },
        });
      }
      // Та же логика, что при создании записи: роль master ведёт записи
      // только в свой график.
      if (hasRole(req.user, 'master')) {
        const user = q.userById(req.user.id);
        if (!user || !user.master_id || masterId !== user.master_id) {
          return res.status(403).json({ error: { message: 'Мастер может вести записи только в свой график.', code: 'FORBIDDEN' } });
        }
      }
      effectiveMasterId = masterId;
    }

    const startUtc = assertNotPast(parseUtcIso(req.body.starts_at), 'starts_at');
    const endUtc = new Date(startUtc.getTime() + totalMinutes * 60000);
    if (!checkSlotFree(res, effectiveMasterId, startUtc, totalMinutes)) return;

    try {
      db.transaction(() => {
        q.moveBooking(bookingId, toDbLocal(startUtc), toDbLocal(endUtc), effectiveMasterId);
      })();
    } catch (err) {
      // Триггер trg_bookings_no_overlap_update запретил перенос на занятое время.
      if (isBookingTimeConflict(err)) {
        return sendSlotConflict(res, effectiveMasterId, totalMinutes);
      }
      throw err;
    }

    return res.json({ booking: q.serializedBooking(bookingId) });
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
    return res.json({ booking: q.serializedBooking(bookingId) });
  })
);

function checkAccess(user, row) {
  if (hasRole(user, 'owner')) return;
  if (hasRole(user, 'master')) {
    const u = q.userById(user.id);
    if (u && u.master_id === row.master_id) return;
  }
  if (hasRole(user, 'client')) {
    const clientId = q.clientIdForUser(user.id);
    if (clientId === row.client_id) return;
  }
  const err = new Error('Недостаточно прав.');
  err.status = 403;
  throw err;
}

module.exports = router;