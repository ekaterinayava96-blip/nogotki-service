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
  const day = dayPlan({ masterId, dateStartUtc, totalMinutes, stepMinutes });
  return day.cells.filter((c) => c.state === 'free').map((c) => ({ starts_at: c.starts_at, ends_at: c.ends_at }));
}

// Полная картина дня для клиентского экрана «Дата/Время»: окно работы мастера,
// сетка возможных начал визита с состоянием каждой ячейки и причина, по которой
// день недоступен. Считает сервер — клиент только рисует готовые значения.
//
// cells: [{ starts_at, ends_at, state: 'free'|'busy'|'past', kind? }]
//   free  — окно свободно, клиент может его выбрать;
//   busy  — пересекается с записью, блокировкой, закрытием или удержанием
//           (kind: 'booking'|'block'|'closure'|'hold' — по ней клиент пишет причину);
//   past  — начало уже прошло (сегодняшний день).
//   Ячейки, которые не помещаются в рабочее окно целиком, в сетку не входят:
//   они не заняты, но и записаться на них нельзя.
// reason: 'day_off' — выходной, 'too_long' — рабочее окно короче визита,
//         'booked' — все окна заняты, null — есть свободные окна.
function dayPlan({ masterId, dateStartUtc, totalMinutes, stepMinutes = DEFAULT_STEP_MINUTES }) {
  const dayStartLocal = toDbLocal(dateStartUtc); // например «2026-09-26 00:00:00»
  const dayEndLocal = toDbLocal(new Date(dateStartUtc.getTime() + 24 * 3600 * 1000));

  const weekday = salonWeekday(dateStartUtc); // 0=вс .. 6=сб
  const sched = scheduleForWeekday(masterId, weekday);
  const base = {
    is_workday: !!sched,
    window: sched ? { start_minutes: sched.start_minutes, end_minutes: sched.end_minutes } : null,
    duration_minutes: totalMinutes,
    step_minutes: stepMinutes,
    cells: [],
  };
  if (!sched) return { ...base, reason: 'day_off' };
  if (sched.end_minutes - sched.start_minutes < totalMinutes) {
    return { ...base, reason: 'too_long' };
  }
  // День целиком в прошлом: окна перечисляем, но все они состояния 'past' —
  // так клиент показывает «уже прошло», а не «занято».
  const wholeDayPast = dateStartUtc.getTime() + 24 * 3600 * 1000 <= Date.now();

  const busy = getBusyIntervals(masterId, dateStartUtc, new Date(dateStartUtc.getTime() + 24 * 3600 * 1000));
  const occupied = merge(
    busy
      .map((b) => ({
        kind: b.kind,
        from: clampMinutes(localToDayMinute(b.from, dayStartLocal, dayEndLocal), sched.start_minutes, sched.end_minutes),
        to: clampMinutes(localToDayMinute(b.to, dayStartLocal, dayEndLocal), sched.start_minutes, sched.end_minutes),
      }))
      .filter((b) => b.to > b.from)
  );

  const nowUtc = new Date();
  const firstSlot = Math.ceil(sched.start_minutes / stepMinutes) * stepMinutes;
  const cells = [];
  for (let start = firstSlot; start + totalMinutes <= sched.end_minutes; start += stepMinutes) {
    const end = start + totalMinutes;
    const slotStartUtc = new Date(dateStartUtc.getTime() + start * 60000);
    const cell = {
      starts_at: slotStartUtc.toISOString(),
      ends_at: new Date(slotStartUtc.getTime() + totalMinutes * 60000).toISOString(),
    };
    if (slotStartUtc <= nowUtc) {
      cell.state = 'past';
    } else {
      const hit = occupied.find((iv) => iv.from < end && start < iv.to);
      if (hit) {
        cell.state = 'busy';
        cell.kind = hit.kind;
      } else {
        cell.state = 'free';
      }
    }
    cells.push(cell);
  }
  const reason = cells.some((c) => c.state === 'free')
    ? null
    : (wholeDayPast ? 'past' : 'booked');
  return { ...base, cells, reason };
}

// Сводка по дням диапазона для календаря месяца: есть ли свободные окна и
// ближайшее свободное время после дня. Диапазон — ряд дней от dateFromUtc.
// next_free считается одним проходом с конца, поэтому лишних запросов к БД нет.
function rangeAvailability({ masterId, dateFromUtc, days, totalMinutes, stepMinutes = DEFAULT_STEP_MINUTES }) {
  const list = [];
  for (let i = 0; i < days; i++) {
    const dateStartUtc = new Date(dateFromUtc.getTime() + i * 24 * 3600 * 1000);
    const plan = dayPlan({ masterId, dateStartUtc, totalMinutes, stepMinutes });
    const first = plan.cells.find((c) => c.state === 'free') || null;
    list.push({
      date: toDbLocal(dateStartUtc).slice(0, 10),
      weekday: salonWeekday(dateStartUtc),
      is_workday: plan.is_workday,
      is_past: dateStartUtc.getTime() + 24 * 3600 * 1000 <= nowMs(),
      reason: plan.reason,
      slots_count: plan.cells.filter((c) => c.state === 'free').length,
      first_slot: first ? { starts_at: first.starts_at, ends_at: first.ends_at } : null,
      next_free: null,
    });
  }
  // Идём с конца: к моменту обработки дня next_free следующего за ним уже посчитан.
  // Сначала проверяем сам следующий день, и только если в нём окон нет —
  // наследуем найденное для него. Обратный порядок нельзя менять: иначе день с
  // окнами «пропустил» бы ближайшее время и уводил клиента слишком далеко.
  for (let i = list.length - 2; i >= 0; i--) {
    const next = list[i + 1];
    list[i].next_free = next.slots_count
      ? { date: next.date, starts_at: next.first_slot.starts_at, ends_at: next.first_slot.ends_at }
      : next.next_free;
  }
  return list;
}

function nowMs() {
  return Date.now();
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

module.exports = { freeSlots, dayPlan, rangeAvailability, nearestFreeSlots, DEFAULT_STEP_MINUTES };
