# Схема базы данных SQLite — сервис записи студии «Ноготочки»

Версия схемы: 1.1
БД: SQLite 3
Кодировка: UTF-8

---

## 1. Формальные договорённости

### 1.1. Единый формат дат и времени

Все даты и время хранятся как **текст в формате ISO 8601**:

| Что | Формат | Пример | Комментарий |
|---|---|---|---|
| Дата события записи | `YYYY-MM-DD HH:MM:SS` | `2026-10-03 14:00:00` | локальное время студии |
| Дата и время создания/изменения | `YYYY-MM-DD HH:MM:SS` | `2026-09-24 09:12:00` | локальное время студии |

**Почему именно так:**

1. **SQLite не имеет встроенного типа «дата-время».** Он хранит даты как TEXT, INTEGER (Unix-время) или REAL. Использование текста ISO 8601 — штатный, документированный подход.
2. **Один формат = нет путаницы.** Вся база использует ровно одну конвенцию: `YYYY-MM-DD HH:MM:SS`. Нельзя случайно сравнить «строку с датой» и «число». Разработчику и читателю не нужно помнить два правила.
3. **Строковое сравнение == хронологический порядок.** Для ISO 8601 в фиксированном виде лексикографическая сортировка словом `ORDER BY` совпадает с сортировкой по времени. Никакие функции конвертации для сортировки не требуются.
4. **Локальное время студии, а не UTC.** Студия работает в одном городе (Воронеж, UTC+3). Россия не переходит на летнее время с 2014 года, поэтому локальное время — константа, и хранить его «как есть» безопасно и просто: клиент видит ровно то, что записано в базе, без пересчёта. Если в будущем появится второй город/часовой пояс — добавим колонку `tz_offset`, но сейчас она не нужна (лишняя сложность без пользы).

**Правило «одна строка = один момент»:** для записи клиента хранится **одна** колонка `starts_at` (дата и время начала), а не пара `date` + `time`. Это исключает возможность рассинхрона «дата из одной строки, время из другой».

### 1.2. Деньги

Все суммы — **целые числа в копейках** (INTEGER). Хранение денег в `REAL` (дробных) приводит к ошибкам округления. 1800 ₽ хранится как `180000`.

### 1.3. Включение внешних ключей

SQLite по умолчанию **не** проверяет внешние ключи. При каждом подключении к базе нужно выполнять:

```sql
PRAGMA foreign_keys = ON;
```

Без этого FK «работают» только на бумаге, и можно удалить мастера, у которого есть записи.

---

## 2. Данные по экранам (карта связей → данные)

Разбор экранов прототипа, чтобы понять, **какие данные должны храниться**.

| Экран | Что показывает | Какие данные нужны |
|---|---|---|
| **Лендинг** (`index.html#services`) | Каталог услуг: название, описание, цена, длительность, фото | services |
| **Лендинг** (`index.html#masters`) | Мастера: фото, имя, роль («маникюр и брови»), опыт | masters |
| **Лендинг** (`index.html#about`) + футер | Адрес, телефон, Telegram, график работы студии | studio_info |
| **Запись, шаг 1** | Список услуг с ценами | services |
| **Запись, шаг 2** | Мастера — **только те, кто умеет выбранную услугу** | master_services |
| **Запись, шаг 3–4** | Свободные даты и слоты | график мастера (master_schedule) минус записи (bookings) минус блокировки (work_blocks) минус закрытия студии (studio_closures) |
| **Запись, шаг 5** | Имя, телефон клиента, сумма к оплате | `` (вводится) → clients, bookings |
| **Подтверждение** (`success.html`) | Сводка записи, «к оплате», контакты студии | bookings, studio_info |
| **Мои записи** (`appointments.html`) | Список записей клиента: услуга, дата/время, мастер, цена, статус; кнопка «отменить» | bookings по клиенту |
| **Панель мастера** (дашборд) | Всего записей, активные, выручка, число мастеров | bookings, masters |
| **Панель мастера** (заявки) | Заявки: услуга, клиент, дата/время, сумма, статус | bookings + masters + services + clients |
| **Панель мастера** (мастера) | ФИО, специализация, опыт, список услуг | masters, master_services |
| **Панель мастера** (расписание) | Неделя: приёмы клиентов и перерывы | bookings, work_blocks |
| **Вход в панель** (не в прототипе, но нужен для пароля) | Логин + пароль администратора/мастера | users (только хеш пароля) |
| **Оплата** (предоплата по product knowledge) | Статус предоплаты через ЮKassa | payments |

---

## 3. Таблицы

### 3.1. `services` — каталог услуг

Список процедур с ценами и длительностью. Рендерит каталог на лендинге, шаг «Услуга» и сводку в админке.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK, AUTOINCREMENT | Идентификатор услуги |
| `name` | TEXT | NOT NULL | Название услуги |
| `description` | TEXT | NOT NULL | Краткое описание (для карточки) |
| `price_kopecks` | INTEGER | NOT NULL | Цена в копейках (см. §1.2) |
| `duration_minutes` | INTEGER | NOT NULL | Длительность процедуры в минутах |
| `photo_path` | TEXT | NULL | Путь к фото (SVG/файл); NULL = фото по умолчанию |
| `is_active` | INTEGER | NOT NULL, DEFAULT 1 | 1 — показывать в каталоге, 0 — скрыта |
| `created_at` | TEXT | NOT NULL | Дата создания |
| `updated_at` | TEXT | NULL | Дата последнего изменения |

**UNIQUE:** `name`.

**FK:** нет.

```sql
CREATE TABLE services (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  price_kopecks   INTEGER NOT NULL CHECK (price_kopecks >= 0),
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  photo_path      TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT,
  UNIQUE (name)
);
```

---

### 3.2. `masters` — мастера студии

Список мастеров. Рендерит блок «Наши мастера» и таблицу «Мастера студии» в админке.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK, AUTOINCREMENT | Идентификатор мастера |
| `name` | TEXT | NOT NULL | Имя |
| `role` | TEXT | NOT NULL | Специализация («Мастер маникюра и бровей», «Бровист») |
| `experience_years` | INTEGER | NOT NULL | Опыт в годах для строки «в профессии…» |
| `photo_path` | TEXT | NULL | Путь к фото; NULL = фото по умолчанию |
| `is_active` | INTEGER | NOT NULL, DEFAULT 1 | 1 — принимает записи, 0 — скрыт |
| `created_at` | TEXT | NOT NULL | Дата создания |
| `updated_at` | TEXT | NULL | Дата последнего изменения |

**UNIQUE:** нет (имя может совпадать — проверять не будем, личность мастера привязывается через `id`).

**FK:** нет.

```sql
CREATE TABLE masters (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  role             TEXT NOT NULL,
  experience_years INTEGER NOT NULL DEFAULT 0,
  photo_path       TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT
);
```

---

### 3.3. `studio_info` — контакты и сведения о студии

Справочные данные самой студии: адрес, телефон, Telegram, график работы. Рендерит блок «О студии» на лендинге, футер и блок «Как нас найти» на странице подтверждения (`success.html`).

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK, AUTOINCREMENT | Идентификатор |
| `studio_name` | TEXT | NOT NULL | Название («Ноготочки») |
| `address` | TEXT | NOT NULL | Адрес студии («г. Воронеж, Проспект Революции, д. 10») |
| `phone` | TEXT | NOT NULL | Телефон в нормализованном виде: `+79004535000` |
| `telegram` | TEXT | NULL, UNIQUE | Имя в Telegram (`@Vibekatena`) |
| `map_hint` | TEXT | NULL | Подсказка «как добраться» (произвольный текст) |
| `updated_at` | TEXT | NULL | Когда менялись контакты |

**Замечание:** таблица рассчитана на **одну строку** (студия одна) — `PRAGMA`-хранилище обновляет её, а не вставляет новые. `UNIQUE` осмысленных полей здесь не нужен: важен сам факт «единой записи», который обеспечивается приложением (всегда `id = 1`).

**FK:** нет.

```sql
CREATE TABLE studio_info (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  studio_name   TEXT NOT NULL,
  address       TEXT NOT NULL,
  phone         TEXT NOT NULL,
  telegram      TEXT UNIQUE,
  map_hint      TEXT,
  updated_at    TEXT
);
```

**Замечание про график:** «График текстом» (например, «вт–сб, 10:00–20:00») здесь **не хранится** — это дубликат данных `master_schedule`. Текст для блока «О студии» строится из `master_schedule` (единый график мастеров получается выборкой). Это исключает рассинхрон: изменение рабочего расписания в одном месте автоматически обновляет и текст на лендинге.

---

### 3.4. `master_services` — какие услуги умеет каждый мастер

Связь «многие ко многим» между мастерами и услугами. Нужна для шага 2 записи: показываем **только тех мастеров, которые выполняют выбранную услугу** (как в прототипе: Анна — [1,2,3,4], Ольга — [5,6]).

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `master_id` | INTEGER | NOT NULL | FK → masters.id |
| `service_id` | INTEGER | NOT NULL | FK → services.id |

**PK:** `(master_id, service_id)` — составной первичный ключ.

```sql
CREATE TABLE master_services (
  master_id  INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (master_id, service_id)
);
```

`ON DELETE CASCADE`: при удалении мастера или услуги связи удаляются автоматически, не оставляя «висячих» строк.

---

### 3.5. `master_schedule` — график работы мастера по неделе

Регулярный график «в какие дни недели и с какого времени работает мастер». В прототипе это константа `WORK_DAYS = [2,3,4,5,6]` и `WORK_START..WORK_END = 10..20`.

**Здесь НЕ хранятся слоты и не хранятся «свободные даты»** — только регулярный повторяющийся график. Свободное время **вычисляется** на лету (см. §3.8).

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK, AUTOINCREMENT | Идентификатор строки графика |
| `master_id` | INTEGER | NOT NULL | FK → masters.id |
| `weekday` | INTEGER | NOT NULL | День недели 0–6 (0=вс, … 6=сб) |
| `start_minutes` | INTEGER | NOT NULL | Начало работы, минуты от полуночи (10:00 = 600) |
| `end_minutes` | INTEGER | NOT NULL | Конец работы (20:00 = 1200) |

**UNIQUE:** `(master_id, weekday)` — у мастера не может быть двух графиков на один день недели.

**FK:** `master_id` → masters.id (CASCADE).

```sql
CREATE TABLE master_schedule (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  master_id     INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  weekday       INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_minutes INTEGER NOT NULL CHECK (start_minutes BETWEEN 0 AND 1439),
  end_minutes   INTEGER NOT NULL CHECK (end_minutes > start_minutes AND end_minutes <= 1440),
  UNIQUE (master_id, weekday)
);
```

---

### 3.6. `work_blocks` — блокировки времени (перерывы, выходные, отпуска)

Разовые исключения из графика: перерыв на обед, выходной в рабочий день, отпуск мастера. Занятые интервалы, в которые **нельзя** записать клиента. В прототипе это карта `DEMO_PAUSED`.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK, AUTOINCREMENT | Идентификатор блокировки |
| `master_id` | INTEGER | NOT NULL | FK → masters.id |
| `starts_at` | TEXT | NOT NULL | Начало блока (`YYYY-MM-DD HH:MM:SS`) |
| `ends_at` | TEXT | NOT NULL | Конец блока |
| `reason` | TEXT | NOT NULL, DEFAULT 'break' | Причина — фиксированный набор (см. §5.1) |

**FK:** `master_id` → masters.id (CASCADE).

**CHECK:** `ends_at > starts_at` — блок не может «длиться назад».

```sql
CREATE TABLE work_blocks (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  master_id INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  ends_at   TEXT NOT NULL,
  reason    TEXT NOT NULL DEFAULT 'break'
    CHECK (reason IN ('break','day_off','vacation','sick','other')),
  CHECK (ends_at > starts_at)
);
```

---

### 3.7. `studio_closures` — дни полного закрытия студии

Дни, когда студия не работает **целиком** (праздники, санитарные дни), в отличие от `work_blocks`, которые закрывают время у **конкретного мастера**. Учитывается при вычислении свободных слотов: в такие дни записи у всех мастеров предложены быть не могут.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK, AUTOINCREMENT | Идентификатор закрытия |
| `starts_at` | TEXT | NOT NULL | Начало закрытия (`YYYY-MM-DD HH:MM:SS`) |
| `ends_at` | TEXT | NOT NULL | Конец закрытия |
| `reason` | TEXT | NOT NULL, DEFAULT 'holiday' | Причина — фиксированный набор (см. §5.1) |
| `created_at` | TEXT | NOT NULL | Когда внесено |

**CHECK:** `ends_at > starts_at`.

**FK:** нет (закрытие затрагивает всех мастеров).

```sql
CREATE TABLE studio_closures (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  starts_at  TEXT NOT NULL,
  ends_at    TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT 'holiday'
    CHECK (reason IN ('holiday','sanitary','sick','other')),
  created_at TEXT NOT NULL,
  CHECK (ends_at > starts_at)
);
```

---

### 3.8. `bookings` — записи клиентов

Центральная таблица: собственно визиты клиентов. Из неё строятся экраны «Мои записи», дашборд, заявки в админке и — вместе с графиком и блокировками — вычисляются свободные слоты.

**Статус записи — фиксированный набор** (`wait / confirmed / done / canceled`), см. §5.1.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK, AUTOINCREMENT | Идентификатор записи |
| `client_id` | INTEGER | NOT NULL | FK → clients.id |
| `service_id` | INTEGER | NOT NULL | FK → services.id |
| `master_id` | INTEGER | NOT NULL | FK → masters.id |
| `starts_at` | TEXT | NOT NULL | Дата и время начала (`YYYY-MM-DD HH:MM:SS`) |
| `ends_at` | TEXT | NOT NULL | Дата и время окончания (вычислено из длительности услуги) |
| `status` | TEXT | NOT NULL, DEFAULT 'wait' | Статус, фиксированный набор |
| `comment` | TEXT | NULL | Пожелания клиента |
| `source` | TEXT | NOT NULL, DEFAULT 'web' | Откуда пришла запись (`web` / `telegram`) |
| `force_override` | INTEGER | NOT NULL, DEFAULT 0 | Признак осознанного наложения (0/1) — запись создана поверх занятого времени администратором (`owner`) |
| `created_at` | TEXT | NOT NULL | Когда создана запись |
| `updated_at` | TEXT | NULL | Когда изменялась |

**UNIQUE:** `(master_id, starts_at)` — только для активных записей **без** `force_override` (частичный индекс `idx_bookings_active_start`): обычная запись не может *начинаться* в тот же момент, что и другая активная обычная запись мастера; записи с `force_override = 1` и отменённые этот индекс не видит.

**FK:** `client_id`, `service_id`, `master_id` (удаление записей при удалении услуги — `ON DELETE RESTRICT`: запись удалять нельзя, услугу — только если на неё нет записей).

**Вычисление свободных слотов (требование 3):**
Свободный слот для мастера M на момент времени T считается запросом, а не хранится:

```
Свободно(M, T) = есть строка master_schedule(M, T.weekday),
                 start_minutes <= T.moment И T.moment + длительность <= end_minutes
                 И НЕТ (booking у M, пересекающий [T, T+длина))
                 И НЕТ (work_block у M, пересекающий [T, T+длина))
                 И НЕТ (studio_closures, покрывающий [T, T+длина))
```

Так «свободное время» всегда автоматически учитывает любые новые записи, блокировки и изменения графика — не может быть ситуации, когда в «таблице слотов» написано свободно, а реально занято.

```sql
CREATE TABLE bookings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id     INTEGER NOT NULL REFERENCES clients(id),
  service_id    INTEGER NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  master_id     INTEGER NOT NULL REFERENCES masters(id) ON DELETE RESTRICT,
  starts_at     TEXT NOT NULL,
  ends_at       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'wait'
    CHECK (status IN ('wait','confirmed','done','canceled')),
  comment       TEXT,
  source        TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','telegram')),
  force_override INTEGER NOT NULL DEFAULT 0
    CHECK (force_override IN (0, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  CHECK (ends_at > starts_at)
);
```

**Замечание про пересечение записей (миграции 004–005):** защиту от пересечения интервалов одного мастера обеспечивают **триггеры** `trg_bookings_no_overlap_insert` / `trg_bookings_no_overlap_update` (условие `b.starts_at < NEW.ends_at AND b.ends_at > NEW.starts_at`, вплотную допустимо, отменённые не учитываются). Триггеры пропускают записи с `force_override = 1` — это легализованное администратором наложение. Запись с `force_override = 1`, однажды созданная, участвует в проверках пересечений как обычная (в подзапросе триггера она не исключается) и блокирует других кандидатов. Снять признак с записи, по факту пересекающей другую, триггер UPDATE запретит. Подробнее — §8.18.

**Почему в записи нет цены:** цена услуги хранится в одном месте — `services.price_kopecks`. Запись ссылается на услугу по `service_id`, а текущая цена/выручка получается JOIN'ом (`bookings ⋈ services`). Так не бывает двух источников правды о цене. Нюанс про «цену на момент записи» — см. §8.3.

**Замечание про «задвоение»:** защиту от пересечения дают триггеры (см. выше) плюс частичный UNIQUE по времени начала (страховка от одинакового старта без учёта длительности услуг). Роль `client` без `force_override` через такой контроль «пересечения интервалов» провести запись не может — единственное исключение делает администратор признаком `force_override` (см. §8.18).

---

### 3.9. `slot_holds` — удержание слота на время оформления

Клиент выбрал слонпка и заполняет форму/вводит контакты — на эти минуты слот можно «удержать», чтобы его не забрал другой клиент. Удержание не создано до подтверждения записи.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK, AUTOINCREMENT | Идентификатор удержания |
| `master_id` | INTEGER | NOT NULL, FK | → masters.id: чей слот удержан |
| `starts_at` | TEXT | NOT NULL | Начало удержанного интервала (локальное время салона) |
| `ends_at` | TEXT | NOT NULL | Конец интервала (локальное время салона) |
| `duration_minutes` | INTEGER | NOT NULL | Полная длительность удержанного интервала (сумма выбранных услуг) |
| `status` | TEXT | NOT NULL, DEFAULT 'active' | `active` — действует, `used` — превратилось в запись, `canceled` — снято |
| `token_hash` | TEXT | NOT NULL, UNIQUE | SHA-256 от одноразового токена: клиент получает токен, бэкенд хранит только хеш |
| `created_by` | INTEGER | NOT NULL, FK | → users.id: кто удерживает (авторизованный клиент или владелец) |
| `created_at` | TEXT | NOT NULL | Когда удержан |
| `expires_at` | TEXT | NOT NULL | Когда удержание теряет силу (обычно +10 минут) |

**UNIQUE-индекс:** `(master_id, starts_at)` только для `status='active'` — два активных удержания одного слота невозможны даже при одновременных запросах (защита от гонки).

**Индексы:** `(master_id, starts_at, ends_at)` для поиска пересечений при расчёте свободного времени; `(expires_at)` — для фоновой очистки истёкших.

Просроченные удержания не удаляются в момент обращения (кроме явной проверки при создании записи), а чистятся периодическим заданием раз в минуту.

```sql
CREATE TABLE slot_holds (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  master_id        INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  starts_at        TEXT NOT NULL,
  ends_at          TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','canceled')),
  token_hash       TEXT NOT NULL UNIQUE,
  created_by       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  CHECK (ends_at > starts_at)
);
CREATE UNIQUE INDEX idx_holds_active_slot ON slot_holds(master_id, starts_at) WHERE status = 'active';
CREATE INDEX idx_holds_master_start ON slot_holds(master_id, starts_at, ends_at);
CREATE INDEX idx_holds_expires ON slot_holds(expires_at);
```

---

### 3.10. `clients` — клиенты

Профиль клиента. В прототипе имя и телефон писались прямо в запись; в схеме они вынесены в таблицу, чтобы один клиент узнавался по телефону/Telegram между визитами («Мои записи» = все записи по его `client_id`).

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK, AUTOINCREMENT | Идентификатор клиента |
| `name` | TEXT | NOT NULL | Имя |
| `phone` | TEXT | NOT NULL | Телефон в едином нормализованном виде: `+7 (900) ...` → `+79004535000` |
| `telegram_id` | INTEGER | NULL, UNIQUE | Telegram user id, если клиент пришёл из бота |
| `user_id` | INTEGER | NULL, UNIQUE | FK → users.id: аккаунт входа, к которому привязан профиль клиента (для регистрации через API) |
| `created_at` | TEXT | NOT NULL | Когда создан профиль клиента |

**UNIQUE:** `phone`; `telegram_id` (если задан) — тоже уникален; `user_id` (если задан) — уникален, чтобы один аккаунт входа не соответствовал нескольким профилям.

```sql
CREATE TABLE clients (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  telegram_id INTEGER UNIQUE,
  user_id     INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  UNIQUE (phone)
);
```

---

### 3.11. `users` — учётные записи для входа в панель

Владелец, мастера и клиенты входят в сервис. **Хранится только хеш пароля, самого пароля в базе нет.**

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK, AUTOINCREMENT | Идентификатор |
| `username` | TEXT | NOT NULL | Логин для входа |
| `password_hash` | TEXT | NOT NULL | Хеш пароля (bcrypt/argon2 — высокая стоимость, например аргон2id или bcrypt cost=12). Пароль в открытом виде **никогда** не сохраняется |
| `master_id` | INTEGER | NULL, UNIQUE | FK → masters.id; NULL для владельца, не являющегося мастером |
| `role` | TEXT | NOT NULL, DEFAULT 'master' | `owner` — владелец, `master` — мастер, `client` — клиент |
| `is_active` | INTEGER | NOT NULL, DEFAULT 1 | 1 — можно входить |
| `last_login_at` | TEXT | NULL | Последний вход |

**UNIQUE:** `username`.

**FK:** `master_id` → masters.id.

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  master_id     INTEGER UNIQUE REFERENCES masters(id),
  role          TEXT NOT NULL DEFAULT 'master' CHECK (role IN ('owner','master','client')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  UNIQUE (username)
);
```

---

### 3.12. `payments` — оплаты (предоплата)

Студия работает по модели предоплаты (полная предоплата за бронирование). Платёж проводится через ЮKassa. Таблица фиксирует статус оплаты для каждой записи.

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | INTEGER | PK, AUTOINCREMENT | Идентификатор платежа |
| `booking_id` | INTEGER | NOT NULL | FK → bookings.id |
| `amount_kopecks` | INTEGER | NOT NULL | Сумма платежа в копейках |
| `provider` | TEXT | NOT NULL, DEFAULT 'yookassa' | Платёжный провайдер (`yookassa` / `sbp` / `cash`) |
| `status` | TEXT | NOT NULL, DEFAULT 'pending' | `pending / paid / failed / refunded` |
| `external_id` | TEXT | NULL | ID платежа в ЮKassa |
| `paid_at` | TEXT | NULL | Момент успешной оплаты |
| `created_at` | TEXT | NOT NULL | Момент создания платежа |

**FK:** `booking_id` → bookings.id (RESTRICT).

```sql
CREATE TABLE payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id     INTEGER NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks >= 0),
  provider       TEXT NOT NULL DEFAULT 'yookassa' CHECK (provider IN ('yookassa','sbp','cash')),
  status         TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','failed','refunded')),
  external_id    TEXT,
  paid_at        TEXT,
  created_at     TEXT NOT NULL
);
```

---

## 4. Схема целиком (сводный SQL)

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE services (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  price_kopecks   INTEGER NOT NULL CHECK (price_kopecks >= 0),
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  photo_path      TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT,
  UNIQUE (name)
);

CREATE TABLE masters (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  role             TEXT NOT NULL,
  experience_years INTEGER NOT NULL DEFAULT 0,
  photo_path       TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT
);

CREATE TABLE studio_info (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  studio_name   TEXT NOT NULL,
  address       TEXT NOT NULL,
  phone         TEXT NOT NULL,
  telegram      TEXT UNIQUE,
  map_hint      TEXT,
  updated_at    TEXT
);

CREATE TABLE master_services (
  master_id  INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (master_id, service_id)
);

CREATE TABLE master_schedule (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  master_id     INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  weekday       INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_minutes INTEGER NOT NULL CHECK (start_minutes BETWEEN 0 AND 1439),
  end_minutes   INTEGER NOT NULL CHECK (end_minutes > start_minutes AND end_minutes <= 1440),
  UNIQUE (master_id, weekday)
);

CREATE TABLE work_blocks (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  master_id INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  ends_at   TEXT NOT NULL,
  reason    TEXT NOT NULL DEFAULT 'break'
    CHECK (reason IN ('break','day_off','vacation','sick','other')),
  CHECK (ends_at > starts_at)
);

CREATE TABLE studio_closures (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  starts_at  TEXT NOT NULL,
  ends_at    TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT 'holiday'
    CHECK (reason IN ('holiday','sanitary','sick','other')),
  created_at TEXT NOT NULL,
  CHECK (ends_at > starts_at)
);

CREATE TABLE clients (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  telegram_id INTEGER UNIQUE,
  user_id     INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  UNIQUE (phone)
);

CREATE TABLE slot_holds (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  master_id        INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  starts_at        TEXT NOT NULL,
  ends_at          TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','canceled')),
  token_hash       TEXT NOT NULL UNIQUE,
  created_by       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  CHECK (ends_at > starts_at)
);

CREATE UNIQUE INDEX idx_holds_active_slot ON slot_holds(master_id, starts_at) WHERE status = 'active';
CREATE INDEX idx_holds_master_start ON slot_holds(master_id, starts_at, ends_at);
CREATE INDEX idx_holds_expires ON slot_holds(expires_at);

CREATE TABLE bookings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id     INTEGER NOT NULL REFERENCES clients(id),
  service_id    INTEGER NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  master_id     INTEGER NOT NULL REFERENCES masters(id) ON DELETE RESTRICT,
  starts_at     TEXT NOT NULL,
  ends_at       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'wait'
    CHECK (status IN ('wait','confirmed','done','canceled')),
  comment       TEXT,
  source        TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','telegram')),
  force_override INTEGER NOT NULL DEFAULT 0
    CHECK (force_override IN (0, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  CHECK (ends_at > starts_at)
);

CREATE UNIQUE INDEX idx_bookings_active_start ON bookings(master_id, starts_at)
  WHERE status != 'canceled' AND force_override = 0;

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  master_id     INTEGER UNIQUE REFERENCES masters(id),
  role          TEXT NOT NULL DEFAULT 'master' CHECK (role IN ('owner','master','client')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  UNIQUE (username)
);

CREATE TABLE payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id     INTEGER NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks >= 0),
  provider       TEXT NOT NULL DEFAULT 'yookassa' CHECK (provider IN ('yookassa','sbp','cash')),
  status         TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','failed','refunded')),
  external_id    TEXT,
  paid_at        TEXT,
  created_at     TEXT NOT NULL
);
```

---

## 5. Статусы и перечисления (фиксированные наборы)

### 5.1. Где фиксированный набор, а где «текст в поле»

| Поле | Набор значений | Почему именно CHECK |
|---|---|---|
| `bookings.status` | `wait` (ожидает подтверждения) · `confirmed` · `done` · `canceled` | Статусы жёстко заданы логикой: избегает опечаток и «своих» статусов вроде «ОЖИДАЕТСЯ» |
| `users.role` | `owner` · `master` · `client` | Роли фиксированы ролями продукта |
| `payments.status` | `pending` · `paid` · `failed` · `refunded` | Машина состояний платежа |
| `payments.provider` | `yookassa` · `sbp` · `cash` | Известные способы оплаты |
| `bookings.source` | `web` · `telegram` | Два канала записи |
| `work_blocks.reason` | `break` · `day_off` · `vacation` · `sick` · `other` | Причины блокировки |
| `studio_closures.reason` | `holiday` · `sanitary` · `sick` · `other` | Причины полного закрытия студии |

**Зачем CHECK вместо свободной строки:** если позволить «любую строку», через год в базе окажутся `wait`, `Waiting`, `подтверждена` — и каждое место, где статус проверяют, ломается или тихо ведёт себя неправильно (например, не показывает запись в «Активные»). CHECK делает правило явным и проверяемым на уровне самой базы.

---

## 6. Уникальные ограничения и индексы

### 6.1. Уникальные ограничения

| # | Ограничение | Таблица | Зачем | Что сломается без него |
|---|---|---|---|---|
| 1 | `UNIQUE (name)` | services | Две услуги не могут называться одинаково («Маникюр» × 2 — невозможно отличить) | Дубли услуг, ошибки цен и отчётов |
| 2 | `PRIMARY KEY (master_id, service_id)` | master_services | Связь «мастер-услуга» уникальна, нельзя добавить её дважды | Вероятность задублированного поля «умеет услугу» |
| 3 | `UNIQUE (master_id, weekday)` | master_schedule | На один день недели у мастера один график | Два графика в один день — какой «правильный»? свободные слоты начинают противоречить друг другу |
| 4 | `UNIQUE (master_id, starts_at)` частичный, `WHERE status != 'canceled' AND force_override = 0` | bookings | Два клиента не могут **начать** запись к мастеру в один момент. Признак `force_override = 1` (осознанное наложение администратором) из индекса исключён | Задвоение записи: два клиента в один слот, мастер не успевает |
| 5 | `UNIQUE (phone)` | clients | Один телефон = один клиент | Дубли профиля: «Мои записи» разъезжаются между двумя карточками одного человека |
| 6 | `UNIQUE (telegram_id)` | clients | Один telegram user = один клиент | Бот создаёт клон клиента при каждом входе |
| 7 | `UNIQUE (username)` | users | Логины уникальны | Невозможно определить, чей аккаунт |
| 8 | `UNIQUE (master_id)` | users | У каждого мастера не больше одного аккаунта | Два пароля на одного мастера — непонятно, какой «настоящий» |
| 9 | `UNIQUE (telegram)` | studio_info | Контакт студии в Telegram один (если указан) | Два Telegram-адреса в строках — непонятно, какой показывать в «О студии» |
| 10 | `UNIQUE (user_id)` | clients | Один аккаунт входа = один профиль клиента | Аккаунт может оказаться привязан к двум профилям — непонятно, от чьего имени записываться |
| 11 | `UNIQUE (token_hash)` | slot_holds | Токен удержания одноразовый: каждому токену отвечает ровно одно удержание | Подделка/повтор токена создаёт второе удержание того же слота |
| 12 | `UNIQUE (master_id, starts_at)` частичный, `WHERE status='active'` | slot_holds | Одновременно активное удержание одного слота — только одно (защита от гонки) | Два «активных» удержания одного слота: оба клиента думают, что слот их |

### 6.2. Индексы

| # | Индекс | Таблица | Зачем простыми словами | Что сломается без него |
|---|---|---|---|---|
| 1 | `idx_bookings_client` на `(client_id)` | bookings | «Покажи мои записи» — частый запрос по клиенту | Экран «Мои записи» будет сканировать все записи студии ради нескольких строк клиента — растёт поиск на каждой записи |
| 2 | `idx_bookings_master_start` на `(master_id, starts_at)` | bookings | Вычисление свободных слотов: «есть ли занято у мастера в окне дат?» | Каждый расчёт свободного времени перебирает все записи студии; с ростом базы — медленно |
| 3 | `idx_blocks_master_start` на `(master_id, starts_at, ends_at)` | work_blocks | Тот же запрос для блокировок | Свободные слоты не видят блоки, пока не переберут всю таблицу |
| 4 | `idx_bookings_status` на `(status)` | bookings | Фильтры «новые заявки», «активные» в дашборде | Дашборд и список заявок фильтруют все записи |
| 5 | `idx_services_active` на `(is_active)` | services | Быстро показать только активные услуги (их мало — индекс лёгкий, но фильтр по `is_active = 1` не сканирует все строки) | Не критично при 6 услугах, но дёшево иметь |
| 6 | `idx_payments_booking` на `(booking_id)` | payments | Найти платёж по записи при обработке вебхука ЮKassa | Каждая проверка статуса оплаты перебирает все платежи |
| 7 | `idx_master_services_master` на `(master_id)` (другая часть PK) | master_services | Обратный запрос «все услуги мастера» (в админке — таблица мастеров) | Перебор всех строк связи |
| 8 | `idx_closures_start` на `(starts_at, ends_at)` | studio_closures | При вычислении свободных слотов проверить, не закрыта ли студия на отрезок [start, end] | Каждая проверка «открыта ли студия» сканирует все закрытия |
| 9 | `idx_holds_active_slot` (UNIQUE, частичный) на `(master_id, starts_at)` `WHERE status='active'` | slot_holds | Слот физически не может быть удержан дважды одновременно | Гонка: два клиента одновременно получают «свободный» слот и думают, что уже забронировали |
| 10 | `idx_holds_master_start` на `(master_id, starts_at, ends_at)` | slot_holds | Активные удержания входят в расчёт занятых интервалов свободного времени | Свободные слоты не видят удержания — клиент бронирует уже «держанный» слот |
| 11 | `idx_holds_expires` на `(expires_at)` | slot_holds | Фоновая чистка истёкших удержаний раз в минуту | Истёкшие удержания копятся и блокируют слоты до перезапуска |
| 12 | `idx_bookings_active_start` (UNIQUE, частичный) на `(master_id, starts_at)` `WHERE status != 'canceled' AND force_override = 0` | bookings | Два активных обычных начала записи у одного мастера невозможны — страховка поверх триггеров пересечения (миграции 004–005) | Гонка: два одновременных запроса прочитали «слот свободен» и оба записались в один момент начала |

```sql
-- Индексы (двухиндекс на UNIQUE не делаем — они уже индексированы сами)
CREATE INDEX idx_bookings_client       ON bookings(client_id);
CREATE INDEX idx_bookings_master_start ON bookings(master_id, starts_at);
CREATE INDEX idx_blocks_master_start   ON work_blocks(master_id, starts_at, ends_at);
CREATE INDEX idx_bookings_status       ON bookings(status);
CREATE INDEX idx_services_active       ON services(is_active);
CREATE INDEX idx_payments_booking      ON payments(booking_id);
CREATE INDEX idx_master_services_master ON master_services(master_id);
CREATE INDEX idx_closures_start        ON studio_closures(starts_at, ends_at);
CREATE UNIQUE INDEX idx_holds_active_slot ON slot_holds(master_id, starts_at) WHERE status = 'active';
CREATE INDEX idx_holds_master_start    ON slot_holds(master_id, starts_at, ends_at);
CREATE INDEX idx_holds_expires         ON slot_holds(expires_at);
CREATE UNIQUE INDEX idx_bookings_active_start ON bookings(master_id, starts_at) WHERE status != 'canceled' AND force_override = 0;
```

**Триггеры пересечения записей (миграции 004–005):**

```sql
-- Новую/изменённую запись, пересекающую активную запись того же мастера,
-- отклоняем (BOOKING_TIME_CONFLICT). Вплотную — допустимо. Отменённые
-- не считаются. Записи с force_override = 1 из проверки исключены —
-- это осознанное наложение администратором; созданная так запись дальше
-- сама блокирует других (в подзапросе она не исключается).
CREATE TRIGGER trg_bookings_no_overlap_insert
BEFORE INSERT ON bookings
FOR EACH ROW
WHEN NEW.status != 'canceled' AND NEW.force_override = 0
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_TIME_CONFLICT')
  WHERE EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.master_id = NEW.master_id
      AND b.status != 'canceled'
      AND b.starts_at < NEW.ends_at
      AND b.ends_at > NEW.starts_at
  );
END;

CREATE TRIGGER trg_bookings_no_overlap_update
BEFORE UPDATE ON bookings
FOR EACH ROW
WHEN NEW.status != 'canceled' AND NEW.force_override = 0
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_TIME_CONFLICT')
  WHERE EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.master_id = NEW.master_id
      AND b.status != 'canceled'
      AND b.id != NEW.id
      AND b.starts_at < NEW.ends_at
      AND b.ends_at > NEW.starts_at
  );
END;
```

**Общая логика:** уникальные ограничения защищают **данные** (гарантируют, что «плохой» дубль вообще не может записаться), а индексы ускоряют **запросы**. Без уникальности появляются противоречивые данные, которые никто не починит автоматически. Без индексов данные остаются корректными, но каждый запрос «Мои записи»/«свободные слоты» превращается в полный перебор таблицы.

---

## 7. Запросы, которые проверяют схему

### 7.1. Проверка: хватает ли данных для вычисления свободных интервалов

Для расчёта свободных интервалов мастера на конкретный день нужны пять блоков данных. Сверка с схемой:

| # | Нужны данные | Таблица → поля | В схеме |
|---|---|---|---|
| 1 | График мастера (рабочие часы в этот день недели) | `master_schedule`: `master_id`, `weekday`, `start_minutes`, `end_minutes` | ✅ |
| 2 | Длительность услуги (чтобы проверить, что запись помещается в рабочий интервал) | `services.duration_minutes` | ✅ |
| 3 | Существующие записи с временем начала и окончания (занятые интервалы) | `bookings`: `master_id`, `starts_at`, `ends_at`, `status` (отсечь `canceled`) | ✅ |
| 4 | Блокировки времени у мастера и закрытия студии | `work_blocks` (`master_id`, `starts_at`, `ends_at`), `studio_closures` (`starts_at`, `ends_at`) | ✅ |
| 5 | Активные удержания слотов (слот на время оформления уже занят) | `slot_holds`: `master_id`, `starts_at`, `ends_at`, `status='active'`, `expires_at` в будущем | ✅ |

Все пять блоков уже есть в схеме — **дополнять таблицы не потребовалось**.

#### Пример: Екатерина, конкретный день

Допустим, хотим найти свободные слоты для Екатерины (master_id = 1) в субботу `2026-09-26` на услугу «Маникюр с покрытием гель-лаком» (длительность 90 минут).

**Шаг 1. Рабочие часы.** Берем из `master_schedule` строку `(master_id=1, weekday=6)`:

```
start_minutes = 600  → 10:00
end_minutes   = 1200 → 20:00
```

(Если такой строки нет — суббота для мастера нерабочая, слотов нет вообще.)

**Шаг 2. Длительность.** Из `services.duration_minutes` для услуги: **90 минут**: слот помещается в день, если `start + 90 <= end`.

**Шаг 3. Занятые записи.** Из `bookings` берём записи, которые пересекаются с `2026-09-26` и не отменены. Например:

| запись | cтатус | занятый интервал |
|---|---|---|
| b1 | confirmed | 10:00 – 11:30 |
| b2 | confirmed | 14:00 – 15:30 |
| b3 | **canceled** | 12:00 – 13:30 ← игнорируем |

**Шаг 4. Блокировки.** Из `work_blocks` для мастера 1: `13:00 – 14:00` (перерыв). Из `studio_closures`: на `2026-09-26` закрытий нет.

**Шаг 5. Расчёт.** Собираем «занятые» интервалы: `10:00–11:30`, `13:00–14:00` (перерыв), `14:00–15:30`. Свободное время в рабочем дне 10:00–20:00 (минус занятое, с шагом, кратным 90 минутам):

```
11:30 – 13:00  → свободно (90 мин помещается: 11:30..13:00 ≤ 13:00 начало перерыва)
15:30 – 20:00  → свободно (только 15:30, 17:00 помещаются → слоты 15:30, 17:00)
```

Итог для клиента: свободные слоты **11:30 и 15:30, 17:00**.

Запись, подтверждающая расчёт:

```sql
SELECT s.* FROM master_schedule s
WHERE s.master_id = :M AND s.weekday = strftime('%w', :D)
  AND NOT EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.master_id = :M
      AND b.starts_at < datetime(:D, ... '+end')
      AND b.ends_at   > :start
      AND b.status != 'canceled'
  )
  AND NOT EXISTS (
    SELECT 1 FROM work_blocks w
    WHERE w.master_id = :M
      AND w.starts_at < :end
      AND w.ends_at   > :start
  )
  AND NOT EXISTS (
    SELECT 1 FROM studio_closures c
    WHERE c.starts_at < :end
      AND c.ends_at   > :start
  );
```

(Итоговая сборка слотов — на стороне приложения поверх этих интервалов.)

### 7.2. Подтверждение: отдельной таблицы свободных слотов в схеме нет

В схеме **11 таблиц**, и среди них **нет** `slots` / `free_slots` / любой таблицы, хранящей заранее подготовленные свободные времена. Это проверено:

- Полный список таблиц (секция 3): `services`, `masters`, `studio_info`, `master_services`, `master_schedule`, `work_blocks`, `studio_closures`, `bookings`, `clients`, `users`, `payments`.
- Ни одна таблица не содержит поля «свободный/занятый слот» — время всегда получается запросом (§7.1).
- Требование «свободное время вычисляется из графика работы, записей и блокировок в момент запроса» выполнено: вся логика опирается на `master_schedule` + `bookings` + `work_blocks`/`studio_closures`.

Если в будущем появится соблазн «записать готовые слоты в таблицу» — это нарушит требование и создаст рассинхрон: слот придётся обновлять при каждой новой записи, блокировке и изменении графика. Вместо этого слоты вычисляются (§8.1).

---

## 8. Спорные решения

### 8.1. «Свободные слоты» — хранить или вычислять? → Вычислять

**Варианты:** (а) таблица `slots` с заранее созданными свободными слотами на месяц вперёд; (б) вычислять на лету из графика − записей − блокировок.

**Выбор:** (б), по требованию задачи. Слотами выбран «как есть» — это требование задания, но и с точки зрения здравого смысла оно правильное: хранимый слот — это дублирующееся состояние, которое нужно синхронизировать с тремя источниками (график, записи, блоки). При изменении любого из них «свободный слот» уже недостоверен, а рассинхрон сложно заметить. Вычисление даёт всегда актуальную картину ценою O(1)–O(n) запроса. Минус — каждый запрос считает заново; при малой загрузке студии это не проблема.

### 8.2. Единый формат времени: локальное `YYYY-MM-DD HH:MM:SS` текстом вместо UTC/unix

**Варианты:** (а) UTC-текст; (б) unix-число (INTEGER); (в) локальный ISO-текст.

**Выбор:** (в). В SQLite нет типа datetime; текст ISO сортируется верно сам по себе; локальное время убирает пересчёт для пользователя. Unix-число нечитаемо человеком и требует конверсии в каждом запросе. UTC выбран бы был, появись второй часовой пояс; сейчас это лишняя сложность. Риск зафиксирован: если география вырастет — добавится колонка с часовым поясом.

### 8.3. Хранить цену только в услуге (`services.price_kopecks`), а не дублировать в записи

**Варианты:** (а) ссылка только на `services.price` (в записи один FK `service_id`); (б) копия цены в `bookings` — «снимок на момент записи».

**Выбор:** (а) — **без дубликата**. Цена услуги живёт в одном источнике правды — `services.price_kopecks`; запись связана с услугой внешним ключом, и цена/выручка получаются JOIN'ом. Поле `price_kopecks` в `bookings` — то же самое значение, продублированное в двух таблицах: оно обязано совпадать с `services.price_kopecks` (иначе расхождение каталога и истории), а синхронизировать цену в двух местах прикладным кодом — лишняя работа и источник ошибок.

**Компромисс:** если владелец меняет цену, запись «унаследует» новую цену услуги на момент отображения, а не ту, что была при записи. Для ценообразования прототипа это приемлемо; при необходимости исторической точности добавят либо снимок в `bookings` осознанно, либо сумму факта фиксирует отдельный платёж (`payments.amount_kopecks`). Стоимость всегда в копейках — избегаем дробных ошибок.

### 8.4. Нормализовать клиента (`clients`), а не хранить имя/телефон в записи

**Варианты:** (а) `name`, `phone` прямо в `bookings` (как в прототипе); (б) отдельная таблица `clients`.

**Выбор:** (б). Без неё один человек с двумя записями — «два разных клиента»: «Мои записи» нельзся собрать по телефону/telegram_id, а админ не видит историю визитов одного человека. Минус нормализации — «расплывание» записей, если клиент сменит телефон; в прототипе (localStorage) таких проблем не было, в реальной БД — это уже не вариант.

### 8.5. Защита от пересечения записей — только UNIQUE «по времени начала»

**Варианты:** (а) UNIQUE(master_id, starts_at); (б) полный запрет пересечения интервалов (нельзя записать, если `[starts_at, ends_at)` пересекает другую запись) средствами СУБД.

**Выбор:** (а) как гарантия «в базе», плюс прикладная проверка пересечения при сохранении. Полный запрет пересечений в SQLite потребовал бы составной `exclusion`/триггеры — их нет в «чистом» SQLite без расширений. UNIQUE гарантирует главное (одинаковое время начала) на уровне БД, а проверку «пересекаются ли 10:00+2,5ч и 11:00» выполняет приложение перед `INSERT`, что в этом масштабе надёжно и просто.

### 8.6. Отдельная таблица `payments`, хотя прототип её не показывает

**Варианты:** (а) статус оплаты полем в `bookings`; (б) отдельная `payments`.

**Выбор:** (б). Прототип предоплату не проводит, но в product knowledge студия работает по полной предоплате через ЮKassa (в проекте уже есть `payments.py`, `check_yookassa.py`). Сумма одной записи может собираться по частям, а после — возвращаться. Отдельная таблица позволяет несколько платежей на запись и полную историю; поле в `bookings` годно только для «одна попытка → один результат».

### 8.7. Статус `wait` — «ожидает подтверждения»

**Дискуссия:** стоит ли добавлять статус «отклонена» (`rejected`) и «не пришёл» (`no_show`)? **Выбор:** пока 4 статуса ровно из прототипа: `wait, confirmed, done, canceled`. `rejected`/`no_show` — легко добавить позже `CHECK`-значением; сейчас их не требует ни один экран. Не усложняю то, что нет на экранах.

### 8.8. Хеш пароля: аргон2id/bcrypt, а не SHA

**Варианты:** (а) быстрые хеши (SHA-256); (б) медленные парольные хеши (bcrypt cost=12 / argon2id).

**Выбор:** (б). SHA-256 хешируется за микросекунды — перебор паролей массово осуществляется за дни. Парольные функции специально «дорогие», и каждое слово перебирается медленно. Примечание: хеш применятеся **только** в `users.password_hash`; в записи или другой таблице пароля нет.

### 8.9. PHPass каких reasons — `work_blocks.reason` как enum или свободный текст

**Варианты:** (а) свободный TEXT; (б) CHECK-набор.

**Выбор:** (б) — `break, day_off, vacation, sick, other`. Причина блокировки влияет только на отображение (иконка/цвет в расписании), а значит набор известен заранее. Свободный текст разъезжается на «обед», «Обед», «перерыв».

### 8.10. Отдельная таблица `master_services` как «многие ко многим»

**Варианты:** (а) JSON-массив услуг в текстовой колонке `masters.services` (как в `MASTERS[].services` в прототипе); (б) таблица связи.

**Выбор:** (б). VARCHAR список `[1,2,3,4]` нельзя индексировать и запрашивать «кто умеет услугу 5». Связь же даёт прямой запрос, уникальность пар и каскадное удаление. В вебе/прототипе JSON удобен, в реляционной БД — антипаттерн.

### 8.11. Поле `external_id` (ID платежа в ЮKassa) — уникальный или nullable

**Выбор:** nullable без UNIQUE. У ЮKassa свой ID обязателен, но у способов «на месте» (`cash`) его нет. Уникальность на nullable-поле в SQLite позволяет много NULL — теряется смысл. Гарантию «не обработать один вебхук дважды» даёт прикладная проверка статуса перед сменой `pending → paid`.

### 8.12. Контакты студии — таблица `studio_info` или захардкод в разметке?

**Варианты:** (а) оставить адрес/телефон/Telegram статикой в `index.html` и `success.html` (как сейчас в прототипе); (б) таблица `studio_info`.

**Выбор:** (б). Контакты отображаются на трёх местах (лендинг `#about`, футер, «Как нас найти» на `success.html`), и они регулярно меняются (переезд, новый телефон, другой аккаунт Telegram). Дублирование одной строки в трёх HTML приводит к тому, что правят её в одном экране и забывают в другом. Хранение в `studio_info` делает контакты данными (как услуги/мастера): одна таблица, один источник, редактирование из админки. Таблица выполнена «на одну строку» — это сознательное упрощение: студия одна, мультизагрузк (несколько студий) в продукте не планируется.

### 8.13. Полное закрытие студии — отдельная `studio_closures` вместо заполнения `work_blocks` у каждого мастера

**Варианты:** (а) при празднике заводить `work_blocks` для каждого мастера отдельно; (б) таблица `studio_closures` на уровне студии.

**Выбор:** (б). Вариант (а) дублирует одну и ту же дату на число мастеров, требует обхода всех активных мастеров и легко «забывает» о новом мастере, принятом позже. `studio_closures` — одна строка на закрытие, применяется ко всем автоматически, при приёме нового мастера ничего дополнительно заводить не нужно. Минус — ещё одна сущность в схеме и один лишний подзапрос в вычислении слотов; оно того стоит, потому что сохраняет вычисление слотов полным и не зависимым от кода («закрыт ли день целиком»).

### 8.14. `studio_closures.reason` — свой набор значений или общий с `work_blocks`?

**Варианты:** (а) один общий enum для всех причин закрытия времени; (б) отдельный набор для блокировок мастера и отдельный для закрытия студии.

**Выбор:** (б). Смысл причин разный: у мастера это «обед, перенёс, отпуск, болеет», у студии — «праздник, санитарный день». Здесь пересекается только «sick/other». Один общий enum заставил бы либо сузить список одного до другого, либо держать «мертвые» значения в чужом контексте (что приведёт к невозможности сказать «санитарный день мастера»). Раздельные CHECK-наборы точны и не дают осмысленно ввести неверную причину.

### 8.15. Удержание слота — отдельная таблица `slot_holds`, не поле в `bookings`

**Варианты:** (а) добавлять запись в `bookings` со статусом «удержана» сразу при выборе слота; (б) отдельная таблица `slot_holds`, а в `bookings` запись появляется только при подтверждении.

**Выбор:** (б). Вариант (а) засоряет главную таблицу записей «полу-записями»: их придётся исключать из всех списков, отчётов и счётчиков «активные записи», а заброшенные удержания путали бы владельца. `slot_holds` отделена: удержание — временное состояние с фиксированным сроком жизни (`expires_at`), после истечения оно просто удаляется фоновой чисткой, никогда не показываясь как запись. Переход «удержание → запись» атомарен (в одной транзакции: пометить hold `used` + вставить `bookings`) — это исключает гонку, когда два запроса с одним токеном создают две записи.

### 8.16. Токен удержания — хранить хеш, не сам токен

**Варианты:** (а) хранить `token` открытым текстом; (б) хранить `token_hash` (SHA-256), выдавать токен клиенту один раз.

**Выбор:** (б). Токен — это фактически ключ к слоту: если база утечёт, открытые токены позволят снимать чужие удержания. Хранится только хеш; токен возвращается клиенту в ответе `POST /holds` и больше нигде не сохраняется, при создании записи хешируется повторно для сравнения. SHA-256 достаточно, поскольку токен — 24 случайных байта (энтропия 192 бита), перебирать такой хеш бессмысленно.

### 8.17. Привязка клиента к аккаунту входа — `clients.user_id`

**Варианты:** (а) не связывать `clients` и `users` совсем; (б) добавить `user_id` в `clients`.

**Выбор:** (б) — сделано миграцией 003. Клиент регистрируется (получает `users` с ролью `client`) и должен быть связан со своим профилем `clients`, чтобы «Мои записи» и создание записи работали от лица конкретного клиента. Поле nullable: клиенты, пришедшие из Telegram-бота без входа в панель, аккаунта не имеют. UNIQUE гарантирует «один аккаунт = один профиль».

### 8.18. Осознанное наложение — записи администратора поверх занятого времени

**Варианты:** (а) совсем не разрешать пересечений — только UNIQUE+триггеры; (б) признак `force_override` у записи, который выставляет только роль `owner`.

**Выбор:** (б) — миграция 005. Бывают клиенты, которых администратор обязан вписать в расписание, даже если всё занято (срочный визит, важный клиент, запись по договорённости из офлайн/телефона). Для этого у `bookings` появляется `force_override` (0/1).

Ключевые правила:

1. **Выставить признак может только `owner`.** В `POST /bookings` значение из тела читается только при `req.user.role === 'owner'` (`bookings.js`). `client` и `master` могут передать хоть `force_override=true` в запросе — сервер просто не читает поле: признак останется `0`, запись пройдёт обычную проверку свободных слотов и пересечений. Игнорирование (а не ошибка) выбрано намеренно: клиент не получает подсказки о существовании административной возможности.
2. **Триггер пропускает записи с признаком.** `WHEN NEW.status != 'canceled' AND NEW.force_override = 0` — пересечение других записей мастера для такой записи не проверяется ни при INSERT, ни при UPDATE.
3. **Частичный UNIQUE-индекс тоже пропускает их.** `idx_bookings_active_start` построен с `WHERE status != 'canceled' AND force_override = 0`, чтобы запись с признаком могла совпасть даже по точному времени начала.
4. **Созданная поверх запись дальше ведёт себя как обычная.** В подзапросах обоих триггеров её не исключают: любой другой кандидат пересекаться с ней не сможет. «Поверх» — ок, «рядом поверх» — нет.
5. **Снять признак с пересекающей записи нельзя.** UPDATE «снимает» `force_override → 0` — теперь `WHEN` снова активен, пересечение находится, RAISE — транзакция откатывается, «легализовать» наложение задним числом нельзя.

Администратор создаёт запись поверх: `POST /bookings` с `client_id` (кто записывается), `force_override: true`. Клиент и мастер этого сделать не могут — значение игнорируется.

Все три роли создают запись через единую функцию `createBooking` (`POST /bookings`): `client` — на себя, `owner`/`master` — на клиента из `client_id` (+ `force_override` только у `owner`). Мастер (роль) — только в свой график: `master_id` обязан совпасть с `users.master_id` его аккаунта. Второго пути вставки в `bookings` в рантайме нет — `seed.js` тоже ходит через `createBooking`.

Сценарии этих ролей, перенос и отмена покрыты автотестом `backend/tests/test_role_scenarios.py` (реальные миграции 001–005, ожидается «23 OK, 0 FAIL»); для 5xx центральный обработчик `app.js` отдаёт общий текст, без деталей БД/триггеров.