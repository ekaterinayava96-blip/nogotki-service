"""Автотесты ключевой логики: корзина, заказы, оплата, история диалога."""

import os
from pathlib import Path

import pytest

import config
import database as db
import payments
from http_client import request as http_request

pytestmark = pytest.mark.asyncio

TEST_USER = 123456789


@pytest.fixture
async def isolated_db(tmp_path: Path):
    old_path = db.DB_PATH
    db.DB_PATH = str(tmp_path / "test_nogotki.db")
    await db.close_db()
    await db.get_db()
    yield
    await db.close_db()
    db._db = None
    db.DB_PATH = old_path


@pytest.fixture
async def prepared_cart(isolated_db):
    services = await db.get_services()
    s1, s2 = services[0], services[1]
    await db.add_to_cart(TEST_USER, s1["id"])
    await db.add_to_cart(TEST_USER, s1["id"])
    await db.add_to_cart(TEST_USER, s2["id"])
    return s1, s2


# ---------- Корзина ----------

async def test_add_to_cart_increments_quantity(prepared_cart):
    s1, _ = prepared_cart
    cart = await db.get_cart(TEST_USER)
    item1 = next(i for i in cart if i["service_id"] == s1["id"])
    assert item1["quantity"] == 2


async def test_cart_total_correct(prepared_cart):
    s1, s2 = prepared_cart
    total = await db.get_cart_total(TEST_USER)
    assert total == s1["price"] * 2 + s2["price"]


async def test_remove_from_cart(prepared_cart):
    s1, _ = prepared_cart
    await db.remove_from_cart(TEST_USER, s1["id"])
    cart = await db.get_cart(TEST_USER)
    assert all(i["service_id"] != s1["id"] for i in cart)


async def test_empty_cart_total_is_zero(isolated_db):
    assert await db.get_cart_total(TEST_USER) == 0


# ---------- Оформление заказа ----------

async def test_create_order_from_empty_cart_returns_none(isolated_db):
    """Граничный случай: оформление заказа с пустой корзиной не создаёт заказ."""
    order_id = await db.create_order_from_cart(TEST_USER)
    assert order_id is None


async def test_create_order_moves_items_and_clears_cart(prepared_cart):
    s1, s2 = prepared_cart
    order_id = await db.create_order_from_cart(TEST_USER)
    assert order_id is not None
    order = await db.get_order(order_id)
    assert order["total"] == s1["price"] * 2 + s2["price"]
    assert order["status"] == "pending"
    items = await db.get_order_items(order_id)
    assert len(items) == 2
    assert await db.get_cart(TEST_USER) == []


async def test_double_checkout_second_is_blocked(prepared_cart):
    """Граничный случай: двойное нажатие «Оформить заказ» не создаёт второй заказ."""
    first = await db.create_order_from_cart(TEST_USER)
    second = await db.create_order_from_cart(TEST_USER)
    assert first is not None
    assert second is None


async def test_mark_order_paid(prepared_cart):
    order_id = await db.create_order_from_cart(TEST_USER)
    await db.set_order_payment(order_id, "pay_t", "https://pay.example")
    await db.mark_order_paid(order_id, "pay_t")
    order = await db.get_order(order_id)
    assert order["status"] == "paid"
    assert order["paid_at"] is not None


# ---------- Оплата ----------

async def test_classify_payment_status_paid():
    assert payments.classify_status("succeeded") == "paid"


async def test_classify_payment_status_not_paid():
    assert payments.classify_status("pending") == "pending"
    assert payments.classify_status("canceled") == "canceled"
    assert payments.classify_status("unknown") == "pending"


async def test_confirm_does_not_mark_unpaid_order(isolated_db, monkeypatch):
    """«Я оплатил» без реальной оплаты (статус pending) не подтверждает заказ."""

    async def fake_get_payment_status(payment_id):
        return "pending"

    monkeypatch.setattr(payments, "get_payment_status", fake_get_payment_status)

    cart_service = (await db.get_services())[0]
    await db.add_to_cart(TEST_USER, cart_service["id"])
    order_id = await db.create_order_from_cart(TEST_USER)
    await db.set_order_payment(order_id, "pay_test", "https://pay.example")

    status = await payments.get_payment_status("pay_test")
    outcome = payments.classify_status(status)
    if outcome == "paid":
        await db.mark_order_paid(order_id, "pay_test")

    order = await db.get_order(order_id)
    assert order["status"] == "pending"


async def test_confirm_with_real_success_payment(isolated_db, monkeypatch):
    """Оплата тестовой картой (статус succeeded) подтверждает заказ."""

    async def fake_get_payment_status(payment_id):
        return "succeeded"

    monkeypatch.setattr(payments, "get_payment_status", fake_get_payment_status)

    cart_service = (await db.get_services())[0]
    await db.add_to_cart(TEST_USER, cart_service["id"])
    order_id = await db.create_order_from_cart(TEST_USER)
    await db.set_order_payment(order_id, "pay_ok", "https://pay.example")

    status = await payments.get_payment_status("pay_ok")
    outcome = payments.classify_status(status)
    if outcome == "paid":
        await db.mark_order_paid(order_id, "pay_ok")

    order = await db.get_order(order_id)
    assert order["status"] == "paid"


# ---------- Форматирование цен ----------

async def test_money_formats_rubles():
    from bot import money
    assert money(1800) == "1 800 ₽"
    assert money(1200) == "1 200 ₽"
    assert money(300) == "300 ₽"


# ---------- История диалога ----------

async def test_history_persists_and_limited(isolated_db):
    for i in range(5):
        await db.add_history(TEST_USER, "user", f"q{i}")
        await db.add_history(TEST_USER, "assistant", f"a{i}")
    history = await db.get_history(TEST_USER, limit=20)
    assert len(history) == 10
    assert history[0] == {"role": "user", "content": "q0"}

    history3 = await db.get_history(TEST_USER, limit=3)
    assert len(history3) == 3
    assert history3[-1] == {"role": "assistant", "content": "a4"}


async def test_history_clear(isolated_db):
    await db.add_history(TEST_USER, "user", "hi")
    await db.clear_history(TEST_USER)
    assert await db.get_history(TEST_USER) == []