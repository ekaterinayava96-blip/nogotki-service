"""Общий HTTP-клиент с фолбэками: прокси/напрямую, проверка SSL вкл/выкл.

GigaChat и другие российские сервисы используют сертификаты Минцифры,
которых нет в стандартном хранилище доверия Python, поэтому при
SSLCertVerificationError делается повторный запрос без проверки сертификата.
"""

import logging

import aiohttp
from aiohttp import ClientConnectorCertificateError

from config import PROXY_URL

logger = logging.getLogger(__name__)


async def request(url: str, method: str = "POST", **kwargs) -> dict:
    attempts = [
        {"proxy": PROXY_URL},
        {"proxy": PROXY_URL, "ssl": False},
        {},
        {"ssl": False},
    ]
    async with aiohttp.ClientSession() as session:
        for attempt in attempts:
            try:
                async with session.request(method, url, **kwargs, **attempt) as resp:
                    text = await resp.text()
                    if resp.status not in (200, 201):
                        raise RuntimeError(f"HTTP {resp.status} from {url}: {text}")
                    return await resp.json()
            except ClientConnectorCertificateError:
                logger.warning("SSL verification failed for %s, retrying insecure", url)
                continue
            except aiohttp.ClientError:
                logger.warning("Connection failed for %s: %s", url, attempt)
                continue
            except RuntimeError:
                logger.error("Request failed: %s %s", method, url)
                raise
    raise RuntimeError(f"Unable to connect to {url}")