'use strict';

const fs = require('fs');
const path = require('path');

// Поддержка .env (если файла нет — используются переменные окружения/дефолты ниже)
const envFile = path.join(__dirname, '..', '.env');
let dotenvMissing = false;
try {
  require('dotenv').config({ path: envFile });
} catch (_) {
  dotenvMissing = true; // пакет dotenv не установлен
}

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

// В проде не подставляем dev-дефолты: отсутствующая переменная = отказ в старте.
// Так ошибка видна сразу при запуске, а не в момент первого запроса.
function requireProd(name) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    throw new Error(
      `[config] ${name} обязателен при NODE_ENV=production — заполните ${envFile} (образец: .env.example).`
    );
  }
  return value;
}

if (isProduction) {
  if (dotenvMissing && fs.existsSync(envFile)) {
    throw new Error(
      '[config] Файл .env найден, но пакет dotenv не установлен — выполните npm install.'
    );
  }
  requireProd('DB_PATH');
}

const portRaw = process.env.PORT;
const port = portRaw === undefined || portRaw === '' ? 3000 : Number(portRaw);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`[config] PORT должен быть числом 0–65535, получено: «${portRaw}»`);
}

// Время жизни токена доступа по умолчанию (сек.)
const AUTH_TTL_SECONDS = Number(process.env.AUTH_TTL_SECONDS || 7 * 24 * 3600);

// Число доверенных reverse-proxy перед приложением. Нужно, чтобы rate limit
// по IP видел реального клиента (X-Forwarded-For), а не адрес nginx/балансировщика.
// TRUST_PROXY не задан/0/false — приложение слушает напрямую (req.ip = адрес сокета).
const TRUST_PROXY_RAW = (process.env.TRUST_PROXY || '').trim().toLowerCase();
const trustProxy = TRUST_PROXY_RAW === '' || TRUST_PROXY_RAW === '0' || TRUST_PROXY_RAW === 'false'
  ? false
  : (Number(TRUST_PROXY_RAW) >= 0 ? Number(TRUST_PROXY_RAW) : 1);

// ---------- Внешний вход (Яндекс) ----------
//
// Сервис в Яндексе НЕ зарегистрирован: у него нет постоянного адреса, на
// который Яндекс вернёт пользователя. Пока адреса нет, реальный обмен кодами
// невозможен, поэтому внешний вход проверяется заглушкой.
//
// По умолчанию заглушка ВЫКЛЮЧЕНА. Пока сервис не опубликован, держать
// заглушку включённой на сервере нельзя: она подставляет тестовую почту и
// имя и пускает в аккаунт без проверки у Яндекса.
const YANDEX_STUB = (process.env.YANDEX_STUB || '').trim().toLowerCase();
const yandexStubEnabled = YANDEX_STUB === '1' || YANDEX_STUB === 'true' || YANDEX_STUB === 'yes';

// Тестовые данные заглушки. Пока она включена — только для локальной проверки.
const yandexStubEmail = (process.env.YANDEX_STUB_EMAIL || '').trim().toLowerCase();
const yandexStubName = (process.env.YANDEX_STUB_NAME || '').trim();

// Настоящее подключение: заполняется после публикации сервиса в Яндексе.
const yandexClientId = (process.env.YANDEX_CLIENT_ID || '').trim();
const yandexClientSecret = (process.env.YANDEX_CLIENT_SECRET || '').trim();
const yandexRedirectUri = (process.env.YANDEX_REDIRECT_URI || '').trim();

// Включённая заглушка без почты приведёт к вечной пустой ветке, поэтому
// отказываем на старте, а не молча логиним в никуда.
if (yandexStubEnabled && !yandexStubEmail) {
  throw new Error(
    '[config] YANDEX_STUB включён, но YANDEX_STUB_EMAIL пуст — укажите тестовую почту или выключите заглушку.'
  );
}

module.exports = {
  port,
  dbPath: path.resolve(__dirname, '..', process.env.DB_PATH || 'data/nogotki.db'),
  nodeEnv,
  isProduction,
  trustProxy,
  authTtlSeconds: Number.isInteger(AUTH_TTL_SECONDS) && AUTH_TTL_SECONDS > 0 ? AUTH_TTL_SECONDS : 7 * 24 * 3600,
  yandexStubEnabled,
  yandexStubEmail,
  yandexStubName,
  yandexClientId,
  yandexClientSecret,
  yandexRedirectUri,
};
