import os
from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN", "YOUR_BOT_TOKEN_HERE")
PROXY_URL = os.getenv("PROXY_URL", "http://127.0.0.1:10809")
ADMIN_CONTACT = os.getenv("ADMIN_CONTACT", "@AdminsContact")

AI_PROVIDER = os.getenv("AI_PROVIDER", "gigachat").lower()

# OpenAI-совместимый провайдер
AI_API_KEY = os.getenv("AI_API_KEY", "")
AI_API_URL = os.getenv("AI_API_URL", "https://openrouter.ai/api/v1/chat/completions")
AI_MODEL = os.getenv("AI_MODEL", "deepseek/deepseek-v4-flash-latest")

# GigaChat
GIGACHAT_AUTH_KEY = os.getenv("GIGACHAT_AUTH_KEY", "")
GIGACHAT_TOKEN_URL = os.getenv(
    "GIGACHAT_TOKEN_URL", "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"
)
GIGACHAT_BASE_URL = os.getenv("GIGACHAT_BASE_URL", "https://api.giga.chat/v1")
GIGACHAT_MODEL = os.getenv("GIGACHAT_MODEL", "GigaChat-2-Pro")

# ЮKassa (тестовый режим)
YOOKASSA_SHOP_ID = os.getenv("YOOKASSA_SHOP_ID", "")
YOOKASSA_SECRET_KEY = os.getenv("YOOKASSA_SECRET_KEY", "")
YOOKASSA_API_URL = os.getenv(
    "YOOKASSA_API_URL", "https://api.yookassa.ru/v3/payments"
)

# База данных
DB_PATH = os.getenv("DB_PATH", "nogotki.db")