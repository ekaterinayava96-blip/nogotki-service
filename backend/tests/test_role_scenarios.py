# -*- coding: utf-8 -*-
"""Тестирование сценариев: единая функция создания записи для трёх ролей
(client/master/owner), перенос (moveBooking) и отмена (setBookingStatus).

Применяются РЕАЛЬНЫЕ файлы миграций 001-005 из backend/src/db/migrations
(как их применяет runMigrations.js), затем минимальные данные, затем
бизнес-логика POST /bookings (bookings.js) для каждой роли и операции
по переносу/отмене. Проверка — на уровне SQL-семантики (триггеры,
частичный UNIQUE, force_override).

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

cur.execute("INSERT INTO masters (name, role, experience_years, created_at) VALUES ('Екатерина','Мастер маникюра',5, datetime('now'))")
ek = cur.lastrowid
cur.execute("INSERT INTO masters (name, role, experience_years, created_at) VALUES ('Анна','Мастер педикюра',3, datetime('now'))")
anna = cur.lastrowid

for m in (ek, anna):
    cur.execute("INSERT INTO master_services (master_id, service_id) VALUES (?,?)", (m, service_id))
cur.execute("INSERT INTO master_services (master_id, service_id) VALUES (?,?)", (anna, service2_id))

# график пн-сб 09:00-18:00
for m in (ek, anna):
    for wd in range(1, 7):
        cur.execute("INSERT INTO master_schedule (master_id, weekday, start_minutes, end_minutes) VALUES (?,?,540,1080)", (m, wd))

# владелец (owner, без мастера)
cur.execute("INSERT INTO users (username, password_hash, role, is_active) VALUES ('admin','x','owner',1)")
owner_id = cur.lastrowid
# мастер (роль master, привязан к Екатерине)
cur.execute("INSERT INTO users (username, password_hash, master_id, role, is_active) VALUES ('ekaterina','x',?,'master',1)", (ek,))
master_user_id = cur.lastrowid
# клиент
cur.execute("INSERT INTO users (username, password_hash, role, is_active) VALUES ('olga','x','client',1)")
client_user_id = cur.lastrowid
cur.execute("INSERT INTO clients (name, phone, user_id, created_at) VALUES ('Ольга','+79000000001',?, datetime('now'))", (client_user_id,))
olga = cur.lastrowid
cur.execute("INSERT INTO clients (name, phone, created_at) VALUES ('Маша','+79000000002', datetime('now'))")
masha = cur.lastrowid
conn.commit()

# ---- 3. Эквиваленты repo-функций ----
CONFLICT = "BOOKING_TIME_CONFLICT"

def create_booking(client_id, service_id, master_id, starts, ends, comment=None, force_override=0, status="wait"):
    """Прямой аналог q.createBooking (тот же INSERT)."""
    cur.execute(
        """INSERT INTO bookings (client_id, service_id, master_id, starts_at, ends_at,
           status, comment, source, force_override, created_at)
           VALUES (?,?,?,?,?,?,?, 'web', ?, datetime('now'))""",
        (client_id, service_id, master_id, starts, ends, status, comment, force_override),
    )
    return cur.lastrowid

def move_booking(booking_id, starts, ends):
    cur.execute("UPDATE bookings SET starts_at=?, ends_at=?, updated_at=datetime('now') WHERE id=?", (starts, ends, booking_id))

def set_status(booking_id, status):
    cur.execute("UPDATE bookings SET status=?, updated_at=datetime('now') WHERE id=?", (status, booking_id))

# ---- 4. Эмуляция ролевой логики POST /bookings (bookings.js) ----
def api_create_bookings(role, body):
    """Возвращает (ok, booking_id|code, payload). body как в API."""
    service_id = body["service_id"]
    master_id = body["master_id"]
    cid_field = body.get("client_id")
    want_force = body.get("force_override")
    force_override = 1 if (role == "owner" and want_force) else 0

    # service active
    row = cur.execute("SELECT * FROM services WHERE id=? ", (service_id,)).fetchone()
    if not row or row["is_active"] != 1:
        return (False, "UNKNOWN_SERVICE", None)
    master = cur.execute("SELECT * FROM masters WHERE id=?", (master_id,)).fetchone()
    if not master or master["is_active"] != 1:
        return (False, "UNKNOWN_MASTER", None)
    link = cur.execute("SELECT 1 FROM master_services WHERE master_id=? AND service_id=?", (master_id, service_id)).fetchone()
    if not link:
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

    duration = row["duration_minutes"]
    from datetime import datetime, timedelta
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
        bid = create_booking(client_id, service_id, master_id, starts_str, ends,
                             comment=body.get("comment"), force_override=force_override)
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

conn.close()
print(f"\nИТОГ: {PASS} OK, {FAIL} FAIL")
sys.exit(1 if FAIL else 0)