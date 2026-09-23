"""Единый интерфейс к ИИ-моделям: GigaChat или любой OpenAI-совместимый API."""

import logging
import time
import uuid

from config import (
    AI_API_KEY,
    AI_API_URL,
    AI_MODEL,
    AI_PROVIDER,
    GIGACHAT_AUTH_KEY,
    GIGACHAT_BASE_URL,
    GIGACHAT_MODEL,
    GIGACHAT_TOKEN_URL,
)
from http_client import request

logger = logging.getLogger(__name__)

_giga_token = {"value": None, "expires_at": 0.0}


async def _get_gigachat_token() -> str:
    if _giga_token["value"] and time.time() < _giga_token["expires_at"] - 60:
        return _giga_token["value"]

    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "RqUID": str(uuid.uuid4()),
        "Authorization": f"Bearer {GIGACHAT_AUTH_KEY}",
    }
    payload = await request(
        GIGACHAT_TOKEN_URL,
        method="POST",
        headers=headers,
        data={"scope": "GIGACHAT_API_PERS"},
    )

    token = payload["access_token"]
    raw_expires = payload.get("expires_at", time.time() * 1000 + 1800000)
    expires_at = float(raw_expires)
    if expires_at > 1e12:
        expires_at /= 1000.0
    _giga_token["value"] = token
    _giga_token["expires_at"] = expires_at
    logger.info("GigaChat access token obtained, valid until %s", expires_at)
    return token


async def _ask_gigachat(messages: list[dict]) -> str:
    token = await _get_gigachat_token()
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": GIGACHAT_MODEL,
        "messages": messages,
        "temperature": 0.4,
        "max_tokens": 800,
    }
    url = f"{GIGACHAT_BASE_URL}/chat/completions"
    data = await request(url, method="POST", headers=headers, json=payload)
    return data["choices"][0]["message"]["content"].strip()


async def _ask_openai_compatible(messages: list[dict]) -> str:
    headers = {
        "Authorization": f"Bearer {AI_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": AI_MODEL,
        "messages": messages,
        "temperature": 0.4,
        "max_tokens": 800,
    }
    data = await request(AI_API_URL, method="POST", headers=headers, json=payload)
    return data["choices"][0]["message"]["content"].strip()


async def ask_ai(messages: list[dict]) -> str:
    if AI_PROVIDER == "gigachat" and GIGACHAT_AUTH_KEY:
        return await _ask_gigachat(messages)
    return await _ask_openai_compatible(messages)