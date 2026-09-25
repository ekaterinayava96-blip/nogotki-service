-- Миграция 003: API-слой.
--  1) slot_holds — удержание выбранного слота на время оформления записи
--     (с автоматическим истечением; истёкшие удаляются cleanup-задачей).
--  2) clients.user_id — связь клиентской учётной записи (users, role='client')
--     с профилем клиента (clients), чтобы собирать «мои записи» по аккаунту.

-- Удержание слота: один активный hold занимает тот же слот, что и запись.
-- Слот хранит интервал [starts_at, ends_at) — суммарную длительность выбранных
-- услуг клиентом. Время — локальное время салона (как в db-schema.md §1.1).
CREATE TABLE slot_holds (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  master_id        INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  starts_at        TEXT NOT NULL,
  ends_at          TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  status           TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','used','canceled')),
  token_hash       TEXT NOT NULL UNIQUE,
  created_by       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  CHECK (ends_at > starts_at)
);

-- На один активный hold на одном слоте — уникальность только среди активных
-- (истёкшие/использованные/отменённые могут дублировать слот).
CREATE UNIQUE INDEX idx_holds_active_slot ON slot_holds(master_id, starts_at) WHERE status = 'active';

-- Для вычисления свободного времени: найти активные удержания, пересекающие окно.
CREATE INDEX idx_holds_master_start ON slot_holds(master_id, starts_at, ends_at);

-- Для cleanup-задачи «удалить истёкшие»: выборка по expires_at.
CREATE INDEX idx_holds_expires ON slot_holds(expires_at);

-- Связь клиентского аккаунта с профилем клиента (user_id UNIQUE; NULL — для
-- клиентов, созданных без аккаунта, например из сида).
ALTER TABLE clients ADD COLUMN user_id INTEGER REFERENCES users(id);
CREATE UNIQUE INDEX idx_clients_user ON clients(user_id);