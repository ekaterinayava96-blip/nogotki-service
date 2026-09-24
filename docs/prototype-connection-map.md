# Карта связей прототипа «Ноготочки»

Сопоставление экранов кликабельного прототипа (`prototype/`) с источниками данных и таблицами БД (`db-schema.md`). Карта используется как основа для схемы БД: каждый экран перечисляет данные, которые обязан отдавать backend.

---

## 1. Структура прототипа

| Файл | Назначение |
|---|---|
| `index.html` | Лендинг: каталог услуг, мастера, «О студии» с контактами и графиком |
| `booking.html` | Запись: пошаговый флоу «Услуга → Мастер → Дата → Время → Контакты» |
| `success.html` | Подтверждение записи («к оплате», сводка, контакты студии) |
| `appointments.html` | «Мои записи»: список записей клиента + кнопка отмены |
| `admin.html` | Панель: дашборд, заявки, таблица мастеров, недельное расписание |
| `app.js` | Демо-данные и вся логика (рендер всех экранов, localStorage) |
| `style.css`, `assets/*` | Оформление и SVG-фото |

---

## 2. Экраны → данные → таблицы БД

| Экран / блок (`id`) | Что показывает | Источник в прототипе | Таблица БД (поле) |
|---|---|---|---|
| **`index.html#catalogGrid`** — каталог услуг | Название, описание, цена, длительность, фото | `SERVICES` | `services` (name, description, price_kopecks, duration_minutes, photo_path) |
| **`index.html#mastersGrid`** — мастера | Фото, имя, роль, опыт | `MASTERS` | `masters` (name, role, experience_years, photo_path) |
| **`index.html#about`** + футер | Адрес, телефон, Telegram, график работы студии | статика в HTML | `studio_info` (studio_name, address, phone, telegram); график — из `master_schedule` |
| **`booking.html#serviceList`** — шаг 1 «Услуга» | Список услуг с ценами (клик → выбор) | `SERVICES` | `services` |
| **`booking.html#masterList`** — шаг 2 «Мастер» | Только мастера, умеющие выбранную услугу (`m.services.includes(svc.id)`) | `MASTERS` + `services[]` | `master_services` (связь) + `masters` |
| **`booking.html#calendar`** — шаг 3 «Дата» | Рабочие дни (вт–сб), запрет прошедших дней, «загруженность» | `WORK_DAYS`, `DEMO_BUSY` | `master_schedule` (weekday) + `bookings` + `work_blocks` + `studio_closures` (расчёт свободного времени) |
| **`booking.html#slotList`** — шаг 4 «Время» | Часовые слоты 10:00–20:00; занятые/перерыв отключены | `WORK_START..END`, `DEMO_BUSY`, `DEMO_PAUSED` | свободные слоты = график − записи − блоки − закрытия |
| **`booking.html#step-contacts`** — шаг 5 «Контакты» | Имя, телефон (маска `+7 (...)`) | формы | вводимые поля → `clients`, `bookings` |
| **`booking.html#sum*`** — резюме | Выбранные услуга, мастер, дата/время, цена | `bookingDraft` | `bookings` (+ цена через JOIN `services`) |
| **`success.html#successSummary`** | Сводка записи, «к оплате», статус «ждём подтверждения» | `localStorage.nogt_last` | `bookings`; контакты студии — `studio_info` |
| **`appointments.html#appointmentsList`** | Записи клиента: услуга, дата/время, мастер, цена, статус; отмена | `localStorage.nogt_bookings` | `bookings` по `client_id` |
| **`admin.html#statCounts`** — дашборд | Всего записей, активные, «на сумму», число мастеров | считает из `bookings` | `bookings`, `masters`, `services` (выручка = JOIN цены) |
| **`admin.html#requestsBody`** — заявки | Услуга, мастер, клиент (имя/телефон), дата/время, сумма, статус | из `bookings` | `bookings` + `masters` + `services` + `clients` |
| **`admin.html#mastersTableBody`** — мастера | ФИО, специализация, опыт, список услуг | `MASTERS` + `SERVICES` | `masters`, `master_services`, `services` |
| **`admin.html#scheduleWeek`** — расписание | Неделя: приёмы клиентов и перерывы | демо-строки в `renderAdmin()` | `bookings`, `work_blocks` (+ `master_schedule` для «окна работы») |

**Вне прототипа** (нужно по product knowledge, заложено в схему):

| Функция | Таблица БД |
|---|---|
| Вход в панель (логин/пароль, только хеш) | `users` |
| Оплата/предоплата через ЮKassa | `payments` |

---

## 3. Демо-данные прототипа → содержимое БД

| Данные в `app.js` | Как нормируются в БД |
|---|---|
| `SERVICES` (6 услуг, цена в рублях, длительность текстом) | `services`: цена в копейках (`price_kopecks` = 1800 → 180000), `duration_minutes` числом |
| `MASTERS` (3 мастера, `services: [...]` — какие умеет) | `masters` + связь `master_services` |
| `WORK_DAYS = [2,3,4,5,6]`, `WORK_START=10`, `WORK_END=20` | `master_schedule` (строки по мастеру и дню недели) |
| `DEMO_BUSY` (занятые часы) | `bookings` (начало записи) |
| `DEMO_PAUSED` (перерывы) | `work_blocks` |
| фото мастеров/услуг, загружаемые юзером | `masters.photo_path`, `services.photo_path` |
| `localStorage.nogt_bookings` (черновик записи с именем/телефоном прямо в записи) | нормализовано: `clients` + `bookings` (из прототипа имя/телефон вынесены в `clients` — привязка по `client_id`) |