'use strict';

// Обёртка асинхронного обработчика: пробрасывает ошибки в next() один раз.
const { nearestFreeSlots } = require('./availability');

function asyncH(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Единый формат ошибки: { error: { message, code? } }
function sendError(res, status, message, code) {
  return res.status(status).json({ error: { message, ...(code ? { code } : {}) } });
}

function sendCreated(res, data) {
  return res.status(201).json(data);
}

function sendNoContent(res) {
  return res.status(204).end();
}

// Ошибка, поднятая триггером trg_bookings_no_overlap_* (RAISE(ABORT, 'BOOKING_TIME_CONFLICT')).
// node:sqlite пробрасывает текст из RAISE в err.message.
function isBookingTimeConflict(err) {
  return typeof err === 'object' && err !== null && /BOOKING_TIME_CONFLICT/.test(String(err.message || ''));
}

// Ответ 409 «время занято» + ближайшее свободное время мастера (не наружу текст БД).
// code различают точки отказа: SLOT_BUSY — заняла запись, SLOT_CONFLICT — слот
// перехватили на удержании. Ближайшие окна клиенту нужны в обоих случаях,
// поэтому список отдаём всегда.
// Ответ на занятое время. code по умолчанию SLOT_BUSY.
// extra — добавки к телу ошибки для владельца: can_force говорит, что записать
// поверх занятого можно, но сначала нужно подтверждение (can_force само по себе
// не создаёт запись — создаёт второй запрос с confirm=1).
function sendSlotConflict(res, masterId, totalMinutes, code = 'SLOT_BUSY', extra = null) {
  const alternatives = nearestFreeSlots({ masterId, totalMinutes }).map((s) => ({
    starts_at: s.starts_at,
    ends_at: s.ends_at,
  }));
  const error = {
    message: 'Это время уже занято. Возьмите один из свободных вариантов:',
    code: code,
    nearest_free: alternatives,
  };
  if (extra && typeof extra === 'object') Object.assign(error, extra);
  return res.status(409).json({ error });
}

module.exports = { asyncH, sendError, sendCreated, sendNoContent, isBookingTimeConflict, sendSlotConflict };