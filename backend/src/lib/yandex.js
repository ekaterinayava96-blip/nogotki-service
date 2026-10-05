'use strict';

// Внешний вход через Яндекс.
//
// ВАЖНО: сервис в Яндексе пока НЕ зарегистрирован. У приложения нет
// постоянного адреса, на который Яндекс смог бы вернуть пользователя с кодом,
// поэтому настоящий обмен кодами невозможен. Сейчас собран наш конец входа,
// а вместо обращения к Яндексу подставляется заглушка.
//
// Заглушку включает переменная окружения YANDEX_STUB. По умолчанию она
// ВЫКЛЮЧЕНА. Включать её на сервере нельзя: она пускает в аккаунт без
// проверки у Яндекса. Подробности — в README, раздел «Внешний вход».
//
// Токен Яндекса нам не нужен и не сохраняется: из него берутся только почта и
// имя, и только эти два значения уходят в resolveExternalIdentity. Внутри
// сервиса авторизация всегда идёт собственным токеном из issueToken().

const cfg = require('../config');

class YandexNotConfiguredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'YandexNotConfiguredError';
    this.code = 'YANDEX_NOT_CONFIGURED';
  }
}

// Единственное место, которое придётся переписать после публикации сервиса.
// Вся остальная логика входа (routes/auth.js) останется как есть.
//
// Что здесь нужно будет сделать:
//   1. проверить одноразовый код из query на /login/confirm и обменять его на
//      токен: POST https://oauth.yandex.ru/token
//      (grant_type=authorization_code, code, client_id, client_secret);
//   2. запросить профиль: GET https://login.yandex.ru/info с заголовком
//      Authorization: OAuth <токен>;
//   3. вернуть { email, name } — и больше ничего.
//
// Токен Яндекса наружу не отдаётся и нигде не сохраняется.
async function fetchIdentityFromYandex(payload) {
  if (!cfg.yandexClientId || !cfg.yandexClientSecret) {
    throw new YandexNotConfiguredError(
      'Яндекс-вход не подключён: укажите YANDEX_CLIENT_ID и YANDEX_CLIENT_SECRET.'
    );
  }

  throw new YandexNotConfiguredError(
    'Яндекс-вход ещё не подключён: сервис не опубликован, постоянного адреса для возврата нет. Замените заглушку в fetchIdentityFromYandex() на настоящий обмен кода.'
  );
}

// Тестовые данные заглушки. Берутся из настроек и только из них: тело запроса
// игнорируется целиком, иначе заглушка превратилась бы в способ войти под
// любым именем и с любой почтой.
function stubIdentity() {
  return { email: cfg.yandexStubEmail, name: cfg.yandexStubName };
}

// Точка входа для routes/auth.js: отдаёт проверенные почту и имя.
async function resolveExternalIdentity(payload) {
  if (cfg.yandexStubEnabled) {
    const s = stubIdentity();
    return { email: s.email, name: s.name, source: 'stub' };
  }
  const identity = await fetchIdentityFromYandex(payload);
  return { email: identity.email, name: identity.name, source: 'yandex' };
}

module.exports = {
  resolveExternalIdentity,
  fetchIdentityFromYandex,
  stubIdentity,
  YandexNotConfiguredError,
};