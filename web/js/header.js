'use strict';

// Общая шапка кабинета. Вставляется на все страницы кабинета через
// <div id="global-header"></div> + <script src="js/header.js"></script>.
// Требует авторизации: без токена редиректит на вход.

(function () {
  function mount() {
    var host = document.getElementById('global-header');
    if (!host) return;

    if (!window.api.isAuthed()) {
      window.location.href = 'login.html';
      return;
    }

    var u = window.api.user() || {};
    var name = window.api.esc(u.username || '?');

    host.innerHTML =
      '<header class="nav">' +
        '<div class="container nav__inner">' +
          '<a class="brand" href="index.html"><span class="brand__dot" aria-hidden="true"></span>Ноготочки</a>' +
          '<nav class="nav__links" aria-label="Основная навигация">' +
            '<a href="index.html">Главная</a>' +
            '<a href="index.html#services">Записаться</a>' +
          '</nav>' +
          '<span class="nav__user">' + name + '</span>' +
          '<button type="button" class="btn btn--secondary btn--sm" data-logout>Выйти</button>' +
        '</div>' +
      '</header>';

    var out = host.querySelector('[data-logout]');
    if (out) out.addEventListener('click', function () { window.api.logout(); });
  }

  mount();
})();