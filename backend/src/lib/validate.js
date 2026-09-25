'use strict';

// Проверка входных данных ДО обращения к базе. Каждая функция кидает
// Error со status=400; валидные значения возвращаются нормализованными.

const PHONE_RE = /^\+?[0-9]{10,15}$/;
const USERNAME_RE = /^[a-zA-Z0-9_.]{3,32}$/;

function bad(msg) {
  const err = new Error(msg);
  err.status = 400;
  throw err;
}

function str(value, field, { min = 1, max = 500 } = {}) {
  if (typeof value !== 'string') bad(`Поле «${field}» обязательно и должно быть строкой.`);
  const v = value.trim();
  if (v.length < min) bad(`Поле «${field}» должно содержать не меньше ${min} симв.`);
  if (v.length > max) bad(`Поле «${field}» слишком длинное (макс. ${max} симв.).`);
  return v;
}

function username(value) {
  const v = str(value, 'username', { min: 3, max: 32 });
  if (!USERNAME_RE.test(v)) bad('Логин: только латиница, цифры, «_» и «.» (3–32 симв.).');
  return v;
}

function password(value) {
  const v = str(value, 'password', { min: 8, max: 128 });
  return v;
}

function name(value) {
  const v = str(value, 'name', { min: 2, max: 100 });
  if (v[0] === '+') bad('Поле «name» не может начинаться с «+».');
  return v;
}

function phone(value) {
  const v = str(value, 'phone', { min: 10, max: 16 });
  if (!PHONE_RE.test(v)) bad('Телефон: 10–15 цифр, допускается ведущий «+».');
  return v;
}

function intId(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) bad(`Поле «${field}» должно быть целым положительным числом.`);
  return n;
}

function positiveInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) bad(`Поле «${field}» должно быть целым положительным числом.`);
  return n;
}

function nonNegInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) bad(`Поле «${field}» должно быть целым неотрицательным числом.`);
  return n;
}

function boundedInt(value, field, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    bad(`Поле «${field}» должно быть целым числом от ${min} до ${max}.`);
  }
  return n;
}

// Список положительных целых (например id услуг) из строки «1,2,3» или массива
function idList(value, field) {
  let raw;
  if (Array.isArray(value)) raw = value;
  else if (typeof value === 'string' && value.trim() !== '') raw = value.split(',');
  else return [];
  const ids = [];
  for (const item of raw) {
    const n = Number(String(item).trim());
    if (!Number.isInteger(n) || n <= 0) bad(`Поле «${field}»: «${item}» — недопустимый id.`);
    ids.push(n);
  }
  const uniq = [...new Set(ids)];
  if (uniq.length !== ids.length) bad(`Поле «${field}»: не допускаются дубликаты id.`);
  return ids;
}

function bool(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  const t = String(value).trim().toLowerCase();
  if (t === 'true' || t === '1' || t === 'on') return 1;
  if (t === 'false' || t === '0' || t === 'off') return 0;
  bad(`Поле «${field}» должно быть true/false.`);
  return undefined;
}

function enumValue(value, field, allowed) {
  const v = str(value, field);
  if (!allowed.includes(v)) bad(`Поле «${field}»: допустимые значения: ${allowed.join(', ')}.`);
  return v;
}

module.exports = {
  str,
  username,
  password,
  name,
  phone,
  intId,
  positiveInt,
  nonNegInt,
  boundedInt,
  idList,
  bool,
  enumValue,
  bad,
};