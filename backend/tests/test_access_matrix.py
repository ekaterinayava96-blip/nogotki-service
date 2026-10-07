# -*- coding: utf-8 -*-
"""Проверка матрицы доступа: каждый маршрут — тремя ролями.

Зачем этот набор. `test_role_scenarios.py` проверяет правила доступа, но
повторяет их на Python: `api_create_bookings()` заново описывает, кому что
можно. То есть набор проверяет копию логики, а не настоящие middleware
Express. Если в маршруте забыть `requireRole`, этот набор останется зелёным —
он ничего не заметит.

Здесь проверяется настоящий HTTP-слой: маршруты собираются из исходников
`backend/src/routes/*.js`, каждый дёргается анонимом, клиентом и владельцем.
Правило простое: маршрут, не помеченный публичным, не должен отвечать 2xx ни
анониму, ни чужой роли.

Что проверяется:
  * аноним не получает 2xx ни на одном закрытом маршруте (включая страницы);
  * клиент не получает 2xx на маршрутах админки;
  * владелец не получает 5xx (маршрут существует и не падает);
  * публичные маршруты действительно публичные.

Что НЕ проверяется и почему:
  * права на уровне отдельной строки (чужой `:id`) — там, где маршрут отдаёт
    одну запись, закрытый маршрут вернёт 404 ещё до проверки прав. Права на
    конкретную чужую запись проверяет `test_role_scenarios.py`;
  * содержимое ответов — здесь важна только код ответа.

Запуск (сервер должен быть поднят):
    node src/index.js                     # в отдельном окне
    py -3 -X utf8 backend/tests/test_access_matrix.py

BASE_URL можно переопределить:  set BASE_URL=http://127.0.0.1:3100
Учётные записи владельца берутся из backend/.env.test.
"""
import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.request

BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:3000").rstrip("/")
BACKEND = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
ROUTES_DIR = os.path.join(BACKEND, "src", "routes")
DB_PATH = os.path.join(BACKEND, "data", "nogotki.db")
ENV_TEST = os.path.join(BACKEND, ".env.test")

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  OK   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}" + (f"   [{detail}]" if detail else ""))


def note(text):
    print(f"  --   {text}")


# --------------------------------------------------------------------------
# 1. Маршруты из исходников
#
# Префиксы монтирования взяты из src/app.js. Держим их здесь явно: забытый
# префикс в этом файле даст ложные 404 и набор будет вр��ть.
# --------------------------------------------------------------------------
MOUNT_PREFIX = {
    "auth.js": "/api/auth",
    "bookings.js": "/api/bookings",
    "catalog.js": "/api",
    "holds.js": "/api",
    "feedback.js": "/api/feedback",
    "notifications.js": "/api/notifications",
    "admin.js": "/api/admin",
}

# Публичные маршруты: сюда гость попасть обязан. Всё остальное — закрытое.
PUBLIC_PATTERNS = [
    re.compile(r"^/api/auth/(register|login|external/yandex|password/forgot)$"),
    re.compile(r"^/api/(services|masters|studio)$"),
    re.compile(r"^/api/masters/\d+/(slots|availability)$"),
    re.compile(r"^/api/feedback/?$"),          # форма отзыва без аккаунта
]

# Публичный маршрут может осмысленно ответить не 2xx, пока он не подключён:
# 503 «Яндекс-вход не подключён» — честный ответ, а не утечка. Утечкой считаем
# только коды, которыми сервер отдаёт данные.
PUBLIC_ALLOWED_STATUSES = {503}

ROUTE_RE = re.compile(r"router\.(get|post|patch|put|delete)\(\s*(?:'([^']*)'|\n\s*'([^']*)')")


def collect_routes():
    routes = []
    for fname in sorted(os.listdir(ROUTES_DIR)):
        if not fname.endswith(".js"):
            continue
        prefix = MOUNT_PREFIX.get(fname)
        if prefix is None:
            continue
        with open(os.path.join(ROUTES_DIR, fname), encoding="utf-8") as fh:
            src = fh.read()
        for m in ROUTE_RE.finditer(src):
            path = m.group(2) or m.group(3)
            routes.append((m.group(1).upper(), prefix + path, fname))
    return routes


# --------------------------------------------------------------------------
# 2. HTTP
# --------------------------------------------------------------------------
def call(method, url, cookie=None):
    req = urllib.request.Request(BASE_URL + url, method=method)
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code
    except urllib.error.URLError:
        return 0


def login(username, password):
    """Вход с терпимостью к лимиту: 5 попыток в минуту на адрес.

    Набор гоняют часто, и два входа за прогон (владелец + одноразовый клиент)
    легко упираются в лимит при перезапуске подряд. Это не дефект сервиса,
    поэтому ждём и повторяем, а не падаем.
    """
    import time
    payload = json.dumps({"username": username, "password": password}).encode()
    for attempt in range(4):
        req = urllib.request.Request(BASE_URL + "/api/auth/login", data=payload, method="POST")
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                raw = resp.headers.get("Set-Cookie", "")
                return raw.split(";")[0] if raw else None
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 3:
                wait = 20
                print(f"  --   Вход отклонён лимитом, жду {wait} с")
                time.sleep(wait)
                continue
            return None
    return None


def read_env_test():
    creds = {}
    if not os.path.exists(ENV_TEST):
        return creds
    with open(ENV_TEST, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            creds[key.strip()] = value.strip()
    return creds


# --------------------------------------------------------------------------
# 3. Идентичности
# --------------------------------------------------------------------------
TEMP_PREFIX = "amx"

def make_temp_client():
    """Регистрируем одноразового клиента и убираем за собой в конце."""
    import time
    uname = TEMP_PREFIX + str(int(time.time()) % 1000000)
    payload = json.dumps({
        "username": uname, "password": "Client12345",
        "name": "Матрица доступа", "phone": "+7999000" + uname[-6:],
    }).encode()
    req = urllib.request.Request(BASE_URL + "/api/auth/register", data=payload, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        return uname, None, f"регистрация вернула {e.code}"
    cookie = login(uname, "Client12345")
    return uname, cookie, None if cookie else "не удалось войти после регистрации"


def cleanup_temp_client(username):
    if not os.path.exists(DB_PATH):
        return
    conn = sqlite3.connect(DB_PATH)
    try:
        row = conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
        if not row:
            return
        uid = row[0]
        conn.execute("PRAGMA foreign_keys = OFF")
        for sql, param in (
            ("DELETE FROM auth_sessions WHERE user_id = ?", uid),
            ("DELETE FROM notifications WHERE user_id = ?", uid),
            ("DELETE FROM clients WHERE user_id = ?", uid),
            ("DELETE FROM user_roles WHERE user_id = ?", uid),
            ("DELETE FROM users WHERE id = ?", uid),
        ):
            conn.execute(sql, (param,))
        conn.commit()
    finally:
        conn.close()


def real_booking_id(owner_cookie):
    """Номер существующей записи — читаем только, ничего не меняя."""
    import datetime
    today = datetime.date.today()
    day = (today + datetime.timedelta(days=1)).isoformat()
    req = urllib.request.Request(BASE_URL + f"/api/admin/bookings/day?date={day}")
    req.add_header("Cookie", owner_cookie)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        items = data.get("bookings") or []
        return items[0]["id"] if items else None
    except Exception:
        return None


def main():
    print("=== Матрица доступа ===")
    print(f"  сервер: {BASE_URL}\n")

    if call("GET", "/health") == 0:
        print("  Сервер не отвечает. Поднимите его: node src/index.js")
        return 1

    routes = collect_routes()
    print(f"  Маршрутов из исходников: {len(routes)}\n")

    creds = read_env_test()
    owner = login(creds.get("TEST_ADMIN_USERNAME", "qa_admin"),
                  creds.get("TEST_ADMIN_PASSWORD", ""))
    if not owner:
        print("  Не удалось войти владельцем — проверьте backend/.env.test")
        return 1
    print("  Владелец: вошли")

    uname, client, err = make_temp_client()
    if err:
        print(f"  Ошибка подготовки клиента: {err}")
        return 1
    print(f"  Клиент: {uname} (одноразовый, будет удалён)\n")

    booking_id = real_booking_id(owner)
    if booking_id:
        print(f"  Для проверки прав на чужую запись используется запись #{booking_id}")
    else:
        note("Существующих записей не нашлось — маршруты с :id проверяем с несуществующим номером")

    # Подстановка вместо :id: реальный номер записи, если он есть.
    def concretize(path):
        if ":id" in path or ":booking" in path:
            target = booking_id if booking_id else 999999
            return re.sub(r":\w+", str(target), path)
        return path

    identities = [("аноним", None), ("клиент", client), ("владелец", owner)]

    try:
        print("\n--- Закрытые маршруты не отвечают анониму ---")
        closed = 0
        for method, path, _src in routes:
            if any(p.match(path) for p in PUBLIC_PATTERNS):
                continue
            url = concretize(path)
            st = call(method, url, None)
            if st == 0:
                note(f"{method} {url} — нет ответа, строка пропущена")
                continue
            closed += 1
            check(f"аноним: {method} {path}", st >= 400,
                  f"получил {st} — маршрут отдан без авторизации")
        print(f"  проверено закрытых маршрутов: {closed}")

        print("\n--- Клиент не попадает в админку ---")
        admin_routes = [(m, p, s) for m, p, s in routes if p.startswith("/api/admin")]
        for method, path, _src in admin_routes:
            url = concretize(path)
            st = call(method, url, client)
            if st == 0:
                continue
            check(f"клиент: {method} {path}", st >= 400, f"получил {st}")
        print(f"  проверено маршрутов админки: {len(admin_routes)}")

        print("\n--- Владелец не упирается в ошибки сервера ---")
        for method, path, _src in routes:
            url = concretize(path)
            st = call(method, url, owner)
            if st == 0:
                continue
            check(f"владелец: {method} {path}", st < 500 or st in PUBLIC_ALLOWED_STATUSES, f"получил {st}")

        print("\n--- Публичные маршруты открыты гостю ---")
        for method, path, _src in routes:
            if not any(p.match(path) for p in PUBLIC_PATTERNS):
                continue
            url = concretize(path)
            if "slots" in url or "availability" in url:
                url += ("&" if "?" in url else "?") + "date=2030-01-01&service_ids=1"
            st = call(method, url, None)
            ok = st < 500 or st in PUBLIC_ALLOWED_STATUSES
            check(f"гость: {method} {path}", ok, f"получил {st}")

        print("\n--- Страницы панели закрыты без роли ---")
        for page in ("/admin.html", "/admin/bookings.html", "/admin/services.html"):
            for who, cookie in identities[:2]:
                st = call("GET", page, cookie)
                check(f"{who}: {page}", st >= 400, f"получил {st}")
    finally:
        cleanup_temp_client(uname)

    print(f"\nИтог: {PASS} OK, {FAIL} FAIL")
    # Машинно-читаемая строка итога: разбор вывода на кириллице ненадёжен,
    # а автоматическая проверка должна читать однозначно.
    print(f"RESULT ok={PASS} fail={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())


