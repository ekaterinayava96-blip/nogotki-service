-- Миграция 011: уведомления внутри кабинета.
--
-- Уведомления — это то, что произошло с записью помимо воли самого клиента.
-- Поэтому создаются только в трёх случаях (все — действия администратора):
--   booking_canceled  — администратор отменил запись клиента
--   booking_moved     — администратор перенёс запись клиента
--   booking_conflict  — на время записи назначен ещё один визит
-- Когда клиент сам записался, отменил или перенёс визит, уведомления нет: он
-- только что и так знает, что сделал.
--
-- Получатель — пользователь (users.id), а не клиент (clients.id): у одного
-- клиента может быть аккаунт, а уведомление видит именно тот, кто вошёл в
-- кабинет. user_id NULL означает «у клиента нет аккаунта, показать некому».
--
-- Текст пишется сразу при создании и содержит конкретные дату и время
-- («Запись на четверг, 14:00 перенесена на пятницу, 11:00»), а не общие слова
-- вроде «Ваша запись изменена»: по общему тексту клиент не поймёт, что делать.

CREATE TABLE notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL
    CHECK (type IN ('booking_canceled', 'booking_moved', 'booking_conflict')),
  -- Готовый текст под конкретные дату и время на момент события.
  text       TEXT NOT NULL,
  -- Куда ведёт уведомление: детальная страница этой записи.
  booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  is_read    INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  created_at TEXT NOT NULL
);

-- Список уведомлений пользователя и счётчик непрочитанных: оба идут одним
-- запросом, поэтому индекс покрывает именно этот доступ (ORDER BY created_at).
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);

-- Отметка «прочитано»: считаем непрочитанные уведомления пользователя.
CREATE INDEX idx_notifications_unread ON notifications(user_id) WHERE is_read = 0;