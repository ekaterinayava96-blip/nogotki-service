"""База данных: пользователи, услуги, корзина, заказы, история диалога."""

import logging

import aiosqlite

from config import DB_PATH

logger = logging.getLogger(__name__)

_db: aiosqlite.Connection | None = None

SERVICES_SEED = [
    {
        "name": "Маникюр с покрытием гель-лаком",
        "description": "Уход за ногтями и стойкое покрытие на 3–4 недели",
        "price": 1800,
        "duration": "1,5 часа",
    },
    {
        "name": "Маникюр и педикюр",
        "description": "Комплекс из двух процедур за один визит",
        "price": 3200,
        "duration": "2,5 часа",
    },
    {
        "name": "Наращивание ногтей",
        "description": "Моделирование желаемой формы и длины ногтей",
        "price": 2800,
        "duration": "2,5 часа",
    },
    {
        "name": "Дизайн ногтей",
        "description": "Рисунок, втирка, стразы или френч",
        "price": 300,
        "duration": "+15–30 минут к сеансу",
    },
    {
        "name": "Коррекция и окрашивание бровей",
        "description": "Коррекция формы и окрашивание волосков",
        "price": 1200,
        "duration": "40 минут",
    },
    {
        "name": "Ламинирование бровей",
        "description": "Укладка и стойкая форма бровей на 4–6 недель",
        "price": 1800,
        "duration": "1 час",
    },
]


def format_price(s: float) -> float:
    return round(s, 2)


async def get_db() -> aiosqlite.Connection:
    global _db
    if _db is None:
        _db = await aiosqlite.connect(DB_PATH)
        _db.row_factory = aiosqlite.Row
        await _init_db()
    return _db


async def close_db() -> None:
    global _db
    if _db is not None:
        await _db.close()
        _db = None


async def _init_db() -> None:
    await _db.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            username TEXT,
            first_name TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            price INTEGER NOT NULL,
            duration TEXT
        );

        CREATE TABLE IF NOT EXISTS cart_items (
            user_id INTEGER NOT NULL,
            service_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (user_id, service_id)
        );

        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            total INTEGER NOT NULL,
            payment_id TEXT DEFAULT NULL,
            confirmation_url TEXT DEFAULT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            paid_at TEXT DEFAULT NULL
        );

        CREATE TABLE IF NOT EXISTS order_items (
            order_id INTEGER NOT NULL,
            service_id INTEGER,
            service_name TEXT NOT NULL,
            price INTEGER NOT NULL,
            quantity INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS dialog_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );
        """
    )
    await _db.commit()
    await _seed_services()


async def _seed_services() -> None:
    cur = await _db.execute("SELECT COUNT(*) FROM services")
    (count,) = await cur.fetchone()
    if count:
        return
    for s in SERVICES_SEED:
        await _db.execute(
            "INSERT INTO services (name, description, price, duration) VALUES (?, ?, ?, ?)",
            (s["name"], s["description"], s["price"], s["duration"]),
        )
    await _db.commit()
    logger.info("Services seeded: %d", len(SERVICES_SEED))


async def upsert_user(user_id: int, username: str | None, first_name: str | None) -> None:
    db = await get_db()
    await db.execute(
        """INSERT INTO users (user_id, username, first_name) VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET username = excluded.username,
                                               first_name = excluded.first_name""",
        (user_id, username, first_name),
    )
    await db.commit()


# ---------- Услуги ----------

async def get_services() -> list[aiosqlite.Row]:
    db = await get_db()
    cur = await db.execute("SELECT * FROM services ORDER BY id")
    return await cur.fetchall()


async def get_service(service_id: int) -> aiosqlite.Row | None:
    db = await get_db()
    cur = await db.execute("SELECT * FROM services WHERE id = ?", (service_id,))
    return await cur.fetchone()


# ---------- Корзина ----------

async def add_to_cart(user_id: int, service_id: int) -> None:
    db = await get_db()
    await db.execute(
        """INSERT INTO cart_items (user_id, service_id, quantity) VALUES (?, ?, 1)
           ON CONFLICT(user_id, service_id) DO UPDATE SET quantity = quantity + 1""",
        (user_id, service_id),
    )
    await db.commit()


async def remove_from_cart(user_id: int, service_id: int) -> None:
    db = await get_db()
    await db.execute(
        "DELETE FROM cart_items WHERE user_id = ? AND service_id = ?",
        (user_id, service_id),
    )
    await db.commit()


async def get_cart(user_id: int) -> list[dict]:
    db = await get_db()
    cur = await db.execute(
        """SELECT s.id, s.name, s.price, c.quantity
           FROM cart_items c JOIN services s ON s.id = c.service_id
           WHERE c.user_id = ? ORDER BY s.id""",
        (user_id,),
    )
    rows = await cur.fetchall()
    return [
        {
            "service_id": row["id"],
            "name": row["name"],
            "price": row["price"],
            "quantity": row["quantity"],
            "subtotal": row["price"] * row["quantity"],
        }
        for row in rows
    ]


async def get_cart_total(user_id: int) -> int:
    db = await get_db()
    cur = await db.execute(
        """SELECT COALESCE(SUM(s.price * c.quantity), 0)
           FROM cart_items c JOIN services s ON s.id = c.service_id
           WHERE c.user_id = ?""",
        (user_id,),
    )
    (total,) = await cur.fetchone()
    return int(total)


async def clear_cart(user_id: int) -> None:
    db = await get_db()
    await db.execute("DELETE FROM cart_items WHERE user_id = ?", (user_id,))
    await db.commit()


# ---------- Заказы ----------

async def create_order_from_cart(user_id: int) -> int | None:
    """Создаёт заказ из корзины. Возвращает id заказа или None, если корзина пуста."""
    cart = await get_cart(user_id)
    if not cart:
        return None
    db = await get_db()
    total = sum(item["subtotal"] for item in cart)
    cur = await db.execute(
        "INSERT INTO orders (user_id, status, total) VALUES (?, 'pending', ?)",
        (user_id, total),
    )
    order_id = cur.lastrowid
    for item in cart:
        await db.execute(
            """INSERT INTO order_items (order_id, service_id, service_name, price, quantity)
               VALUES (?, ?, ?, ?, ?)""",
            (order_id, item["service_id"], item["name"], item["price"], item["quantity"]),
        )
    await db.commit()
    await clear_cart(user_id)
    return order_id


async def get_order(order_id: int) -> aiosqlite.Row | None:
    db = await get_db()
    cur = await db.execute("SELECT * FROM orders WHERE id = ?", (order_id,))
    return await cur.fetchone()


async def get_order_items(order_id: int) -> list[aiosqlite.Row]:
    db = await get_db()
    cur = await db.execute(
        "SELECT * FROM order_items WHERE order_id = ?", (order_id,)
    )
    return await cur.fetchall()


async def set_order_payment(order_id: int, payment_id: str, confirmation_url: str) -> None:
    db = await get_db()
    await db.execute(
        """UPDATE orders SET payment_id = ?, confirmation_url = ?
           WHERE id = ?""",
        (payment_id, confirmation_url, order_id),
    )
    await db.commit()


async def mark_order_paid(order_id: int, payment_id: str) -> None:
    db = await get_db()
    await db.execute(
        """UPDATE orders SET status = 'paid', paid_at = datetime('now')
           WHERE id = ? AND payment_id = ?""",
        (order_id, payment_id),
    )
    await db.commit()


# ---------- История диалога ----------

async def add_history(user_id: int, role: str, content: str) -> None:
    db = await get_db()
    await db.execute(
        "INSERT INTO dialog_history (user_id, role, content) VALUES (?, ?, ?)",
        (user_id, role, content),
    )
    await db.commit()


async def get_history(user_id: int, limit: int = 20) -> list[dict]:
    db = await get_db()
    cur = await db.execute(
        """SELECT role, content FROM dialog_history
           WHERE user_id = ? ORDER BY rowid DESC LIMIT ?""",
        (user_id, limit),
    )
    rows = await cur.fetchall()
    return [{"role": row["role"], "content": row["content"]} for row in reversed(rows)]


async def clear_history(user_id: int) -> None:
    db = await get_db()
    await db.execute("DELETE FROM dialog_history WHERE user_id = ?", (user_id,))
    await db.commit()