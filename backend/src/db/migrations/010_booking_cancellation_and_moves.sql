-- Миграция 010: чужое посещение — отмена, перенос и запись поверх занятого.
--
-- 1) bookings: причина отмены. Отменённая запись остаётся строкой, поэтому
--    нужно помнить, КТО её отменил и ПОЧЕМУ. Отменённая строка и раньше
--    оставалась в базе (status='canceled'), но без следа, кто и зачем; время
--    при этом освобождалось само, потому что getBusyIntervals() смотрит на
--    status != 'canceled'. То есть «строка удаляется, а время освобождается»
--    в проекте уже было — не хватало только причины.
--    canceled_by — id пользователя (users.id), он же мог отменить клиентскую
--    запись из своего кабинета, поэтому ссылка на users, а не на клиента.
--
-- 2) booking_moves: журнал переносов. Перенос НЕ отменяет старую запись и не
--    создаёт новую — тот же id, другое время. Но по самой строке не видно,
--    что время меняли, откуда и куда, и кто переносил. Журнал это хранит:
--    каждое перенесённое посещение даёт одну строку, поэтому повторные
--    переносы не теряются. Клиент при этом получает одно посещение, а не два
--    (никакой второй записи не создаётся — значит и лишнего уведомления нет).
--
-- 3) bookings.conflict_note: пометка «на это время назначено два визита».
--    Такая запись создаётся с force_override = 1, и без пояснения рядом с ней
--    в панели непонятно, почему время задвоено. Текст пишет администратор при
--    подтверждении.

ALTER TABLE bookings ADD COLUMN canceled_by INTEGER REFERENCES users(id);
ALTER TABLE bookings ADD COLUMN canceled_reason TEXT;
ALTER TABLE bookings ADD COLUMN canceled_at TEXT;
ALTER TABLE bookings ADD COLUMN conflict_note TEXT;

-- Журнал переносов: откуда ушли, куда пришли, кто переносил.
CREATE TABLE booking_moves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id  INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  from_at     TEXT NOT NULL,
  to_at       TEXT NOT NULL,
  from_master INTEGER REFERENCES masters(id),
  to_master   INTEGER REFERENCES masters(id),
  moved_by    INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL
);
-- CHECK на «что-то поменялось» намеренно не ставим: NULL в to_master даёт
-- неопределённость в сравнении (NULL IS NOT NULL = false), и проверка
-- отвергала бы корректный перенос. Пустую строку переноса сервер не пишет.

CREATE INDEX idx_booking_moves_booking ON booking_moves(booking_id, created_at);

-- Записи с записанной причиной отмены: панели и кабинету проще искать,
-- чем разбирать все строки.
CREATE INDEX idx_bookings_canceled ON bookings(canceled_at) WHERE status = 'canceled';

-- Записи, созданные поверх занятого времени: их показываем в панели отдельной
-- пометкой, и по ним же считаем, где заdouble-ено.
CREATE INDEX idx_bookings_forced ON bookings(starts_at) WHERE force_override = 1;