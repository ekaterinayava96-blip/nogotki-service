'use strict';

// Свободное время мастера на дату + удержание выбранного слота.

const express = require('express');
const crypto = require('crypto');

const db = require('../db/connection');
const q = require('../repo/queries');
const { freeSlots } = require('../lib/availability');
const { parseUtcIso, parseSalonDate, nowDbLocal, toDbLocal, salonDayStart } = require('../lib/time');
const v = require('../lib/validate');
const { asyncH } = require('../lib/http');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

const HOLD_TTL_MINUTES = 10; // сколько держим слот на время оформления

// GET /masters/:id/slots?date=YYYY-MM-DD&service_ids=2,3  (+&duration_minutes=.. запас)
// date — календарный день в локальном времени салона (параметр даты).
// Суммарная длительность = сумма длительностей переданных услуг (или duration_minutes).
router.get(
  '/masters/:id/slots',
  asyncH(async (req, res) => {
    const masterId = v.intId(req.params.id, 'id');
    const master = q.masterById(masterId);
    if (master.is_active !== 1) {
      return res.status(404).json({ error: { message: 'Мастер не найден.', code: 'NOT_FOUND' } });
    }

    const dateStartUtc = parseSalonDate(req.query.date);
    const serviceIds = v.idList(req.query.service_ids, 'service_ids');

    let totalMinutes;
    let durationSource;
    if (serviceIds.length > 0) {
      const services = q.listServices({ activeOnly: true }).filter((s) => serviceIds.includes(s.id));
      if (services.length !== serviceIds.length) {
        return res.status(400).json({
          error: { message: 'Одна из услуг не существует или отключена.', code: 'UNKNOWN_SERVICE' },
        });
      }
      totalMinutes = services.reduce((sum, s) => sum + s.duration_minutes, 0);
      durationSource = 'services';
    } else if (req.query.duration_minutes !== undefined) {
      totalMinutes = v.positiveInt(req.query.duration_minutes, 'duration_minutes');
      durationSource = 'duration_minutes';
    } else {
      return res.status(400).json({
        error: { message: 'Укажите service_ids или duration_minutes.', code: 'MISSING_DURATION' },
      });
    }

    const slots = freeSlots({
      masterId,
      dateStartUtc,
      totalMinutes,
      stepMinutes: v.positiveInt(req.query.step_minutes || 30, 'step_minutes'),
    });

    res.json({
      master_id: masterId,
      date: req.query.date,
      duration_minutes: totalMinutes,
      duration_source: durationSource,
      slots,
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

    const startUtc = parseUtcIso(req.body.starts_at);
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
      return res.status(409).json({
        error: { message: 'Слот занят или ещё не подтверждён как свободный.', code: 'SLOT_CONFLICT' },
      });
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
      });
    } catch (err) {
      // Уникальный индекс idx_holds_active_slot не даёт двум клиентам
      // удержать один и тот же слот: второй получит SQLITE_CONSTRAINT.
      const isUnique = /UNIQUE constraint failed/i.test(err.message);
      if (isUnique) {
        return res.status(409).json({
          error: { message: 'Слот только что занял другой клиент.', code: 'SLOT_CONFLICT' },
        });
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
    if (hold.created_by !== req.user.id && req.user.role !== 'owner') {
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