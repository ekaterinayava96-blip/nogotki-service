// Уведомления: запись, чтение, счётчик. Тексты собираются здесь же —
// иначе «Запись изменена» п��хнет бы и сюда.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const config = require('../config');
const { nowDbLocal } = require('../lib/time');

const db = new DatabaseSync(config.dbPath);

// День недели в винительном падеже и с маленькой буквы — так он встаёт в
// предложение: «на среду», а не «на Среда». Даты в базе — dbLocal (уже салонное
// время), поэтому форматируем без сдвига.
const WEEKDAYS_ACC = [
  'воскресенье', 'понедельник', 'вторник', 'среду',
  'четверг', 'пятницу', 'субботу',
];

function parseDbLocal(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(value));
  if (!m) return null;
  return {
    year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
    hour: Number(m[4]), minute: Number(m[5]),
  };
}

// «среду» из даты: считаем по календарю, месяц не нужен.
function weekdayName(dbLocal) {
  const d = parseDbLocal(dbLocal);
  if (!d) return '';
  const js = new Date(Date.UTC(d.year, d.month - 1, d.day));
  return WEEKDAYS_ACC[js.getUTCDay()];
}

// Точка в конце, если её не поставил сам автор причины: иначе предложения склеиваются.
function withDot(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  return /[.!?…]$/.test(s) ? s : s + '.';
}

function hhmm(dbLocal) {
  const d = parseDbLocal(dbLocal);
  if (!d) return '';
  return String(d.hour).padStart(2, '0') + ':' + String(d.minute).padStart(2, '0');
}

// «за 12 минут» / «за 3 часа» / «за 2 дня 4 часа» — для «дней назад».
function plural(n, one, few, many) {
  const m100 = n % 100;
  const m10 = n % 10;
  if (m100 >= 11 && m100 <= 14) return many;
  if (m10 === 1) return one;
  if (m10 >= 2 && m10 <= 4) return few;
  return many;
}

function agoText(dbLocal) {
  const d = parseDbLocal(dbLocal);
  if (!d) return '';
  const then = Date.UTC(d.year, d.month - 1, d.day, d.hour, d.minute);
  const now = new Date();
  const nowLocal = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    now.getUTCHours(), now.getUTCMinutes()
  );
  const mins = Math.max(0, Math.round((nowLocal - then) / 60000));
  if (mins < 1) return 'только что';
  if (mins < 60) return mins + ' ' + plural(mins, 'минуту', 'минуты', 'минут') + ' назад';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + ' ' + plural(hours, 'час', 'часа', 'часов') + ' назад';
  const days = Math.floor(hours / 24);
  return days + ' ' + plural(days, 'день', 'дня', 'дней') + ' назад';
}

// ---- Тексты уведомлений ----
// Конкретные дата и время, без общих фраз. Подстановки экранирует api.js.

// 1. Администратор отменил запись клиента.
function textBookingCanceled(row) {
  const reason = row.canceled_reason ? ': ' + withDot(row.canceled_reason) + ' ' : '. ';
  return 'Запись на ' + weekdayName(row.starts_at) + ', ' + hhmm(row.starts_at) +
    ' отменена' + reason + 'Запись на это время снова свободна — запишитесь заново.';
}

// 2. Администратор перенёс запись клиента.
function textBookingMoved(fromLocal, toLocal) {
  return 'Запись на ' + weekdayName(fromLocal) + ', ' + hhmm(fromLocal) +
    ' перенесена на ' + weekdayName(toLocal) + ', ' + hhmm(toLocal) + '.';
}

// 3. На это время назначен ещё один визит.
// Здесь предлог «в», а не «на»: «на ваш визит пятница» — не по-русски.
// В текстах про саму запись («Запись на среду, 13:00…») оставляем «на».
function textBookingConflict(row, isOwnNewBooking) {
  const when = 'в ' + weekdayName(row.starts_at) + ', ' + hhmm(row.starts_at);
  if (isOwnNewBooking) {
    return 'На ваше время ' + when +
      ' в студии записан ещё один визит. Проверьте, сможете ли вы прийти в это же время.';
  }
  return 'На ваш визит ' + when +
    ' записан ещё один клиент. Проверьте, сможете ли вы прийти в это же время.';
}

// ---- Запись в базу ----

// Уведомление создаётся только если у клиента есть аккаунт: иначе его никто
// не увидит. Возвращает id уведомления или null.
function notifyBookingCanceled(bookingId) {
  const row = db.prepare(`
    SELECT b.id, b.starts_at, b.ends_at, b.canceled_reason,
           u.id AS user_id
    FROM bookings b
    LEFT JOIN clients c ON c.id = b.client_id
    LEFT JOIN users u ON u.id = c.user_id
    WHERE b.id = ?`).get(Number(bookingId));
  if (!row || !row.user_id) return null;
  return insert(row.user_id, 'booking_canceled', textBookingCanceled(row), bookingId);
}

function notifyBookingMoved(bookingId, fromLocal, toLocal) {
  const row = db.prepare(`
    SELECT b.id, u.id AS user_id
    FROM bookings b
    LEFT JOIN clients c ON c.id = b.client_id
    LEFT JOIN users u ON u.id = c.user_id
    WHERE b.id = ?`).get(Number(bookingId));
  if (!row || !row.user_id) return null;
  return insert(row.user_id, 'booking_moved', textBookingMoved(fromLocal, toLocal), bookingId);
}

// notifyBookingConflict: уведомление об одном наложении. Для каждой затронутой
// записи — свой текст: у того, чью запись создали, «на ваше время»;
// у того, у кого время заняли, «на ваш визит».
function notifyBookingConflict(newBookingId, otherBookingId, createdForThisUser) {
  const created = [];
  const push = (bookingId, isOwn) => {
    const row = db.prepare(`
      SELECT b.id, b.starts_at, u.id AS user_id
      FROM bookings b
      LEFT JOIN clients c ON c.id = b.client_id
      LEFT JOIN users u ON u.id = c.user_id
      WHERE b.id = ?`).get(Number(bookingId));
    if (!row || !row.user_id) return;
    created.push(insert(row.user_id, 'booking_conflict', textBookingConflict(row, isOwn), bookingId));
  };
  push(newBookingId, createdForThisUser);
  if (otherBookingId) push(otherBookingId, false);
  return created;
}

function insert(userId, type, text, bookingId) {
  const info = db.prepare(
    'INSERT INTO notifications (user_id, type, text, booking_id, is_read, created_at) VALUES (?, ?, ?, ?, 0, ?)'
  ).run(Number(userId), type, text, bookingId ? Number(bookingId) : null, nowDbLocal());
  return Number(info.lastInsertRowid);
}

// ---- Чтение ----

// Список и счётчик непрочитанных отдаются вместе: отдельный запрос ради одного
// числа не делаем.
function listNotifications(userId) {
  const rows = db.prepare(
    'SELECT id, type, text, booking_id, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC'
  ).all(Number(userId));
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    text: r.text,
    booking_id: r.booking_id,
    // Ссылка ведёт на детальную страницу записи.
    url: r.booking_id ? 'appointment.html?id=' + r.booking_id : null,
    is_read: !!r.is_read,
    created_at: r.created_at,
    ago: agoText(r.created_at),
  }));
}

function unreadCount(userId) {
  const r = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0')
    .get(Number(userId));
  return Number(r.n);
}

// Пометить прочитанным. Только своё уведомление: чужое отдаёт 404.
function markRead(userId, id) {
  const row = db.prepare('SELECT id FROM notifications WHERE id = ? AND user_id = ?')
    .get(Number(id), Number(userId));
  if (!row) return false;
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(Number(id));
  return true;
}

module.exports = {
  notifyBookingCanceled,
  notifyBookingMoved,
  notifyBookingConflict,
  listNotifications,
  unreadCount,
  markRead,
};