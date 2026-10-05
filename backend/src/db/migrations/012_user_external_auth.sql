-- Внешний вход: учётная запись без пароля.
--
-- Таблица пересобирается целиком, а не ALTER TABLE: SQLite не умеет снимать
-- NOT NULL, а пароль у внешнего аккаунта отсутствует физически. Сборка
-- безопасна — runMigrations.js гасит внешние ключи на весь прогон, поэтому
-- REFERENCES в семи других таблицах остаются указывать на users, а не на
-- временное имя. Данные переносятся копированием, ничего не теряется.
--
-- Что добавляется:
--   password_hash — становится NULLABLE. NULL читается однозначно: пароля у
--                    аккаунта нет, вход только через внешний сервис;
--   email         — ключ, по которому внешний вход узнаёт человека.
--                    У обычных аккаунтов остаётся NULL;
--   provider      — 'local' для обычных, 'yandex' для внешних. CHECK держит
--                    список закрытым, как и в user_roles;
--   provider_id   — идентификатор человека во внешнем сервисе. Уникален в
--                    паре с provider: у Яндекса свои id, и смешивать их с
--                    будущими поставщиками нельзя.

CREATE TABLE users_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL,
  password_hash TEXT,
  master_id     INTEGER UNIQUE REFERENCES masters(id),
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  email         TEXT,
  provider      TEXT NOT NULL DEFAULT 'local'
                  CHECK (provider IN ('local', 'yandex')),
  provider_id   TEXT,
  UNIQUE (username)
);

-- Перенос существующих пользователей. Новые колонки не заполняем: пароль и
-- почта остаются как были, provider схлопывается в 'local' по умолчанию.
INSERT INTO users_new (id, username, password_hash, master_id, is_active, last_login_at)
SELECT id, username, password_hash, master_id, is_active, last_login_at FROM users;

DROP TABLE users;

ALTER TABLE users_new RENAME TO users;

-- Уникальные индексы (у UNIQUE-ограничений они создавались автоматически и
-- вместе с таблицей пропали). NULL в SQLite не сравнивается с NULL, поэтому
-- сколько угодно обычных аккаунтов без почты и без внешнего id друг другу не
-- мешают — ограничение срабатывает только на непустых значениях.
--
-- Второй индекс на те же колонки не нужен: внешний вход ищет и по связке
-- provider + provider_id, и этот индекс её покрывает.
CREATE UNIQUE INDEX idx_users_email ON users(email);
CREATE UNIQUE INDEX idx_users_provider ON users(provider, provider_id);