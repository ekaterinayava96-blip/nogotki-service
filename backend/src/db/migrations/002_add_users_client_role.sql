-- Миграция 002: добавляем роль 'client' в таблицу users.
-- Изначальный CHECK (role IN ('owner','master')) запрещал клиентские учётные
-- записи. SQLite не умеет менять CHECK напрямую, поэтому таблица пересоздаётся
-- с расширенным набором ролей; все данные переносятся без изменений.

CREATE TABLE users_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  master_id     INTEGER UNIQUE REFERENCES masters(id),
  role          TEXT NOT NULL DEFAULT 'master' CHECK (role IN ('owner','master','client')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  UNIQUE (username)
);

INSERT INTO users_new (id, username, password_hash, master_id, role, is_active, last_login_at)
  SELECT id, username, password_hash, master_id, role, is_active, last_login_at FROM users;

DROP TABLE users;

ALTER TABLE users_new RENAME TO users;