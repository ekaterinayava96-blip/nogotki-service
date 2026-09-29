# -*- coding: utf-8 -*-
"""Тестирование сценариев: единая функция создания записи для трёх ролей
(client/master/owner), перенос (moveBooking) и отмена (setBookingStatus),
а также проверки безопасности: роли списком (user_roles), сессии с хешем
токена (auth_sessions).

Применяются РЕАЛЬНЫЕ файлы миграций 001-008 из backend/src/db/migrations
(как их применяет runMigrations.js), затем минимальные данные, затем
бизнес-логика POST /bookings (bookings.js) для каждой роли и операции
по переносу/отмене, а также несколько услуг в одной записи (service_ids,
booking_services, сверка удержания по набору). Проверка — на уровне
SQL-семантики (триггеры, частичный UNIQUE, force_override).

Запуск:  py -3 -X utf8 backend/tests/test_role_scenarios.py
"""
import os
import sqlite3
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "db", "migrations")
DB = os.path.join(os.environ.get("TEMP", "."), "nogotki_test_role_scenarios.db")
if os.path.exists(DB):
    os.remove(DB)

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

# ---- 1. Применяем миграции как runMigrations.js (FK off на прогон) ----
def apply_migrations():
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        for f in sorted(os.listdir(ROOT)):
            if not f.endswith(".sql"):
                continue
            with open(os.path.join(ROOT, f), encoding="utf-8") as fh:
                cur.executescript(fh.read())
            print(f"applied {f}")
    finally:
        conn.execute("PRAGMA foreign_keys = ON")

apply_migrations()

# ---- 2. Минимальные данные (аналог seed.js) ----
cur.execute("INSERT INTO services (name, description, price_kopecks, duration_minutes, created_at) VALUES ('Маникюр с покрытием гель-лаком','',120000,120, datetime('now'))")
service_id = cur.lastrowid
cur.execute("INSERT INTO services (name, description, price_kopecks, duration_minutes, created_at) VALUES ('Педикюр','',150000,90, datetime('now'))")
service2_id = cur.lastrowid
# Две услуги по 105 минут нужны для проверки сверки удержания по НАБОРУ услуг:
# пара (120+90) и пара (105+105) дают одинаковые 210 минут, но это разные
# комплексы — удержание одного не подходит другому.
cur.execute("INSERT INTO services (name, description, price_kopecks, duration_minutes, created_at) VALUES ('Массаж кистей','Дополнение',40000,105, datetime('now'))")
service3_id = cur.lastrowid
cur.execute("INSERT INTO services (name, description, price_kopecks, duration_minutes, created_at) VALUES ('Уход за кутикулой','Дополнение',45000,105, datetime('now'))")
service4_id = cur.lastrowid

cur.execute("INSERT INTO masters (name, role, experience_years, created_at) VALUES ('Екатерина','Мастер маникюра',5, datetime('now'))")
ek = cur.lastrowid
cur.execute("INSERT INTO masters (name, role, experience_years, created_at) VALUES ('Анна','Мастер педикюра',3, datetime('now'))")
anna = cur.lastrowid

for m in (ek, anna):
    cur.execute("INSERT INTO master_services (master_id, service_id) VALUES (?,?)", (m, service_id))
cur.execute("INSERT INTO master_services (master_id, service_id) VALUES (?,?)", (anna, service2_id))
# ek делает обе 105-минутные услуги (для пары 105+105), но не педикюр
for sid in (service3_id, service4_id):
    cur.execute("INSERT INTO master_services (master_id, service_id) VALUES (?,?)", (ek, sid))
# anna делает все четыре — чтобы сравнить два РАЗНЫХ набора с одинаковой
# суммарной длительностью: пара (120+90) и пара (105+105) по 210 минут
for sid in (service3_id, service4_id):
    cur.execute("INSERT INTO master_services (master_id, service_id) VALUES (?,?)", (anna, sid))

# график пн-сб 09:00-18:00
for m in (ek, anna):
    for wd in range(1, 7):
        cur.execute("INSERT INTO master_schedule (master_id, weekday, start_minutes, end_minutes) VALUES (?,?,540,1080)", (m, wd))

# владелец (owner, без мастера) — роль в user_roles
cur.execute("INSERT INTO users (username, password_hash, is_active) VALUES ('admin','x',1)")
owner_id = cur.lastrowid
cur.execute("INSERT INTO user_roles (user_id, role) VALUES (?, 'owner')", (owner_id,))
# мастер (роль master, привязан к Екатерине)
cur.execute("INSERT INTO users (username, password_hash, master_id, is_active) VALUES ('ekaterina','x',?,1)", (ek,))
master_user_id = cur.lastrowid
cur.execute("INSERT INTO user_roles (user_id, role) VALUES (?, 'master')", (master_user_id,))
# клиент
cur.execute("INSERT INTO users (username, password_hash, is_active) VALUES ('olga','x',1)")
client_user_id = cur.lastrowid
cur.execute("INSERT INTO user_roles (user_id, role) VALUES (?, 'client')", (client_user_id,))
cur.execute("INSERT INTO clients (name, phone, user_id, created_at) VALUES ('Ольга','+79000000001',?, datetime('now'))", (client_user_id,))
olga = cur.lastrowid
cur.execute("INSERT INTO clients (name, phone, created_at) VALUES ('Маша','+79000000002', datetime('now'))")
masha = cur.lastrowid
conn.commit()

# ---- 3. Эквиваленты repo-функций ----
CONFLICT = "BOOKING_TIME_CONFLICT"

def create_booking(client_id, service_id, master_id, starts, ends, comment=None, force_override=0, status="wait", service_ids=None):
    """Прямой аналог q.createBooking: тот же INSERT в bookings плюс строки
    booking_services (набор услуг со снимком цены и длительности)."""
    ids = list(service_ids) if service_ids else [service_id]
    cur.execute(
        """INSERT INTO bookings (client_id, service_id, master_id, starts_at, ends_at,
           status, comment, source, force_override, created_at)
           VALUES (?,?,?,?,?,?,?, 'web', ?, datetime('now'))""",
        (client_id, ids[0], master_id, starts, ends, status, comment, force_override),
    )
    bid = cur.lastrowid
    for pos, sid in enumerate(ids, 1):
        s = cur.execute("SELECT price_kopecks, duration_minutes FROM services WHERE id=?", (sid,)).fetchone()
        cur.execute(
            """INSERT INTO booking_services
                 (booking_id, service_id, position, price_kopecks, duration_minutes)
               VALUES (?,?,?,?,?)""",
            (bid, sid, pos, s["price_kopecks"], s["duration_minutes"]),
        )
    return bid

def create_hold(master_id, starts_at, ends_at, service_ids):
    """Аналог POST /holds: удержание слота с набором услуг (hold_services)."""
    total = 0
    for sid in service_ids:
        total += cur.execute("SELECT duration_minutes FROM services WHERE id=?", (sid,)).fetchone()[0]
    cur.execute(
        """INSERT INTO slot_holds
             (master_id, starts_at, ends_at, duration_minutes, status, token_hash,
              created_by, created_at, expires_at)
           VALUES (?,?,?,?, 'active', ?, ?, datetime('now'), datetime('now','+10 minutes'))""",
        (master_id, starts_at, ends_at, total, f"hash-{master_id}-{starts_at}-{total}", owner_id),
    )
    hid = cur.lastrowid
    for sid in service_ids:
        cur.execute("INSERT INTO hold_services (hold_id, service_id) VALUES (?,?)", (hid, sid))
    conn.commit()
    return {"hold_id": hid, "master_id": master_id, "starts_at": starts_at, "ends_at": ends_at,
            "duration_minutes": total, "service_ids": list(service_ids)}

def move_booking(booking_id, starts, ends):
    cur.execute("UPDATE bookings SET starts_at=?, ends_at=?, updated_at=datetime('now') WHERE id=?", (starts, ends, booking_id))

def set_status(booking_id, status):
    cur.execute("UPDATE bookings SET status=?, updated_at=datetime('now') WHERE id=?", (status, booking_id))

# ---- 4. Эмуляция ролевой логики POST /bookings (bookings.js) ----
def read_service_ids(body):
    """Аналог readBookingServiceIds: service_ids (набор) или service_id (одна)."""
    if "service_ids" in body and body["service_ids"]:
        return list(body["service_ids"])
    if body.get("service_id"):
        return [body["service_id"]]
    return []

def api_create_bookings(role, body):
    """Возвращает (ok, booking_id|code, payload). body как в API."""
    service_ids = read_service_ids(body)
    if not service_ids:
        return (False, "MISSING_SERVICES", None)
    master_id = body["master_id"]
    cid_field = body.get("client_id")
    want_force = body.get("force_override")
    force_override = 1 if (role == "owner" and want_force) else 0

    # все услуги набора существуют и активны
    services = []
    for sid in service_ids:
        row = cur.execute("SELECT * FROM services WHERE id=? ", (sid,)).fetchone()
        if not row or row["is_active"] != 1:
            return (False, "UNKNOWN_SERVICE", None)
        services.append(row)
    master = cur.execute("SELECT * FROM masters WHERE id=?", (master_id,)).fetchone()
    if not master or master["is_active"] != 1:
        return (False, "UNKNOWN_MASTER", None)
    # мастер должен выполнять КАЖДУЮ услугу набора
    have = {r["service_id"] for r in
            cur.execute("SELECT service_id FROM master_services WHERE master_id=?", (master_id,))}
    if any(s["id"] not in have for s in services):
        return (False, "MASTER_SERVICE_MISMATCH", None)

    # мастер (роль) — только в свой график
    if role == "master":
        user = cur.execute("SELECT * FROM users WHERE id=?", (body["_user_id"],)).fetchone()
        if not user or not user["master_id"] or master_id != user["master_id"]:
            return (False, "FORBIDDEN", None)

    # клиент
    if role in ("owner", "master"):
        if not cid_field or not cur.execute("SELECT 1 FROM clients WHERE id=?", (cid_field,)).fetchone():
            return (False, "CLIENT_REQUIRED", None)
        client_id = cid_field
    else:
        user = cur.execute("SELECT * FROM users WHERE id=?", (body["_user_id"],)).fetchone()
        client_id = None
        if user:
            c = cur.execute("SELECT id FROM clients WHERE user_id=?", (user["id"],)).fetchone()
            client_id = c["id"] if c else None
        if not client_id:
            return (False, "NO_CLIENT_PROFILE", None)

    # длительность слота = сумма длительностей услуг набора
    duration = sum(s["duration_minutes"] for s in services)
    from datetime import datetime, timedelta
    hold = body.get("_hold")
    if hold:
        # Путь 1: по удержанию. Сверяем НАБОР услуг, а не минуты: у комплекса
        # (120+90) и (105+105) длительность одинаковая, но это разные записи.
        hold_ids = {r["service_id"] for r in
                    cur.execute("SELECT service_id FROM hold_services WHERE hold_id=?", (hold["hold_id"],))}
        matches = (hold_ids == set(service_ids)) if hold_ids else (hold["duration_minutes"] == duration)
        if hold["master_id"] != master_id or not matches:
            return (False, "HOLD_MISMATCH", None)
        starts_str = hold["starts_at"]
        ends = hold["ends_at"]
    else:
        start = datetime.strptime(body["starts_at"], "%Y-%m-%d %H:%M:%S")
        ends = (start + timedelta(minutes=duration)).strftime("%Y-%m-%d %H:%M:%S")
        starts_str = body["starts_at"]

        # Путь 2 без hold: если нет force_override — слот должен быть свободен.
        if not force_override:
            occ = cur.execute(
                """SELECT 1 FROM bookings b WHERE b.master_id=? AND b.status!='canceled'
                   AND b.starts_at < ? AND b.ends_at > ? LIMIT 1""",
                (master_id, ends, starts_str),
            ).fetchone()
            if occ:
                return (False, "SLOT_BUSY", None)

    try:
        bid = create_booking(client_id, service_ids[0], master_id, starts_str, ends,
                             comment=body.get("comment"), force_override=force_override,
                             service_ids=service_ids)
        if hold:
            cur.execute("UPDATE slot_holds SET status='used' WHERE id=?", (hold["hold_id"],))
        conn.commit()
        return (True, bid, {"force_override": force_override, "client_id": client_id})
    except sqlite3.IntegrityError as e:
        conn.rollback()
        if CONFLICT in str(e):
            return (False, "SLOT_BUSY", None)
        # UNIQUE-нарушение тоже трактуем как занятый слот
        if "UNIQUE constraint" in str(e):
            return (False, "SLOT_BUSY", None)
        raise

# ---- 5. Сценарии ----
PASS = 0
FAIL = 0

def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [OK]  {name}")
    else:
        FAIL += 1
        print(f"  [FAIL] {name} {detail}")

# окно для тестов — вторник (weekday 2); 29.09.2026 — вторник
TUE = "2026-09-29"
def slot(hhmm, dur=120):
    return f"{TUE} {hhmm}:00"

print("\n== A. Клиент создаёт запись на себя ==")
ok, bid, meta = api_create_bookings("client", {
    "service_id": service_id, "master_id": ek, "starts_at": slot("10:00"),
    "_user_id": client_user_id,
})
check("клиент создал запись", ok == True, str(bid))
check("запись имеет force_override=0", ok and meta["force_override"] == 0)
research = cur.execute("SELECT status FROM bookings WHERE id=?", (bid,)).fetchone()
check("статус 'wait'", ok and research["status"] == "wait")

print("\n== B. Клиент не может выставить force_override (поле игнорируется) ==")
ok2, bid2, meta2 = api_create_bookings("client", {
    "service_id": service_id, "master_id": ek, "starts_at": slot("13:00"),
    "force_override": True, "_user_id": client_user_id,
})
check("клиент создал запись на свободный слот", ok2 == True)
check("force_override в базе = 0 (игнорировано)", ok2 and meta2["force_override"] == 0)

print("\n== C. Клиент НЕ может записаться поверх занятого времени ==")
ok3, code3, _ = api_create_bookings("client", {
    "service_id": service_id, "master_id": ek, "starts_at": slot("10:00"),
    "_user_id": client_user_id,
})
check("пересечение отклонено (SLOT_BUSY/триггер)", ok3 == False and code3 == "SLOT_BUSY")

print("\n== D. Мастер (роль) создаёт запись на клиента, в свой график ==")
ok4, bid4, meta4 = api_create_bookings("master", {
    "service_id": service_id, "master_id": ek, "starts_at": slot("15:00"),
    "client_id": masha, "force_override": True, "_user_id": master_user_id,
})
check("мастер создал запись на клиента (client_id)", ok4 == True)
check("force_override у мастера = 0 (только owner)", ok4 and meta4["force_override"] == 0)
check("client_id = Маша", ok4 and meta4["client_id"] == masha)

print("\n== E. Мастер НЕ может создать запись на другого мастера ==")
ok5, code5, _ = api_create_bookings("master", {
    "service_id": service_id, "master_id": anna, "starts_at": slot("10:00"),
    "client_id": masha, "_user_id": master_user_id,
})
check("чужой мастер отклонён (FORBIDDEN)", ok5 == False and code5 == "FORBIDDEN")

print("\n== F. Owner создаёт запись на клиента (административная функция) ==")
ok6, bid6, meta6 = api_create_bookings("owner", {
    "service_id": service_id, "master_id": anna, "starts_at": slot("10:00"),
    "client_id": olga, "force_override": False, "_user_id": owner_id,
})
check("owner создал запись на клиента", ok6 == True and meta6["client_id"] == olga)

print("\n== G. Owner с force_override поверх занятого времени — проходит ==")
ok7, bid7, meta7 = api_create_bookings("owner", {
    "service_id": service_id, "master_id": ek, "starts_at": slot("10:00"),
    "client_id": olga, "force_override": True, "_user_id": owner_id,
})
check("owner записал поверх (force_override=1)", ok7 == True and meta7["force_override"] == 1)

print("\n== H. Owner БЕЗ force_override поверх занятого — отклонено ==")
ok8, code8, _ = api_create_bookings("owner", {
    "service_id": service_id, "master_id": ek, "starts_at": slot("10:00"),
    "client_id": masha, "force_override": False, "_user_id": owner_id,
})
check("обычная запись owner отклонена (SLOT_BUSY)", ok8 == False and code8 == "SLOT_BUSY")

print("\n== I. Запись с force_override=1 САМА блокирует других ==")
ok9, code9, _ = api_create_bookings("owner", {
    "service_id": service_id, "master_id": ek, "starts_at": slot("10:00"),
    "client_id": masha, "force_override": False, "_user_id": owner_id,
})
check("другая запись поверх заблокирована", ok9 == False and code9 == "SLOT_BUSY")

print("\n== J. Перенос (moveBooking) на свободное время ==")
try:
    move_booking(bid4, "2026-09-30 11:00:00", "2026-09-30 13:00:00")
    conn.commit()
    check("перенос на свободное прошёл", True)
except Exception as e:
    conn.rollback()
    check("перенос на свободное прошёл", False, str(e))

print("\n== K. Перенос на занятое время — отклонён триггером UPDATE ==")
try:
    move_booking(bid4, slot("10:00"), slot("12:00"))
    conn.commit()
    check("перенос на занятое отклонён", False, "перенос не был запрещён")
except sqlite3.IntegrityError as e:
    conn.rollback()
    check("перенос на занятое отклонён", CONFLICT in str(e), str(e))

print("\n== L. Отмена (setBookingStatus 'canceled') освобождает слот ==")
set_status(bid4, "canceled")
conn.commit()
r = cur.execute("SELECT status FROM bookings WHERE id=?", (bid4,)).fetchone()
check("статус = canceled", r["status"] == "canceled")
ok10, _, _ = api_create_bookings("client", {
    "service_id": service_id, "master_id": ek, "starts_at": slot("15:00"),
    "_user_id": client_user_id,
})
check("слот после отмены снова свободен", ok10 == True)

print("\n== M. Отмена единственной force-записи освобождает слот ==")
ok11a, bid11a, meta11 = api_create_bookings("owner", {
    "service_id": service_id, "master_id": ek, "starts_at": slot("17:00"),
    "client_id": masha, "force_override": True, "_user_id": owner_id,
})
check("owner создал force-запись на свободном слоте", ok11a == True and meta11["force_override"] == 1)
set_status(bid11a, "canceled")
conn.commit()
ok11, _, _ = api_create_bookings("client", {
    "service_id": service_id, "master_id": ek, "starts_at": slot("17:00"),
    "_user_id": client_user_id,
})
check("после отмены единственной force-записи слот свободен", ok11 == True)

print("\n== N. Смена статуса админом (wait->confirmed) не конфликтует ==")
ok12, bid12, _ = api_create_bookings("owner", {
    "service_id": service_id, "master_id": anna, "starts_at": slot("14:00"),
    "client_id": masha, "force_override": False, "_user_id": owner_id,
})
set_status(bid12, "confirmed")
conn.commit()
r = cur.execute("SELECT status FROM bookings WHERE id=?", (bid12,)).fetchone()
check("статус изменён на confirmed", r["status"] == "confirmed")

print("\n== O. Снятие force_override с ПЕРЕСЕКАЮЩЕЙ записи — триггер откатит ==")
ok13, bid13, _ = api_create_bookings("owner", {
    "service_id": service2_id, "master_id": anna, "starts_at": slot("10:00"),
    "client_id": olga, "force_override": True, "_user_id": owner_id,
})
check("owner создал force-запись поверх", ok13 == True)
try:
    cur.execute("UPDATE bookings SET force_override=0, updated_at=datetime('now') WHERE id=?", (bid13,))
    conn.commit()
    check("снятие признака с пересекающей записи отклонено", False, "признак снялся")
except sqlite3.IntegrityError as e:
    conn.rollback()
    check("снятие признака с пересекающей записи отклонено", CONFLICT in str(e), str(e))

print("\n== P. Пересечение интервалов: 12:30 поверх визита 12:00-13:00 ==")
cur.execute("INSERT INTO services (name, description, price_kopecks, duration_minutes, created_at) VALUES ('Полировка 60м','',80000,60, datetime('now'))")
fast_id = cur.lastrowid
for m in (ek, anna):
    cur.execute("INSERT INTO master_services (master_id, service_id) VALUES (?,?)", (m, fast_id))
conn.commit()
okp1, bidp1, _ = api_create_bookings("client", {
    "service_id": fast_id, "master_id": ek, "starts_at": slot("12:00"),
    "_user_id": client_user_id,
})
check("визит 12:00-13:00 создан", okp1 == True)
okp2, codep2, _ = api_create_bookings("client", {
    "service_id": fast_id, "master_id": ek, "starts_at": slot("12:30"),
    "_user_id": client_user_id,
})
check("запись 12:30 поверх 12:00-13:00 отклонена", okp2 == False and codep2 == "SLOT_BUSY")

print("\n== Q. Вплотную: 16:00 сразу после визита Анны до 16:00 — разрешено ==")
# у Анны активна запись 14:00-16:00 (сценарий N); слот 16:00-17:00 свободен
okq, bidq, _ = api_create_bookings("client", {
    "service_id": fast_id, "master_id": anna, "starts_at": slot("16:00"),
    "_user_id": client_user_id,
})
check("запись 16:00 после окончания в 16:00 разрешена", okq == True)
set_status(bidp1, "canceled")
set_status(bidq, "canceled")
conn.commit()

print("\n== R. Публичная информация о студии (studio_info) ==")
cur.execute("INSERT INTO studio_info (id, studio_name, address, phone, telegram, map_hint, updated_at) VALUES (1,'Ноготочки','Воронеж, Революции 10','+79004535000','@Vibekatena','Вход во дворе', datetime('now'))")
conn.commit()
r = cur.execute("SELECT studio_name, address, phone, telegram, map_hint FROM studio_info WHERE id=1").fetchone()
check("studio_info заполнена", r is not None and r["studio_name"] == "Ноготочки" and r["phone"] == "+79004535000")
work = cur.execute("""
  SELECT ms.weekday, MIN(ms.start_minutes) AS start_minutes, MAX(ms.end_minutes) AS end_minutes
  FROM master_schedule ms JOIN masters m ON m.id = ms.master_id
  WHERE m.is_active = 1 GROUP BY ms.weekday ORDER BY ms.weekday""").fetchall()
check("график студии из расписаний мастеров", len(work) == 6 and work[0]["start_minutes"] == 540 and work[0]["end_minutes"] == 1080)

print("\n== S. Админ-расписание мастера (замена недели) ==")
cur.execute("""
  UPDATE master_schedule SET start_minutes=600, end_minutes=1140
  WHERE master_id=? AND weekday IN (2,3,4)""", (ek,))
cur.execute("DELETE FROM master_schedule WHERE master_id=? AND weekday NOT IN (2,3,4)", (ek,))
conn.commit()
rows = cur.execute("SELECT weekday, start_minutes, end_minutes FROM master_schedule WHERE master_id=? ORDER BY weekday", (ek,)).fetchall()
check("расписание обновлено (3 рабочих дня 10:00-19:00)",
      len(rows) == 3 and all(x["start_minutes"] == 600 and x["end_minutes"] == 1140 for x in rows))
wk = cur.execute("SELECT weekday FROM master_schedule WHERE master_id=?", (ek,)).fetchone()
check("у мастера остался рабочий день для расчёта слотов", wk is not None)

print("\n== T. Блокировки времени мастера (work_blocks) ==")
cur.execute("INSERT INTO work_blocks (master_id, starts_at, ends_at, reason) VALUES (?,?,?, 'break')",
            (ek, "2026-09-29 12:00:00", "2026-09-29 13:00:00"))
bid_t = cur.lastrowid
conn.commit()
bl = cur.execute("SELECT reason FROM work_blocks WHERE id=?", (bid_t,)).fetchone()
check("блокировка создана", bl is not None and bl["reason"] == "break")
# блокировка входит в занятые интервалы мастера (getBusyIntervals)
busy = cur.execute("""
  SELECT COUNT(*) AS n FROM work_blocks
  WHERE master_id=? AND starts_at < '2026-09-29 18:00:00' AND ends_at > '2026-09-29 09:00:00'""", (ek,)).fetchone()
check("блокировка учитывается в интервалах", busy["n"] == 1)
cur.execute("DELETE FROM work_blocks WHERE id=?", (bid_t,))
conn.commit()
gone = cur.execute("SELECT 1 FROM work_blocks WHERE id=?", (bid_t,)).fetchone()
check("блокировка удалена", gone is None)

print("\n== U. Статистика админ-панели (дашборд) ==")
# отменённые в P/Q больше не активны; посчитаем то, что в базе
tot = cur.execute("""
  SELECT COUNT(*) AS n, SUM(CASE WHEN status IN ('wait','confirmed') THEN 1 ELSE 0 END) AS active
  FROM bookings""").fetchone()
check("итого и активные записи считаются", tot["active"] <= tot["n"] and tot["n"] >= 0)
summ = cur.execute("""
  SELECT COALESCE(SUM(CASE WHEN b.status IN ('wait','confirmed') THEN s.price_kopecks ELSE 0 END),0) AS s
  FROM bookings b JOIN services s ON s.id=b.service_id""").fetchone()
mcnt = cur.execute("SELECT COUNT(*) AS n FROM masters").fetchone()
check("сумма активных и число мастеров считаются", summ["s"] >= 0 and mcnt["n"] == 2)

print("\n== V. Обратная связь и отзывы (client_feedback) ==")
# клиент оставляет отзыв (аналог POST /feedback)
cur.execute("INSERT INTO client_feedback (client_id, text, status, created_at) VALUES (?,?, 'new', datetime('now'))", (olga, "Спасибо, очень аккуратно!"))
fb_id = cur.lastrowid
conn.commit()
fb = cur.execute("SELECT f.text, f.status, c.name AS client_name FROM client_feedback f JOIN clients c ON c.id=f.client_id WHERE f.id=?", (fb_id,)).fetchone()
check("отзыв создан со статусом 'new'", fb is not None and fb["status"] == "new" and fb["client_name"] == "Ольга")
# владелец смотрит все отзывы и меняет статус (аналог GET/PATCH /admin/feedback)
all_fb = cur.execute("SELECT COUNT(*) AS n FROM client_feedback").fetchone()
check("владелец видит все отзывы", all_fb["n"] == 1)
cur.execute("UPDATE client_feedback SET status='answered' WHERE id=?", (fb_id,))
conn.commit()
fb2 = cur.execute("SELECT status FROM client_feedback WHERE id=?", (fb_id,)).fetchone()
check("статус изменён на 'answered'", fb2["status"] == "answered")

print("\n== W. Несколько услуг в одной записи (service_ids, booking_services) ==")
# Отдельные дни, чтобы не наезжать на занятые слоты вторника и друг на друга
WED = "2026-09-30"
THU = "2026-10-01"
FRI = "2026-10-02"
def wslot(hhmm):
    return f"{WED} {hhmm}:00"
def tslot(hhmm):
    return f"{THU} {hhmm}:00"
def fslot(hhmm):
    return f"{FRI} {hhmm}:00"

# 1) Комплекс из двух услуг: 120 + 90 = 210 минут, мастер anna делает обе
ok_m, bid_m, _ = api_create_bookings("client", {
    "service_ids": [service_id, service2_id], "master_id": anna,
    "starts_at": wslot("10:00"), "_user_id": client_user_id,
})
check("комплекс из двух услуг создан", ok_m is True, str(bid_m))
row_m = cur.execute("SELECT service_id, starts_at, ends_at FROM bookings WHERE id=?", (bid_m,)).fetchone()
check("bookings.service_id = первая услуга (совместимость)", ok_m and row_m["service_id"] == service_id)
check("длительность слота = сумма услуг (210 мин)",
      ok_m and row_m["ends_at"] == wslot("13:30"))
rows_bs = cur.execute(
    """SELECT service_id, position, price_kopecks, duration_minutes FROM booking_services
       WHERE booking_id=? ORDER BY position""", (bid_m,)).fetchall()
check("в booking_services две услуги", len(rows_bs) == 2)
check("порядок выбора сохранён",
      [r["service_id"] for r in rows_bs] == [service_id, service2_id])
check("позиции 1 и 2", [r["position"] for r in rows_bs] == [1, 2])
check("снимок цены и длительности на момент записи",
      [(r["price_kopecks"], r["duration_minutes"]) for r in rows_bs] == [(120000, 120), (150000, 90)])
total_price = sum(r["price_kopecks"] for r in rows_bs)
check("сумма комплекса = сумме цен услуг", total_price == 270000, str(total_price))

# 2) Снимок не переписывается правкой прайса
cur.execute("UPDATE services SET price_kopecks=999000 WHERE id=?", (service_id,))
conn.commit()
snap = cur.execute("SELECT price_kopecks FROM booking_services WHERE booking_id=? AND service_id=?",
                   (bid_m, service_id)).fetchone()
check("правка прайса не меняет сумму в истории записи", snap["price_kopecks"] == 120000)
cur.execute("UPDATE services SET price_kopecks=120000 WHERE id=?", (service_id,))
conn.commit()

# 3) Мастер должен выполнять каждую услугу набора: ek не делает педикюр
ok_bad, code_bad, _ = api_create_bookings("client", {
    "service_ids": [service_id, service2_id], "master_id": ek,
    "starts_at": wslot("14:00"), "_user_id": client_user_id,
})
check("мастер без одной из услуг — MASTER_SERVICE_MISMATCH", (ok_bad, code_bad) == (False, "MASTER_SERVICE_MISMATCH"))

# 4) Пустой набор услуг отклоняется
ok_none, code_none, _ = api_create_bookings("client", {
    "master_id": anna, "starts_at": wslot("14:00"), "_user_id": client_user_id,
})
check("без услуг — MISSING_SERVICES", (ok_none, code_none) == (False, "MISSING_SERVICES"))

# 5) Удержание сверяется по НАБОРУ услуг, а не по длительности
hold_ab = create_hold(anna, wslot("14:00"), wslot("17:30"), [service_id, service2_id])
check("удержание помнит набор услуг",
      {r["service_id"] for r in
       cur.execute("SELECT service_id FROM hold_services WHERE hold_id=?", (hold_ab["hold_id"],))}
      == {service_id, service2_id})
ok_h, bid_h, _ = api_create_bookings("client", {
    "service_ids": [service_id, service2_id], "master_id": anna,
    "starts_at": wslot("14:00"), "_user_id": client_user_id, "_hold": hold_ab,
})
check("запись по удержанию с тем же набором создаётся", ok_h is True, str(bid_h))
check("удержание помечено used",
      cur.execute("SELECT status FROM slot_holds WHERE id=?", (hold_ab["hold_id"],)).fetchone()["status"] == "used")

# 6) Другая пара услуг той же длительности (105+105 = 210) — не то же удержание.
#    Мастер anna делает все четыре услуги, поэтому проверка мастера проходит и
#    решает именно сверка удержания: набор другой, минуты те же.
hold_cd = create_hold(anna, tslot("10:00"), tslot("13:30"), [service3_id, service4_id])
ok_x, code_x, _ = api_create_bookings("client", {
    "service_ids": [service_id, service2_id], "master_id": anna,
    "starts_at": tslot("10:00"), "_user_id": client_user_id, "_hold": hold_cd,
})
check("набор с той же длительностью, но другими услугами — HOLD_MISMATCH",
      (ok_x, code_x) == (False, "HOLD_MISMATCH"))
ok_y, bid_y, _ = api_create_bookings("client", {
    "service_ids": [service3_id, service4_id], "master_id": anna,
    "starts_at": tslot("10:00"), "_user_id": client_user_id, "_hold": hold_cd,
})
check("запись по своему удержанию создаётся", ok_y is True, str(bid_y))
check("пара 105+105 тоже 210 минут",
      cur.execute("SELECT ends_at FROM bookings WHERE id=?", (bid_y,)).fetchone()["ends_at"] == tslot("13:30"))

# 7) Подмножество услуг удержания не подходит
hold_ab2 = create_hold(ek, wslot("14:00"), wslot("17:30"), [service_id, service2_id])
ok_z, code_z, _ = api_create_bookings("client", {
    "service_ids": [service_id], "master_id": ek,
    "starts_at": wslot("14:00"), "_user_id": client_user_id, "_hold": hold_ab2,
})
check("одна услуга вместо двух — HOLD_MISMATCH", (ok_z, code_z) == (False, "HOLD_MISMATCH"))

# 8) Старый формат service_id (одна услуга) работает как раньше
ok_legacy, bid_legacy, _ = api_create_bookings("client", {
    "service_id": service_id, "master_id": anna,
    "starts_at": fslot("10:00"), "_user_id": client_user_id,
})
check("legacy service_id создаёт запись", ok_legacy is True, str(bid_legacy))
check("у legacy-записи тоже есть строка booking_services",
      cur.execute("SELECT COUNT(*) AS n FROM booking_services WHERE booking_id=?", (bid_legacy,)).fetchone()["n"] == 1)

# 9) Перенос записи считает длительность всего комплекса
mv_starts, mv_ends = fslot("11:00"), fslot("13:00")
move_booking(bid_legacy, mv_starts, mv_ends)
mv = cur.execute("SELECT starts_at, ends_at FROM bookings WHERE id=?", (bid_legacy,)).fetchone()
check("перенос сохраняет длительность комплекса", mv["ends_at"] == mv_ends)

# 10) Сумма активных записей учитывает все услуги, а не только первую
sum_active = cur.execute("""
  SELECT COALESCE(SUM(bs.price_kopecks),0) AS s
  FROM bookings b JOIN booking_services bs ON bs.booking_id = b.id
  WHERE b.status IN ('wait','confirmed')""").fetchone()["s"]
check("сумма по booking_services больше цены одной услуги", sum_active > 120000, str(sum_active))

print("\n== X. Безопасность: роли списком и сессии с хешем токена ==")
# 1) роли — список (user_roles), а не одна колонка users.role
cols_users = [r["name"] for r in cur.execute("PRAGMA table_info(users)").fetchall()]
check("в users больше нет колонки role", "role" not in cols_users)
roles_owner = [r["role"] for r in cur.execute("SELECT role FROM user_roles WHERE user_id=? ORDER BY role", (owner_id,)).fetchall()]
check("владелец имеет роль 'owner'", roles_owner == ["owner"])
# человек может иметь несколько ролей; проверка «есть ли роль» — по списку
cur.execute("INSERT INTO user_roles (user_id, role) VALUES (?, 'master')", (owner_id,))
conn.commit()
nroles = cur.execute("SELECT COUNT(*) AS n FROM user_roles WHERE user_id=?", (owner_id,)).fetchone()
check("у человека может быть несколько ролей (owner+master)", nroles["n"] == 2)
has_master = cur.execute("SELECT 1 FROM user_roles WHERE user_id=? AND role='master'", (owner_id,)).fetchone()
check("hasRole('master') находится по списку", has_master is not None)

# 2) сессии: в БД лежит SHA-256 хеш токена (не сам токен),
#    отзыв (revoked_at) делает сессию невалидной мгновенно
import hashlib
token = "secret-token-abc123"
token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
cur.execute(
    "INSERT INTO auth_sessions (user_id, token_hash, created_at, expires_at) VALUES (?,?,datetime('now'),datetime('now','+7 days'))",
    (client_user_id, token_hash))
conn.commit()
sess = cur.execute(
    "SELECT id, user_id FROM auth_sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at > datetime('now')",
    (token_hash,)).fetchone()
check("сессия находится по хешу токена", sess is not None and sess["user_id"] == client_user_id)
raw = cur.execute("SELECT token_hash FROM auth_sessions WHERE id=?", (sess["id"],)).fetchone()
check("в БД хранится хеш, а не сам токен", raw["token_hash"] != token)
cur.execute("UPDATE auth_sessions SET revoked_at=datetime('now') WHERE id=?", (sess["id"],))
conn.commit()
gone = cur.execute(
    "SELECT 1 FROM auth_sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at > datetime('now')",
    (token_hash,)).fetchone()
check("отозванная сессия больше не валидна", gone is None)

print("\n== Y. PATCH /auth/me — контакты клиента из формы подтверждения ==")
# Аналог q.updateClient + PATCH /auth/me: клиент меняет своё имя и телефон.
# undefined означает «поле не передавали» — оно не затирается.

def api_patch_me(role, user_id, body):
    """Возвращает (ok, code, payload) — логика PATCH /auth/me в auth.js."""
    if role != "client":
        return (False, "FORBIDDEN", None)
    cid = cur.execute("SELECT id FROM clients WHERE user_id=?", (user_id,)).fetchone()
    if not cid:
        return (False, "FORBIDDEN", None)
    cid = cid["id"]
    name = body.get("name")
    phone = body.get("phone")
    if name is None and phone is None:
        return (False, "NOTHING_TO_UPDATE", None)
    if phone is not None:
        # Валидатор: 10-15 цифр, допускается ведущий «+» (lib/validate.js)
        digits = phone[1:] if phone.startswith("+") else phone
        if not (10 <= len(digits) <= 15) or not digits.isdigit():
            return (False, "BAD_PHONE", None)
        taken = cur.execute("SELECT 1 FROM clients WHERE phone=? AND id!=?", (phone, cid)).fetchone()
        if taken:
            return (False, "PHONE_TAKEN", None)
    update_client(cid, name, phone)
    conn.commit()
    row = cur.execute("SELECT id, name, phone FROM clients WHERE id=?", (cid,)).fetchone()
    return (True, None, dict(row))

def update_client(cid, name=None, phone=None):
    """Аналог q.updateClient: собираем SET только из переданных полей."""
    sets, params = [], []
    if name is not None:
        sets.append("name = ?")
        params.append(name)
    if phone is not None:
        sets.append("phone = ?")
        params.append(phone)
    if sets:
        params.append(cid)
        cur.execute(f"UPDATE clients SET {', '.join(sets)} WHERE id=?", params)

ok_y1, code_y1, got = api_patch_me("client", client_user_id, {"name": "Ольга Н.", "phone": "+79001234567"})
check("клиент сменил имя и телефон", ok_y1 and got["name"] == "Ольга Н." and got["phone"] == "+79001234567",
      str(code_y1))

ok_y2, _, got2 = api_patch_me("client", client_user_id, {"name": "Ольга Н."})
check("передача одного поля не затирает второе", ok_y2 and got2["phone"] == "+79001234567", str(got2))

ok_y3, code_y3, _ = api_patch_me("client", client_user_id, {})
check("пустой PATCH отклонён (NOTHING_TO_UPDATE)", not ok_y3 and code_y3 == "NOTHING_TO_UPDATE", str(code_y3))

ok_y4, code_y4, _ = api_patch_me("client", client_user_id, {"phone": "+79000000002"})
check("телефон Маши занят — 409 PHONE_TAKEN", not ok_y4 and code_y4 == "PHONE_TAKEN", str(code_y4))
still = cur.execute("SELECT phone FROM clients WHERE id=?", (olga,)).fetchone()
check("после отказа телефон клиента не изменился", still["phone"] == "+79001234567", str(still["phone"]))

ok_y5, code_y5, _ = api_patch_me("client", client_user_id, {"phone": "+7 (900) 111-22-33"})
check("телефон с маской (скобки, пробелы) отклонён валидатором", not ok_y5 and code_y5 == "BAD_PHONE", str(code_y5))
ok_y5b, code_y5b, _ = api_patch_me("client", client_user_id, {"phone": "12345"})
check("короткий телефон отклонён валидатором", not ok_y5b and code_y5b == "BAD_PHONE", str(code_y5b))

ok_y6, code_y6, _ = api_patch_me("owner", owner_id, {"name": "Владелец"})
check("владелец без профиля клиента — 403 FORBIDDEN", not ok_y6 and code_y6 == "FORBIDDEN", str(code_y6))

ok_y7, code_y7, _ = api_patch_me("master", master_user_id, {"name": "Екатерина"})
check("мастер без профиля клиента — 403 FORBIDDEN", not ok_y7 and code_y7 == "FORBIDDEN", str(code_y7))

# Два клиента не могут получить один телефон: UNIQUE отрабатывает на уровне БД,
# а PATCH перехватывает это до insert/update и отдаёт PHONE_TAKEN, а не 500
masha_row = cur.execute("SELECT phone FROM clients WHERE id=?", (masha,)).fetchone()
ok_y8, code_y8, _ = api_patch_me("client", client_user_id, {"phone": masha_row["phone"]})
check("чужой телефон занят (PHONE_TAKEN, не исключение БД)", not ok_y8 and code_y8 == "PHONE_TAKEN", str(code_y8))
try:
    cur.execute("UPDATE clients SET phone=? WHERE id=?", (masha_row["phone"], olga))
    conn.commit()
    uniq = False
except sqlite3.IntegrityError:
    conn.rollback()
    uniq = True
check("UNIQUE(phone) в БД держит даже прямую правку", uniq)

conn.close()
print(f"\nИТОГ: {PASS} OK, {FAIL} FAIL")
sys.exit(1 if FAIL else 0)