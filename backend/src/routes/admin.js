'use strict';

// Административные эндпоинты — только для роли owner.

const express = require('express');

const db = require('../db/connection');
const q = require('../repo/queries');
const { parseUtcIso, toDbLocal, nowDbLocal } = require('../lib/time');
const v = require('../lib/validate');
const { asyncH, isBookingTimeConflict, sendSlotConflict } = require('../lib/http');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireRole('owner'));

// ---------- Записи ----------

// GET /admin/bookings — все записи с фильтрами: ?status=&from=&to=&master_id=
router.get(
  '/bookings',
  asyncH(async (req, res) => {
    const status = req.query.status === undefined
      ? null
      : v.enumValue(req.query.status, 'status', ['wait', 'confirmed', 'done', 'canceled']);
    const masterId = req.query.master_id === undefined ? null : v.intId(req.query.master_id, 'master_id');
    const fromLocal = req.query.from === undefined ? undefined : toDbLocal(parseUtcIso(req.query.from));
    const toLocal = req.query.to === undefined ? undefined : toDbLocal(parseUtcIso(req.query.to));
    const bookings = q.listBookings({ status, masterId, fromLocal, toLocal });
    return res.json({ bookings });
  })
);

// PATCH /admin/bookings/:id — смена статуса записи администратором.
// body: { status: 'wait'|'confirmed'|'done'|'canceled' }
router.patch(
  '/bookings/:id',
  asyncH(async (req, res) => {
    const bookingId = v.intId(req.params.id, 'id');
    const status = v.enumValue(req.body.status, 'status', ['wait', 'confirmed', 'done', 'canceled']);
    const row = q.bookingDetail(bookingId);
    if (!row) return res.status(404).json({ error: { message: 'Запись не найдена.', code: 'NOT_FOUND' } });
    try {
      q.setBookingStatus(bookingId, status);
    } catch (err) {
      // Триггер trg_bookings_no_overlap_update: смена статуса на активный
      // на пересечении с другой активной записью мастера запрещена.
      if (isBookingTimeConflict(err) && status !== 'canceled') {
        return sendSlotConflict(res, row.master_id, row.service_duration);
      }
      throw err;
    }
    return res.json({ booking: q.serializeBooking(q.bookingDetail(bookingId)) });
  })
);

// ---------- Услуги ----------

// GET /admin/services — все услуги (включая неактивные)
router.get(
  '/services',
  asyncH(async (req, res) => {
    return res.json({ services: q.listServices({ activeOnly: false }) });
  })
);

// POST /admin/services — создать услугу
router.post(
  '/services',
  asyncH(async (req, res) => {
    const name = v.str(req.body.name, 'name', { min: 2, max: 100 });
    const description = v.str(req.body.description, 'description', { max: 500 });
    const priceKopecks = v.nonNegInt(req.body.price_kopecks, 'price_kopecks');
    const durationMinutes = v.positiveInt(req.body.duration_minutes, 'duration_minutes');
    const isActive = v.bool(req.body.is_active, 'is_active') ?? 1;

    if (db.prepare('SELECT 1 AS hit FROM services WHERE name = ?').get(name)) {
      return res.status(409).json({ error: { message: 'Услуга с таким названием уже есть.', code: 'NAME_TAKEN' } });
    }

    const id = db
      .prepare("INSERT INTO services (name, description, price_kopecks, duration_minutes, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(name, description, priceKopecks, durationMinutes, isActive, nowDbLocal()).lastInsertRowid;
    return res.status(201).json({ service: q.serviceById(id) });
  })
);

// PATCH /admin/services/:id — изменить услугу (частично)
router.patch(
  '/services/:id',
  asyncH(async (req, res) => {
    const id = v.intId(req.params.id, 'id');
    const existing = q.serviceById(id);
    if (!existing) return res.status(404).json({ error: { message: 'Услуга не найдена.', code: 'NOT_FOUND' } });

    const name = req.body.name === undefined ? existing.name : v.str(req.body.name, 'name', { min: 2, max: 100 });
    const description = req.body.description === undefined ? existing.description : v.str(req.body.description, 'description', { max: 500 });
    const priceKopecks = req.body.price_kopecks === undefined ? existing.price_kopecks : v.nonNegInt(req.body.price_kopecks, 'price_kopecks');
    const durationMinutes = req.body.duration_minutes === undefined ? existing.duration_minutes : v.positiveInt(req.body.duration_minutes, 'duration_minutes');
    const isActive = req.body.is_active === undefined ? existing.is_active : v.bool(req.body.is_active, 'is_active');

    if (name !== existing.name && db.prepare('SELECT 1 AS hit FROM services WHERE name = ?').get(name)) {
      return res.status(409).json({ error: { message: 'Услуга с таким названием уже есть.', code: 'NAME_TAKEN' } });
    }

    db.prepare(
      'UPDATE services SET name = ?, description = ?, price_kopecks = ?, duration_minutes = ?, is_active = ?, updated_at = ? WHERE id = ?'
    ).run(name, description, priceKopecks, durationMinutes, isActive, nowDbLocal(), id);
    return res.json({ service: q.serviceById(id) });
  })
);

// DELETE /admin/services/:id — удалить услугу (только если на неё нет записей)
router.delete(
  '/services/:id',
  asyncH(async (req, res) => {
    const id = v.intId(req.params.id, 'id');
    if (!q.serviceById(id)) return res.status(404).json({ error: { message: 'Услуга не найдена.', code: 'NOT_FOUND' } });
    const hasBookings = db.prepare('SELECT 1 AS hit FROM bookings WHERE service_id = ? LIMIT 1').get(id);
    if (hasBookings) {
      return res.status(409).json({
        error: { message: 'Нельзя удалить услугу с записями — отключите её.', code: 'SERVICE_IN_USE' },
      });
    }
    db.transaction(() => {
      db.prepare('DELETE FROM master_services WHERE service_id = ?').run(id);
      db.prepare('DELETE FROM services WHERE id = ?').run(id);
    })();
    return res.status(204).end();
  })
);

// ---------- Мастера ----------

// GET /admin/masters — все мастера (включая неактивных)
router.get(
  '/masters',
  asyncH(async (req, res) => {
    return res.json({ masters: q.listMasters({ activeOnly: false }) });
  })
);

// POST /admin/masters — создать мастера
// body: { name, role, experience_years, service_ids: [] }
router.post(
  '/masters',
  asyncH(async (req, res) => {
    const name = v.str(req.body.name, 'name', { min: 2, max: 100 });
    const role = v.str(req.body.role, 'role', { min: 2, max: 100 });
    const experienceYears = v.nonNegInt(req.body.experience_years ?? 0, 'experience_years');
    const serviceIds = v.idList(req.body.service_ids, 'service_ids');
    const isActive = v.bool(req.body.is_active, 'is_active') ?? 1;
    assertServicesExist(serviceIds);

    const id = db
      .prepare('INSERT INTO masters (name, role, experience_years, is_active, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, role, experienceYears, isActive, nowDbLocal()).lastInsertRowid;

    attachServices(id, serviceIds);
    return res.status(201).json({ master: publicMaster(id) });
  })
);

// PATCH /admin/masters/:id — изменить данные мастера; service_ids заменяет набор
router.patch(
  '/masters/:id',
  asyncH(async (req, res) => {
    const id = v.intId(req.params.id, 'id');
    const existing = q.masterById(id);
    if (!existing) return res.status(404).json({ error: { message: 'Мастер не найден.', code: 'NOT_FOUND' } });

    const name = req.body.name === undefined ? existing.name : v.str(req.body.name, 'name', { min: 2, max: 100 });
    const role = req.body.role === undefined ? existing.role : v.str(req.body.role, 'role', { min: 2, max: 100 });
    const experienceYears = req.body.experience_years === undefined ? existing.experience_years : v.nonNegInt(req.body.experience_years, 'experience_years');
    const isActive = req.body.is_active === undefined ? existing.is_active : v.bool(req.body.is_active, 'is_active');

    db.prepare(
      'UPDATE masters SET name = ?, role = ?, experience_years = ?, is_active = ?, updated_at = ? WHERE id = ?'
    ).run(name, role, experienceYears, isActive, nowDbLocal(), id);

    if (req.body.service_ids !== undefined) {
      const serviceIds = v.idList(req.body.service_ids, 'service_ids');
      assertServicesExist(serviceIds);
      db.transaction(() => {
        db.prepare('DELETE FROM master_services WHERE master_id = ?').run(id);
        attachServices(id, serviceIds);
      })();
    }
    return res.json({ master: publicMaster(id) });
  })
);

// DELETE /admin/masters/:id — удалить мастера (только если нет записей)
router.delete(
  '/masters/:id',
  asyncH(async (req, res) => {
    const id = v.intId(req.params.id, 'id');
    if (!q.masterById(id)) return res.status(404).json({ error: { message: 'Мастер не найден.', code: 'NOT_FOUND' } });
    if (q.countBookingsFor(id) > 0) {
      return res.status(409).json({ error: { message: 'У мастера есть записи — отключите его, а не удаляйте.', code: 'MASTER_IN_USE' } });
    }
    db.transaction(() => {
      db.prepare('DELETE FROM master_services WHERE master_id = ?').run(id);
      db.prepare('DELETE FROM master_schedule WHERE master_id = ?').run(id);
      db.prepare('DELETE FROM work_blocks WHERE master_id = ?').run(id);
      db.prepare('UPDATE users SET master_id = NULL WHERE master_id = ?').run(id);
      db.prepare('DELETE FROM masters WHERE id = ?').run(id);
    })();
    return res.status(204).end();
  })
);

// Вспомогательные функции

function attachServices(masterId, serviceIds) {
  const ins = db.prepare('INSERT INTO master_services (master_id, service_id) VALUES (?, ?)');
  for (const sid of serviceIds) {
    if (!db.prepare('SELECT 1 AS hit FROM master_services WHERE master_id = ? AND service_id = ?').get(masterId, sid)) {
      ins.run(masterId, sid);
    }
  }
}

function assertServicesExist(serviceIds) {
  for (const sid of serviceIds) {
    if (!q.serviceById(sid)) {
      const err = new Error(`Услуга #${sid} не найдена.`);
      err.status = 400;
      throw err;
    }
  }
}

function publicMaster(id) {
  const m = q.masterById(id);
  return {
    id: m.id,
    name: m.name,
    role: m.role,
    experience_years: m.experience_years,
    is_active: !!m.is_active,
    photo_path: m.photo_path,
    services: q.servicesOfMaster(id),
  };
}

module.exports = router;