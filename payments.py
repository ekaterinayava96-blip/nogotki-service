"""ЮKassa: создание платежа и проверка статуса (тестовый режим)."""

import base64
import logging
import uuid

from http_client import request
from config import YOOKASSA_API_URL, YOOKASSA_SECRET_KEY, YOOKASSA_SHOP_ID

logger = logging.getLogger(__name__)

PAID = "succeeded"


def classify_status(status: str) -> str:
    """Классифицирует статус платежа для логики бота.

    Возвращает: 'paid' | 'canceled' | 'pending'
    """
    if status == PAID:
        return "paid"
    if status == "canceled":
        return "canceled"
    return "pending"


def _auth_headers() -> dict:
    token = base64.b64encode(
        f"{YOOKASSA_SHOP_ID}:{YOOKASSA_SECRET_KEY}".encode()
    ).decode()
    return {
        "Authorization": f"Basic {token}",
        "Content-Type": "application/json",
        "Idempotence-Key": str(uuid.uuid4()),
    }


async def create_payment(amount_rub: int, description: str, order_id: int):
    """Создаёт платёж. Возвращает (payment_id, confirmation_url).

    amount_rub — сумма в рублях (целое число), соответствует orders.total.
    """
    payload = {
        "amount": {"value": f"{amount_rub}.00", "currency": "RUB"},
        "capture": True,
        "confirmation": {
            "type": "redirect",
            "return_url": "https://t.me/NogotkIcentr_bot",
        },
        "description": description,
        "metadata": {"order_id": str(order_id)},
    }
    data = await request(
        YOOKASSA_API_URL, method="POST", headers=_auth_headers(), json=payload
    )
    return data["id"], data["confirmation"]["confirmation_url"]


async def get_payment_status(payment_id: str) -> str:
    """Возвращает статус платежа: succeeded / pending / canceled / unknown."""
    url = f"{YOOKASSA_API_URL}/{payment_id}"
    try:
        data = await request(url, method="GET", headers=_auth_headers())
    except RuntimeError:
        logger.exception("Could not fetch payment status for %s", payment_id)
        return "unknown"
    return data.get("status", "unknown")