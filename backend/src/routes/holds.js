'use strict';

// Свободное время мастера на дату + удержание выбранного слота.

const express = require('express');
const crypto = require('crypto');

const db = require('../db/connection');
const q = require('../repo/queries');
const { freeSlots, dayPlan, rangeAvailability } = require('../lib/availability');
const { parseUtcIso, parseSalonDate, nowDbLocal, toDbLocal, salonDayStart, assertNotPast } = require('../lib/time');
const v = require('../lib/validate');
const { asyncH, sendSlotConflict } = require('../lib/http');
const { requireRole, hasRole } = require('../middleware/auth');

const router = express.Router();

const HOLD_TTL_MINUTES = 10; // сколько держим слот на время оформления

const MAX_AVAILABILITY_DAYS = 62; // ограничение диапазона календаря (2 месяца)

// Длительность визита по набору услуг (или явному duration_minutes) — общая
// проверка для списка слотов и сводки по календарю.
function resolveDuration(req) {
  const serviceIds = v.idList(req.query.service_ids, 'service_ids');
  if (serviceIds.length > 0) {
    const services = q.listServices({ activeOnly: true }).filter((s) => serviceIds.includes(s.id));
    if (services.length !== serviceIds.length) {
      const err = new Error('Одна из услуг не существует или отключена.');
      err.status = 400;
      err.code = 'UNKNOWN_SERVICE';
      throw err;
    }
    return {
      serviceIds,
      totalMinutes: services.reduce((sum, s) => sum + s.duration_minutes, 0),
      durationSource: 'services',
    };
  }
  if (req.query.duration_minutes !== undefined) {
    return {
      serviceIds: [],
      totalMinutes: v.positiveInt(req.query.duration_minutes, 'duration_minutes'),
      durationSource: 'duration_minutes',
    };
  }
  const err = new Error('Укажите service_ids или duration_minutes.');
  err.status = 400;
  err.code = 'MISSING_DURATION';
  throw err;
}

function requireActiveMaster(id) {
  const master = q.masterById(id);
  if (!master || master.is_active !== 1) {
    const err = new Error('Мастер не найден.');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
  return master;
}

// GET /masters/:id/slots?date=YYYY-MM-DD&service_ids=2,3  (+&duration_minutes=.. запас)
// date — календарный день в локальном времени салона (параметр даты).
// Суммарная длительность = сумма длительностей переданных услуг (или duration_minutes).
// Кроме списка свободных окон (slots) отдаём cells — сетку дня целиком, где у
// каждого окна есть состояние free/busy/past: клиент показывает занятое время,
// а не прячет его, и ничего не вычисляет сам.
router.get(
  '/masters/:id/slots',
  asyncH(async (req, res) => {
    const masterId = v.intId(req.params.id, 'id');
    requireActiveMaster(masterId);

    const dateStartUtc = parseSalonDate(req.query.date);
    const { totalMinutes, durationSource } = resolveDuration(req);
    const stepMinutes = v.positiveInt(req.query.step_minutes || 30, 'step_minutes');

    const plan = dayPlan({ masterId, dateStartUtc, totalMinutes, stepMinutes });

    res.json({
      master_id: masterId,
      date: req.query.date,
      duration_minutes: totalMinutes,
      duration_source: durationSource,
      is_workday: plan.is_workday,
      window: plan.window,
      reason: plan.reason,
      cells: plan.cells,
      slots: plan.cells
        .filter((c) => c.state === 'free')
        .map((c) => ({ starts_at: c.starts_at, ends_at: c.ends_at })),
    });
  })
);

// GET /masters/:id/availability?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&service_ids=2,3
// Сводка по дням диапазона для календаря месяца: есть ли свободные окна, сколько
// их, первое окно дня и ближайшее свободное время после этого дня (next_free
// ищется в пределах диапазона). Всё считает сервер — клиент рисует по готовым данным.
router.get(
  '/masters/:id/availability',
  asyncH(async (req, res) => {
    const masterId = v.intId(req.params.id, 'id');
    requireActiveMaster(masterId);

    const from = parseSalonDate(req.query.date_from);
    const to = parseSalonDate(req.query.date_to);
    const days = Math.round((to.getTime() - from.getTime()) / (24 * 3600 * 1000)) + 1;
    if (days < 1) {
      const err = new Error('date_to должен быть не раньше date_from.');
      err.status = 400;
      err.code = 'BAD_RANGE';
      throw err;
    }
    if (days > MAX_AVAILABILITY_DAYS) {
      const err = new Error(`Диапазон не больше ${MAX_AVAILABILITY_DAYS} дней.`);
      err.status = 400;
      err.code = 'RANGE_TOO_LONG';
      throw err;
    }

    const { totalMinutes, durationSource } = resolveDuration(req);
    const stepMinutes = v.positiveInt(req.query.step_minutes || 30, 'step_minutes');

    res.json({
      master_id: masterId,
      date_from: req.query.date_from,
      date_to: req.query.date_to,
      duration_minutes: totalMinutes,
      duration_source: durationSource,
      days: rangeAvailability({ masterId, dateFromUtc: from, days, totalMinutes, stepMinutes }),
    });
  })
);

// POST /holds — удержать слот на время оформления.
// body: { master_id, starts_at (UTC ISO), service_ids: [..] }.
// Ответ: hold_id, token (одноразовый секрет для создания записи), expires_at.
router.post(
  '/holds',
  requireRole('client', 'owner'),
  asyncH(async (req, res) => {
    const masterId = v.intId(req.body.master_id, 'master_id');
    const serviceIds = v.idList(req.body.service_ids, 'service_ids');
    if (serviceIds.length === 0) {
      return res.status(400).json({ error: { message: 'service_ids обязателен.', code: 'MISSING_SERVICES' } });
    }

    const master = q.masterById(masterId);
    if (!master || master.is_active !== 1) {
      return res.status(404).json({ error: { message: 'Мастер не найден.', code: 'NOT_FOUND' } });
    }

    const services = q.listServices({ activeOnly: true }).filter((s) => serviceIds.includes(s.id));
    if (services.length !== serviceIds.length) {
      return res.status(400).json({
        error: { message: 'Одна из услуг не существует или отключена.', code: 'UNKNOWN_SERVICE' },
      });
    }
    const totalMinutes = services.reduce((sum, s) => sum + s.duration_minutes, 0);

    const startUtc = assertNotPast(parseUtcIso(req.body.starts_at), 'starts_at');
    const endsAtUtc = new Date(startUtc.getTime() + totalMinutes * 60000);

    // Проверяем: слот свободен именно в этот момент (точное попадание)
    const slots = freeSlots({
      masterId,
      dateStartUtc: salonDayStart(startUtc),
      totalMinutes,
      stepMinutes: 1,
    });
    const exact = slots.some((s) => s.starts_at === startUtc.toISOString());
    if (!exact) {
      // Слот заняли между показом сетки и нажатием. Отдаём ближайшие свободные
      // окна, иначе клиент увидит только ошибку и не поймёт, куда делось время,
      // которое минуту назад было свободным.
      return sendSlotConflict(res, masterId, totalMinutes, 'SLOT_CONFLICT');
    }

    const token = crypto.randomBytes(24).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + HOLD_TTL_MINUTES * 60000);

    let holdId;
    try {
      holdId = q.createHold({
        masterId,
        startsAtLocal: toDbLocal(startUtc),
        endsAtLocal: toDbLocal(endsAtUtc),
        totalMinutes,
        tokenHash,
        createdBy: req.user.id,
        expiresAtLocal: toDbLocal(expiresAt),
        // Набор услуг сохраняем в удержании: по нему при создании записи
        // проверяется, что удержание относится именно к этому комплексу.
        serviceIds,
      });
    } catch (err) {
      // Уникальный индекс idx_holds_active_slot не даёт двум клиентам
      // удержать один и тот же слот: второй получит SQLITE_CONSTRAINT.
      const isUnique = /UNIQUE constraint failed/i.test(err.message);
      if (isUnique) {
        return sendSlotConflict(res, masterId, totalMinutes, 'SLOT_CONFLICT');
      }
      throw err;
    }

    res.status(201).json({
      hold_id: holdId,
      token,
      expires_at: expiresAt.toISOString(),
      master_id: masterId,
      starts_at: startUtc.toISOString(),
      ends_at: endsAtUtc.toISOString(),
      duration_minutes: totalMinutes,
    });
  })
);

// DELETE /holds/:id — снять удержание (владелец удержания или владелец студии)
router.delete(
  '/holds/:id',
  requireRole('client', 'owner'),
  asyncH(async (req, res) => {
    const holdId = v.intId(req.params.id, 'id');
    const hold = q.holdById(holdId);
    if (!hold) return res.status(404).json({ error: { message: 'Удержание не найдено.', code: 'NOT_FOUND' } });
    if (hold.created_by !== req.user.id && !hasRole(req.user, 'owner')) {
      return res.status(403).json({ error: { message: 'Недостаточно прав.', code: 'FORBIDDEN' } });
    }
    if (hold.status !== 'active') {
      return res.status(409).json({ error: { message: 'Удержание уже неактивно.', code: 'HOLD_INACTIVE' } });
    }
    q.markHoldCanceled(holdId);
    res.status(204).end();
  })
);

module.exports = router;