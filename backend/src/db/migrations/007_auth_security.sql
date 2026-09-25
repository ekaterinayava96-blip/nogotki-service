-- Миграция 007: безопасность аутентификации.
--  1) user_roles — роли хранятся СПИСКОМ (у человека может быть несколько ролей,
--     например master + owner). Проверка прав — «есть ли нужная роль», не
--     «равна ли role». Колонка users.role удаляется из пересозданной таблицы.
--  2) auth_sessions — токены доступа. Наружу клиенту выдаётся случайный токен,
--     в БД хранится только его SHA-256. Работает как отзыв через revoked_at и
--     истечение срока (expires_at): вместо раздувающегося чёрного списка jti.

-- Роли: переносим существующие значения из users.role ДО пересоздания users.
CREATE TABLE user_roles (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     TEXT NOT NULL CHECK (role IN ('owner','master','client')),
  PRIMARY KEY (user_id, role)
);

INSERT INTO user_roles (user_id, role) SELECT id, role FROM users;

-- Пересоздаём users без колонки role (ренейм-трюк как в миграции 004).
-- Внешние ключи (clients.user_id, slot_holds.created_by, user_roles.user_id)
-- ссылаются на имя "users" — при ALTER ... RENAME оно сохраняется.
CREATE TABLE users_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  master_id     INTEGER UNIQUE REFERENCES masters(id),
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  UNIQUE (username)
);

INSERT INTO users_new (id, username, password_hash, master_id, is_active, last_login_at)
  SELECT id, username, password_hash, master_id, is_active, last_login_at FROM users;

DROP TABLE users;

ALTER TABLE users_new RENAME TO users;

-- Сессии входа: хеш токена, владелец, срок действия, отметка отзыва.
-- token_hash — SHA-256 от выданного клиенту токена (сам токен в БД НЕ хранится).
CREATE TABLE auth_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);

-- Для «мои сессии» и ревокации пользователем.
CREATE INDEX idx_sessions_user    ON auth_sessions(user_id);
-- Для cleanup-задачи «удалить старые сессии».
CREATE INDEX idx_sessions_expires ON auth_sessions(expires_at);