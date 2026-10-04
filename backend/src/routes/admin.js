'use strict';

// Административные эндпоинты — только для роли owner.

const express = require('express');

const db = require('../db/connection');
const q = require('../repo/queries');
const { parseUtcIso, toDbLocal, nowDbLocal, assertNotPast } = require('../lib/time');
const v = require('../lib/validate');
const notifications = require('../lib/notifications');
const { asyncH, isBookingTimeConflict, sendSlotConflict } = require('../lib/http');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireRole('owner'));

// ---------- Записи ----------

// GET /admin/bookings — все записи с фильтрами: ?status=&from=&to=&master_id=
// и постраничностью ?limit=&offset=. По умолчанию отдаём всё: пока история
// студии умещается в один ответ, а владелец смотрит её одним списком.
router.get(
  '/bookings',
  asyncH(async (req, res) => {
    const status = req.query.status === undefined
      ? null
      : v.enumValue(req.query.status, 'status', ['wait', 'confirmed', 'done', 'canceled']);
    const masterId = req.query.master_id === undefined ? null : v.intId(req.query.master_id, 'master_id');
    const fromLocal = req.query.from === undefined ? undefined : toDbLocal(parseUtcIso(req.query.from));
    const toLocal = req.query.to === undefined ? undefined : toDbLocal(parseUtcIso(req.query.to));
    const limit = req.query.limit === undefined ? null : v.boundedInt(req.query.limit, 'limit', 1, 200);
    const offset = req.query.offset === undefined ? 0 : v.boundedInt(req.query.offset, 'offset', 0, 1000000);

    const filter = { status, masterId, fromLocal, toLocal };
    // total считаем по тем же фильтрам, но без limit/offset — по нему экран
    // понимает, сколько страниц осталось и на какой он сейчас.
    const total = q.countBookings(filter);
    const bookings = limit === null
      ? q.adminBookings(filter)
      : q.adminBookings({ ...filter, limit, offset });
    return res.json({ bookings, total, limit: limit === null ? total : limit, offset });
  })
);

// PATCH /admin/bookings/:id — смена статуса записи администратором.
// body: { status: 'wait'|'confirmed'|'done'|'canceled', reason? }
//
// При статусе canceled строка НЕ удаляется: остаётся в списке с пометкой
// «Отменена», а время освобождается (getBusyIntervals смотрит только на
// status != 'canceled'). Кто отменил и почему — пишется рядом.
router.patch(
  '/bookings/:id',
  asyncH(async (req, res) => {
    const bookingId = v.intId(req.params.id, 'id');
    const status = v.enumValue(req.body.status, 'status', ['wait', 'confirmed', 'done', 'canceled']);
    const row = q.bookingDetail(bookingId);
    if (!row) return res.status(404).json({ error: { message: 'Запись не найдена.', code: 'NOT_FOUND' } });

    let reason = null;
    if (status === 'canceled') {
      reason = req.body.reason === undefined
        ? null
        : v.str(req.body.reason, 'reason', { min: 3, max: 300 });
      if (!reason) {
        return res.status(400).json({
          error: {
            message: 'Укажите причину отмены — она остаётся в истории записи и видна сотрудникам.',
            code: 'REASON_REQUIRED',
          },
        });
      }
    }

    try {
      q.setBookingStatus(bookingId, status, {
        canceledBy: status === 'canceled' ? req.user.id : null,
        canceledReason: reason,
      });
      // Случай 1: администратор отменил запись клиента. Клиент об этом ещё не
      // знает — уведомляем. Отмена САМИМ клиентом сюда не попадает: этот
      // эндпоинт закрыт requireRole('owner').
      if (status === 'canceled') notifications.notifyBookingCanceled(bookingId);
    } catch (err) {
      // Триггер trg_bookings_no_overlap_update: смена статуса на активный
      // на пересечении с другой активной записью мастера запрещена.
      if (isBookingTimeConflict(err) && status !== 'canceled') {
        // Подсказка «свободное время рядом» считается по длительности всей
        // записи, а не по одной услуге.
        const services = q.servicesOfBooking(bookingId);
        const totalMinutes = services.length
          ? services.reduce((sum, s) => sum + s.duration_minutes, 0)
          : row.service_duration;
        return sendSlotConflict(res, row.master_id, totalMinutes);
      }
      throw err;
    }
    return res.json({ booking: q.adminBooking(bookingId) });
  })
);

// GET /admin/bookings/day?date=YYYY-MM-DD&master_id=
// Список записей выбранного дня: время, клиент, мастер, услуги, состояние.
//
// День приходит как «YYYY-MM-DD» в часовом поясе салона. Границы в UTC ISO:
// from = начало дня салона, to = начало СЛЕДУЮЩЕГО дня — в API слоты и записи
// сравниваются как starts_at >= from AND starts_at < to, иначе визит в 23:30
// попал бы в завтрашний день или потерялся бы.
//
// Время в ответе остаётся салонным (dbLocal) — экран рисует его через
// window.api.hour(), как все остальные страницы. Отдельного эндпоинта «на день»
// раньше не было: панель брала общий список и фильтровала по from/to, из-за чего
// в счётчике и в строках разъезжались границы.
router.get(
  '/bookings/day',
  asyncH(async (req, res) => {
    const date = v.str(req.query.date, 'date', { min: 10, max: 10 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        error: { message: 'Дата должна быть в формате YYYY-MM-DD.', code: 'BAD_DATE' },
      });
    }
    const masterId = req.query.master_id === undefined ? null : v.intId(req.query.master_id, 'master_id');
    // Полночь салона (UTC+3) на выбранный день и на следующий.
    const fromIso = `${date}T00:00:00.000Z`;
    const nextDay = new Date(Date.UTC(
      Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + 1
    ));
    const nextIso = `${nextDay.toISOString().slice(0, 10)}T00:00:00.000Z`;

    const fromLocal = toDbLocal(parseUtcIso(fromIso));
    const toLocal = toDbLocal(parseUtcIso(nextIso));
    const bookings = q.adminBookings({ masterId, fromLocal, toLocal });
    const total = q.countBookings({ masterId, fromLocal, toLocal });
    return res.json({ date, timezone_offset_minutes: 180, bookings, total });
  })
);

// GET /admin/bookings/:id/moves — журнал переносов записи: откуда ушли, куда
// пришли, кто переносил. Сама перенесённая запись одна и та же (id не меняется),
// поэтому вторая «новая» запись не создаётся и клиент не получает второе
// уведомление — но след переноса остаётся.
router.get(
  '/bookings/:id/moves',
  asyncH(async (req, res) => {
    const bookingId = v.intId(req.params.id, 'id');
    if (!q.bookingDetail(bookingId)) return res.status(404).json({ error: { message: 'Запись не найдена.', code: 'NOT_FOUND' } });
    return res.json({ booking_id: bookingId, moves: q.bookingMoves(bookingId) });
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
    // Описание необязательное: колонка description NOT NULL, но пустая строка
    // допустима, и каталог её так и рисует («s.description || ''»). Поэтому
    // min: 0, а не требование минимум одного символа.
    const description = v.str(req.body.description ?? '', 'description', { min: 0, max: 500 });
    // Цена и длительность — строго положительные: нулевая цена в прайсе означала бы
    // «бесплатную услугу», а нулевая длительность — слот нулевой длины, который
    // сломал бы расписание. Проверка на сервере, а не только в форме.
    const priceKopecks = v.positiveInt(req.body.price_kopecks, 'price_kopecks');
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
    const description = req.body.description === undefined ? existing.description : v.str(req.body.description, 'description', { min: 0, max: 500 });
    const priceKopecks = req.body.price_kopecks === undefined ? existing.price_kopecks : v.positiveInt(req.body.price_kopecks, 'price_kopecks');
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

// DELETE /admin/services/:id — удалить услугу, если на неё никто не ссылается.
// Если записи есть, строка НЕ удаляется, а отключается: решение принимает сервер,
// клиентский интерфейс только показывает объяснение (disabled вместо удалено).
router.delete(
  '/services/:id',
  asyncH(async (req, res) => {
    const id = v.intId(req.params.id, 'id');
    const existing = q.serviceById(id);
    if (!existing) return res.status(404).json({ error: { message: 'Услуга не найдена.', code: 'NOT_FOUND' } });
    // Записи могли остаться на услугу и в составе комплекса (booking_services),
    // поэтому проверяем оба места — иначе удаление упрётся в FK без понятного
    // ответа клиенту.
    const count = q.countBookingsWithService(id);
    if (count > 0) {
      // Отключаем, а не отказываем: история записей ссылается на услугу, и её
      // удаление сломало бы и прошлые записи, и наборы услуг мастеров.
      if (existing.is_active !== 1) {
        return res.json({
          service: q.serviceById(id),
          outcome: 'already_disabled',
          bookings_count: count,
          message: `Услуга «${existing.name}» отключена, а не удалена: по ней ${count} ${records(count)}. Историю удалить нельзя — записи её хранят.`,
        });
      }
      db.prepare('UPDATE services SET is_active = 0, updated_at = ? WHERE id = ?').run(nowDbLocal(), id);
      return res.json({
        service: q.serviceById(id),
        outcome: 'disabled',
        bookings_count: count,
        message: `Услуга «${existing.name}» не удалена, а отключена: по ней ${count} ${records(count)}. Клиентам она больше не предлагается, история записей сохранена.`,
      });
    }
    db.transaction(() => {
      db.prepare('DELETE FROM master_services WHERE service_id = ?').run(id);
      db.prepare('DELETE FROM services WHERE id = ?').run(id);
    })();
    return res.json({
      outcome: 'deleted',
      message: `Услуга «${existing.name}» удалена: записей по ней не было.`,
    });
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

// DELETE /admin/masters/:id — удалить мастера, если на него никто не ссылается.
// Если записи есть, мастер не удаляется, а отключается: решение на сервере,
// ответ объясняет, что произошло.
router.delete(
  '/masters/:id',
  asyncH(async (req, res) => {
    const id = v.intId(req.params.id, 'id');
    const existing = q.masterById(id);
    if (!existing) return res.status(404).json({ error: { message: 'Мастер не найден.', code: 'NOT_FOUND' } });
    const count = q.countBookingsFor(id);
    if (count > 0) {
      if (existing.is_active !== 1) {
        return res.json({
          master: publicMaster(id),
          outcome: 'already_disabled',
          bookings_count: count,
          message: `Мастер «${existing.name}» отключён, а не удалён: по нему ${count} ${records(count)}. Историю удалить нельзя — записи её хранят.`,
        });
      }
      db.prepare('UPDATE masters SET is_active = 0, updated_at = ? WHERE id = ?').run(nowDbLocal(), id);
      return res.json({
        master: publicMaster(id),
        outcome: 'disabled',
        bookings_count: count,
        message: `Мастер «${existing.name}» не удалён, а отключён: по нему ${count} ${records(count)}. Клиенты его больше не видят, история записей сохранена.`,
      });
    }
    db.transaction(() => {
      db.prepare('DELETE FROM master_services WHERE master_id = ?').run(id);
      db.prepare('DELETE FROM master_schedule WHERE master_id = ?').run(id);
      db.prepare('DELETE FROM work_blocks WHERE master_id = ?').run(id);
      db.prepare('UPDATE users SET master_id = NULL WHERE master_id = ?').run(id);
      db.prepare('DELETE FROM masters WHERE id = ?').run(id);
    })();
    return res.json({
      outcome: 'deleted',
      message: `Мастер «${existing.name}» удалён: записей по нему не было.`,
    });
  })
);

// ---------- Расписание мастера ----------

// GET /admin/masters/:id/schedule — рабочее время мастера по дням недели
router.get(
  '/masters/:id/schedule',
  asyncH(async (req, res) => {
    const id = v.intId(req.params.id, 'id');
    if (!q.masterById(id)) return res.status(404).json({ error: { message: 'Мастер не найден.', code: 'NOT_FOUND' } });
    return res.json({ schedule: q.masterSchedule(id) });
  })
);

// PUT /admin/masters/:id/schedule — полная замена расписания недели.
// body: { schedule: [{ weekday, start_minutes, end_minutes }] }
router.put(
  '/masters/:id/schedule',
  asyncH(async (req, res) => {
    const id = v.intId(req.params.id, 'id');
    if (!q.masterById(id)) return res.status(404).json({ error: { message: 'Мастер не найден.', code: 'NOT_FOUND' } });
    if (!Array.isArray(req.body.schedule)) {
      return res.status(400).json({ error: { message: 'Поле schedule должно быть массивом.', code: 'BAD_SCHEDULE' } });
    }
    const rows = req.body.schedule.map((row, idx) => {
      const weekday = v.boundedInt(row.weekday, `schedule[${idx}].weekday`, 0, 6);
      const startMinutes = v.boundedInt(row.start_minutes, `schedule[${idx}].start_minutes`, 0, 1439);
      const endMinutes = v.boundedInt(row.end_minutes, `schedule[${idx}].end_minutes`, 1, 1440);
      if (endMinutes <= startMinutes) {
        const err = new Error(`schedule[${idx}]: end_minutes должен быть больше start_minutes.`);
        err.status = 400;
        throw err;
      }
      return { weekday, start_minutes: startMinutes, end_minutes: endMinutes };
    });
    const weekdays = new Set(rows.map((r) => r.weekday));
    if (weekdays.size !== rows.length) {
      return res.status(400).json({ error: { message: 'Расписание: один день недели указан дважды.', code: 'DUP_WEEKDAY' } });
    }
    q.replaceMasterSchedule(id, rows);
    return res.json({ schedule: q.masterSchedule(id) });
  })
);

// ---------- Блокировки времени мастера ----------

// GET /admin/masters/:id/work-blocks — перерывы/выходные мастера (фильтры ?from=&to=)
router.get(
  '/masters/:id/work-blocks',
  asyncH(async (req, res) => {
    const id = v.intId(req.params.id, 'id');
    if (!q.masterById(id)) return res.status(404).json({ error: { message: 'Мастер не найден.', code: 'NOT_FOUND' } });
    const fromLocal = req.query.from === undefined ? null : toDbLocal(parseUtcIso(req.query.from));
    const toLocal = req.query.to === undefined ? null : toDbLocal(parseUtcIso(req.query.to));
    return res.json({ work_blocks: q.listWorkBlocks(id, fromLocal, toLocal) });
  })
);

// POST /admin/masters/:id/work-blocks — создать блокировку (перерыв/день-офф).
// body: { starts_at (UTC ISO), ends_at (UTC ISO), reason? }
router.post(
  '/masters/:id/work-blocks',
  asyncH(async (req, res) => {
    const id = v.intId(req.params.id, 'id');
    if (!q.masterById(id)) return res.status(404).json({ error: { message: 'Мастер не найден.', code: 'NOT_FOUND' } });
    const startUtc = assertNotPast(parseUtcIso(req.body.starts_at), 'starts_at');
    const endUtc = parseUtcIso(req.body.ends_at);
    if (endUtc.getTime() <= startUtc.getTime()) {
      return res.status(400).json({ error: { message: 'ends_at должен быть позже starts_at.', code: 'BAD_INTERVAL' } });
    }
    const reason = req.body.reason === undefined ? 'break' : v.enumValue(req.body.reason, 'reason', ['break', 'day_off', 'vacation', 'sick', 'other']);
    const blockId = q.createWorkBlock({
      masterId: id,
      startsAtLocal: toDbLocal(startUtc),
      endsAtLocal: toDbLocal(endUtc),
      reason,
    });
    return res.status(201).json({ work_block: q.workBlockById(blockId) });
  })
);

// DELETE /admin/work-blocks/:id — снять блокировку
router.delete(
  '/work-blocks/:id',
  asyncH(async (req, res) => {
    const id = v.intId(req.params.id, 'id');
    if (!q.workBlockById(id)) return res.status(404).json({ error: { message: 'Блокировка не найдена.', code: 'NOT_FOUND' } });
    q.deleteWorkBlock(id);
    return res.status(204).end();
  })
);

// ---------- Настройки студии ----------

// GET /admin/studio — текущие настройки студии (в т.ч. правило бесплатной отмены)
router.get(
  '/studio',
  asyncH(async (req, res) => {
    const info = q.studioInfo();
    if (!info) {
      return res.status(404).json({ error: { message: 'Информация о студии не заполнена.', code: 'NOT_FOUND' } });
    }
    return res.json({
      studio: {
        id: info.id,
        studio_name: info.studio_name,
        address: info.address,
        phone: info.phone,
        telegram: info.telegram,
        map_hint: info.map_hint,
        free_cancel_hours: Number(info.free_cancel_hours || 0),
      },
    });
  })
);

// PATCH /admin/studio — смена правила бесплатной отмены.
// body: { free_cancel_hours: 0..168 } — 0 означает «бесплатной отмены нет».
// Клиентский кабинет берёт это значение из GET /api/studio, поэтому здесь
// достаточно только самой настройки без правки констант во фронтенде.
router.patch(
  '/studio',
  asyncH(async (req, res) => {
    if (req.body.free_cancel_hours === undefined) {
      return res.status(400).json({
        error: { message: 'Укажите поле «free_cancel_hours».', code: 'VALIDATION' },
      });
    }
    const hours = v.boundedInt(req.body.free_cancel_hours, 'free_cancel_hours', 0, 168);
    const info = q.studioInfo();
    if (!info) {
      return res.status(404).json({ error: { message: 'Информация о студии не заполнена.', code: 'NOT_FOUND' } });
    }
    q.setFreeCancelHours(hours);
    return res.json({ studio: { free_cancel_hours: hours } });
  })
);

// ---------- Статистика ----------

// GET /admin/stats — дашборд: всего записей, активные, сумма активных, число мастеров
router.get(
  '/stats',
  asyncH(async (req, res) => {
    return res.json(q.statsDashboard());
  })
);

// GET /admin/stats/period — то же за выбранный период (?from=&to=, салонное
// время в UTC ISO) плюс разбивка по мастерам и дням. Отдельный эндпоинт, а не
// параметр у /stats: текущий дашборд открывается без дат и должен остаться
// дешёвым «сколько всего», период считается только когда его попросили.
router.get(
  '/stats/period',
  asyncH(async (req, res) => {
    const fromLocal = req.query.from === undefined ? null : toDbLocal(parseUtcIso(req.query.from));
    const toLocal = req.query.to === undefined ? null : toDbLocal(parseUtcIso(req.query.to));
    return res.json(q.statsPeriod({ fromLocal, toLocal }));
  })
);

// ---------- Обратная связь клиентов ----------

// GET /admin/feedback — все отзывы с фильтром ?status=new|read|answered
router.get(
  '/feedback',
  asyncH(async (req, res) => {
    const status = req.query.status === undefined
      ? null
      : v.enumValue(req.query.status, 'status', ['new', 'read', 'answered']);
    return res.json({ feedback: q.listFeedback({ status }) });
  })
);

// PATCH /admin/feedback/:id — сменить статус обращения (прочитано/отвечено)
router.patch(
  '/feedback/:id',
  asyncH(async (req, res) => {
    const id = v.intId(req.params.id, 'id');
    const existing = q.feedbackById(id);
    if (!existing) return res.status(404).json({ error: { message: 'Отзыв не найден.', code: 'NOT_FOUND' } });
    const status = v.enumValue(req.body.status, 'status', ['new', 'read', 'answered']);
    q.setFeedbackStatus(id, status);
    return res.json({ feedback: q.serializeFeedback(q.feedbackById(id)) });
  })
);

// Вспомогательные функции

// Окончание для счётчика записей: 1 запись, 2 записи, 5 записей. Сообщение о
// блокировке удаления читает администратор, поэтому «1 записей» смотрится как
// ошибка в тексте.
function records(n) {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'записей';
  if (mod10 === 1) return 'запись';
  if (mod10 >= 2 && mod10 <= 4) return 'записи';
  return 'записей';
}

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
    // Панели владельца полный набор услуг, включая отключённые: связь должна
    // быть видна и снимаема, иначе отметка исчезла бы молча.
    services: q.servicesOfMaster(id, { activeOnly: false }),
  };
}

module.exports = router;