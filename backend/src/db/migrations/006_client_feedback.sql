-- Миграция 006: обратная связь клиентов (отзывы/жалобы/вопросы).
-- Соответствует функции паспорта «Обратная связь и отзывы»: клиент оставляет
-- отзыв после посещения, владелец видит все обращения и меняет их статус.

CREATE TABLE client_feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id  INTEGER NOT NULL REFERENCES clients(id),
  text       TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  status     TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','read','answered')),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_feedback_client ON client_feedback(client_id);
CREATE INDEX idx_feedback_status ON client_feedback(status);