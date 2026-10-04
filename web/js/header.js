'use strict';

// ЕДИНАЯ ШАПКА КЛИЕНТА. Подключается на ВСЕ страницы web/ через
//   <div id="global-header"></div>
//   <script src="js/api.js"></script>
//   <script src="js/header.js"></script>
// Состав — из прототипа (prototype/index.html) и глобальной навигации
// карты связей: бренд, «Услуги и цены», «О студии», «Мои записи»,
// CTA «Записаться» + блок авторизации.
// Имя вошедшего клиента берётся из API (GET /api/auth/me, кука-сессия);
// если клиент не вошёл — вместо аватара показываем «Войти» и «Регистрация».
// Шапка прижата к верху страницы (position: sticky в app.css -> .nav).

(function () {
  var host = document.getElementById('global-header');
  if (!host) return;

  function render(user) {
    // «Мои записи» — кабинет клиента, «Панель владельца» — /api/admin/*, и обе
    // ссылки зависят от роли: клиенту показываем только кабинет, владельцу —
    // панель (его кабинет закрыт, иначе он видел бы чужие записи как свои).
    var roles = user && Array.isArray(user.roles) ? user.roles : [];
    var links =
      '<a href="catalog.html">Услуги и цены</a>' +
      '<a href="index.html#about">О студии</a>';
    if (roles.indexOf('client') !== -1) {
      links += '<a href="appointments.html">Мои записи</a>';
    }
    // Пункт «Панель владельца» — только для роли owner. Это скрытие пункта
    // меню, а не защита: доступ к разделу /admin проверяет сервер
    // (routes/admin-pages.js), поэтому клиент без роли owner получит 403.
    if (roles.indexOf('owner') !== -1) {
      links += '<a href="/admin">Панель владельца</a>';
    }

    var auth;
    if (user) {
      var name = user.client_name || user.username || '?';
      var initial = window.api.esc(String(name).trim().charAt(0).toUpperCase());
      // Колокольчик с числом непрочитанных. Число НЕ зашито в разметку:
      // приходит тем же ответом, что и список уведомлений (api.notifications()).
      auth =
        '<div class="nav__auth">' +
          '<a class="nav__bell" href="notifications.html" aria-label="Уведомления">' +
            '<span class="nav__bell-icon" aria-hidden="true">🔔</span>' +
            '<span class="nav__bell-count" id="notifCount" hidden></span>' +
          '</a>' +
          '<span class="nav__avatar" title="' + window.api.esc(name) + '">' + initial + '</span>' +
          '<span class="nav__user">' + window.api.esc(name) + '</span>' +
          '<button type="button" class="btn btn--secondary btn--sm" data-logout>Выйти</button>' +
        '</div>';
      // Счётчик подставляем после вставки шапки: на самой странице ещё нет DOM.
      setTimeout(function () { fillUnread(); }, 0);
    } else {
      auth =
        '<div class="nav__auth">' +
          '<a class="btn btn--ghost btn--sm" href="login.html">Войти</a>' +
          '<a class="btn btn--secondary btn--sm" href="register.html">Регистрация</a>' +
        '</div>';
    }

    host.innerHTML =
      '<header class="nav">' +
        '<div class="container nav__inner">' +
          '<a class="brand" href="index.html"><span class="brand__dot" aria-hidden="true"></span>Ноготочки</a>' +
          '<div class="nav__cluster">' +
            // Кнопка нужна только на узком экране: в app.css .nav__toggle скрыта
            // на широком, а на телефоне .nav__menu раскрывается под шапкой
            '<button type="button" class="nav__toggle" aria-expanded="false" ' +
              'aria-controls="navMenu" aria-label="Меню" title="Меню">☰</button>' +
            '<div class="nav__menu" id="navMenu">' +
              '<nav class="nav__links" aria-label="Основная навигация">' + links + '</nav>' +
              '<a class="btn btn--primary btn--sm" href="booking.html">Записаться</a>' +
            '</div>' +
          '</div>' +
          auth +
        '</div>' +
      '</header>';

    // Меню на телефоне: раскрывается по кнопке и закрывается, когда клиент
    // ушёл по ссылке. Ссылки не прячутся — они просто свёрнуты.
    var toggle = host.querySelector('.nav__toggle');
    var menu = host.querySelector('.nav__menu');
    function setMenu(open) {
      menu.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    toggle.addEventListener('click', function () {
      setMenu(!menu.classList.contains('is-open'));
    });
    // Ушли по ссылке, нажали вне меню или нажали Escape — панель закрывается
    menu.addEventListener('click', function (e) {
      if (e.target.closest('a')) setMenu(false);
    });
    document.addEventListener('click', function (e) {
      if (!menu.classList.contains('is-open')) return;
      if (e.target.closest('.nav__menu') || e.target.closest('.nav__toggle')) return;
      setMenu(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menu.classList.contains('is-open')) setMenu(false);
    });

    var out = host.querySelector('[data-logout]');
    if (out) out.addEventListener('click', function () { window.api.logout(); });
  }

  // Счётчик непрочитанных подставляется из ответа /api/notifications.
  // Отдельного запроса ради числа нет — тот же ответ отдаёт и список.
  function fillUnread() {
    var el = document.getElementById('notifCount');
    if (!el) return;
    window.api.notifications().then(function (data) {
      var n = Number((data && data.unread) || 0);
      if (n > 0) {
        el.textContent = n > 99 ? '99+' : String(n);
        el.hidden = false;
      } else {
        el.hidden = true;
        el.textContent = '';
      }
    });
  }

  window.api.me().then(render).catch(function () { render(null); });
})();