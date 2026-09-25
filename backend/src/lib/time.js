'use strict';

// Преобразование времени между UTC (граничный формат API) и локальным временем
// салона (формат хранения в БД, db-schema.md §1.1: 'YYYY-MM-DD HH:MM:SS').
// Часовая зона салона фиксирована (Воронеж, UTC+3, без перехода на летнее время).

const SALON_OFFSET_MINUTES = 180; // UTC+3

function pad(n) {
  return String(n).padStart(2, '0');
}

// «0000-00-00 00:00:00» (UTC-значение) -> локальное салона для строки в БД
function toDbLocal(date) {
  const shifted = new Date(date.getTime() + SALON_OFFSET_MINUTES * 60000);
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  );
}

// Возвращает UTC-момент начала локального дня салона (00:00 салонного времени),
// который содержит переданный момент. toDbLocal(результат) == '<дата> 00:00:00'.
function salonDayStart(utcDate) {
  const local = new Date(utcDate.getTime() + SALON_OFFSET_MINUTES * 60000);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - SALON_OFFSET_MINUTES * 60000);
}

// «YYYY-MM-DD HH:MM:SS» (БД, локальное салона) -> ISO-строка с Z (UTC)
function dbLocalToUtcIso(localStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(localStr);
  if (!m) return null;
  const utcMs = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6])
  ) - SALON_OFFSET_MINUTES * 60000;
  return new Date(utcMs).toISOString();
}

// Принимает строку от клиента: ISO 8601 с явным часовым поясом
// («2026-09-25T08:00:00Z», «2026-09-25T11:00:00+03:00»). Наивное время без
// пояса отклоняем (400): формат фиксируется, чтобы не было двойного толкования.
function parseUtcIso(input) {
  if (typeof input !== 'string') {
    const err = new Error('Ожидается строка времени ISO 8601 с часовым поясом.');
    err.status = 400;
    throw err;
  }
  const re = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!re.test(input)) {
    const err = new Error('Формат времени: ISO 8601 с часовым поясом, например 2026-09-25T08:00:00Z.');
    err.status = 400;
    throw err;
  }
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    const err = new Error('Некорректное значение времени.');
    err.status = 400;
    throw err;
  }
  return date;
}

// Парсит параметр даты «YYYY-MM-DD» как календарный день салона (начало дня
// в локальном времени салона). Возвращает UTC-Date начала этого дня.
function parseSalonDate(input) {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const err = new Error('Дата должна быть в формате YYYY-MM-DD.');
    err.status = 400;
    throw err;
  }
  const [y, mo, d] = input.split('-').map(Number);
  // Проверка существования даты в календаре: Date.UTC нормализует «2026-02-31»
  // в 3 марта, поэтому сравниваем с получившимся значением напрямую.
  const ts = Date.UTC(y, mo - 1, d);
  const dt = new Date(ts);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    const err = new Error('Некорректная дата: несуществующий день календаря.');
    err.status = 400;
    throw err;
  }
  return new Date(ts - SALON_OFFSET_MINUTES * 60000);
}

// Валидация «время не в прошлом» для входных данных записи/удержания.
// date — уже разобранный parseUtcIso; отклоняем прошлое (400).
function assertNotPast(date, fieldName = 'start') {
  if (date.getTime() < Date.now()) {
    const err = new Error(`Время "${fieldName}" не может быть в прошлом.`);
    err.status = 400;
    throw err;
  }
  return date;
}

// Текущий момент в формате БД (локальное салона)
function nowDbLocal() {
  return toDbLocal(new Date());
}

module.exports = {
  SALON_OFFSET_MINUTES,
  toDbLocal,
  dbLocalToUtcIso,
  parseUtcIso,
  parseSalonDate,
  assertNotPast,
  salonDayStart,
  nowDbLocal,
};