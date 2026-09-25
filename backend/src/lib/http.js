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
function sendSlotConflict(res, masterId, totalMinutes) {
  const alternatives = nearestFreeSlots({ masterId, totalMinutes }).map((s) => ({
    starts_at: s.starts_at,
    ends_at: s.ends_at,
  }));
  return res.status(409).json({
    error: {
      message: 'Это время уже занято. Выберите одно из ближайших свободных:',
      code: 'SLOT_BUSY',
      nearest_free: alternatives,
    },
  });
}

module.exports = { asyncH, sendError, sendCreated, sendNoContent, isBookingTimeConflict, sendSlotConflict };