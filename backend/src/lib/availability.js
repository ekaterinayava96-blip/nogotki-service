'use strict';

// Вычисление свободных слотов мастера на дату. Отдельной таблицы заранее
// подготовленных слотов нет: свободное время считается на лету из графика
// работы, записей, блокировок, закрытий и действующих удержаний
// (требование §3 / db-schema.md §7.1).

const { scheduleForWeekday, getBusyIntervals } = require('../repo/queries');
const { toDbLocal, salonDayStart, SALON_OFFSET_MINUTES } = require('../lib/time');

const DEFAULT_STEP_MINUTES = 30;

// Ближайшие свободные слоты мастера на следующие count дней (для ответа 409):
// возвращает массив [{ starts_at, ends_at }] для услуги указанной длительности.
function nearestFreeSlots({ masterId, totalMinutes, days = 7, count = 5 }) {
  const now = new Date();
  const out = [];
  for (let d = 0; d < days && out.length < count; d++) {
    const dateStartUtc = salonDayStart(new Date(now.getTime() + d * 24 * 3600 * 1000));
    const slots = freeSlots({ masterId, dateStartUtc, totalMinutes });
    for (const s of slots) {
      out.push(s);
      if (out.length >= count) break;
    }
  }
  return out;
}

// Возвращает [{ starts_at: ISO(UTC), ends_at: ISO(UTC) }].
// dateStartUtc — момент «начала локального дня салона» (обычно 00:00 UTC,
// выровненный по салонному календарному дню; то есть toDbLocal(dateStartUtc) =
// 'YYYY-MM-DD 00:00:00').
function freeSlots({ masterId, dateStartUtc, totalMinutes, stepMinutes = DEFAULT_STEP_MINUTES }) {
  const dayStartLocal = toDbLocal(dateStartUtc); // например «2026-09-26 00:00:00»
  const dayEndLocal = toDbLocal(new Date(dateStartUtc.getTime() + 24 * 3600 * 1000));

  const weekday = salonWeekday(dateStartUtc); // 0=вс .. 6=сб
  const sched = scheduleForWeekday(masterId, weekday);
  if (!sched) return [];
  if (sched.end_minutes - sched.start_minutes < totalMinutes) return [];

  const busy = getBusyIntervals(masterId, dateStartUtc, new Date(dateStartUtc.getTime() + 24 * 3600 * 1000));
  const occupied = merge(
    busy
      .map((b) => ({
        from: clampMinutes(localToDayMinute(b.from, dayStartLocal, dayEndLocal), sched.start_minutes, sched.end_minutes),
        to: clampMinutes(localToDayMinute(b.to, dayStartLocal, dayEndLocal), sched.start_minutes, sched.end_minutes),
      }))
      .filter((b) => b.to > b.from)
  );

  const nowUtc = new Date();
  const firstSlot = Math.ceil(sched.start_minutes / stepMinutes) * stepMinutes;
  const out = [];
  for (let start = firstSlot; start + totalMinutes <= sched.end_minutes; start += stepMinutes) {
    const end = start + totalMinutes;
    const slotStartUtc = new Date(dateStartUtc.getTime() + start * 60000);
    if (slotStartUtc <= nowUtc) continue;
    if (hasOverlap(start, end, occupied)) continue;
    out.push({
      starts_at: slotStartUtc.toISOString(),
      ends_at: new Date(slotStartUtc.getTime() + totalMinutes * 60000).toISOString(),
    });
  }
  return out;
}

// Дата «локальный день салона» -> день недели (0=вс..6=сб)
function salonWeekday(dateStartUtc) {
  return new Date(dateStartUtc.getTime() + SALON_OFFSET_MINUTES * 60000).getUTCDay();
}

// «YYYY-MM-DD HH:MM:SS» -> минуты от начала локального дня; если строка вне
// текущего дня, обрезаем на границы [dayStartLocal, dayEndLocal]
function localToDayMinute(localStr, dayStartLocal, dayEndLocal) {
  if (localStr <= dayStartLocal) return 0;
  if (localStr >= dayEndLocal) return 24 * 60;
  return Number(localStr.slice(11, 13)) * 60 + Number(localStr.slice(14, 16));
}

function clampMinutes(value, lo, hi) {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

function merge(intervals) {
  if (intervals.length === 0) return [];
  const sorted = intervals.slice().sort((a, b) => a.from - b.from || a.to - b.to);
  const res = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = res[res.length - 1];
    if (sorted[i].from <= last.to) {
      last.to = Math.max(last.to, sorted[i].to);
    } else {
      res.push(sorted[i]);
    }
  }
  return res;
}

function hasOverlap(start, end, intervals) {
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const iv = intervals[mid];
    if (iv.to <= start) lo = mid + 1;
    else if (iv.from >= end) hi = mid - 1;
    else return true;
  }
  return false;
}

module.exports = { freeSlots, nearestFreeSlots, DEFAULT_STEP_MINUTES };