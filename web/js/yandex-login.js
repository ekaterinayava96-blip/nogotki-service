// Кнопка «Войти через Яндекс». Одинаковая на экранах входа, регистрации и
// восстановления пароля, поэтому вынесена отдельно от страниц.
//
// Пока сервис в Яндексе не зарегистрирован, кнопка делает прямой запрос и
// получает тестовые данные из заглушки (YANDEX_STUB). После публикации
// сервиса здесь будет переход на страницу Яндекса, а обмен кода останется на
// сервере — в fetchIdentityFromYandex(). Наш код входа не меняется.

(function () {
  var btn = document.getElementById('yandexLogin');
  if (!btn) return;

  btn.addEventListener('click', function () {
    if (window.ui && window.ui.clear) window.ui.clear();
    btn.disabled = true;
    window.api.request('/api/auth/external/yandex', { method: 'POST' })
      .then(function (data) {
        window.ui.afterAuth(window.ui.homeFor(data && data.user));
      })
      .catch(function () {
        // Текст ошибки уже показан в #error через api.request.
        btn.disabled = false;
      });
  });
})();