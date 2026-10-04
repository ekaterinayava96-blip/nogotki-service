'use strict';

// Каркас раздела администратора: шапка и меню разделов «Записи», «Услуги»,
// «Мастера». Файл общий для всех страниц /admin, поэтому в каждой из них стоят
// два пустых контейнера:
//
//   <div id="admin-header"></div>
//   <div id="admin-menu"></div>
//
//   <script src="/js/api.js"></script>
//   <script src="/js/admin-shell.js"></script>
//
// Страницы разделов пустые, данных они не запрашивают.
//
// Про права: страницу отдаёт сервер только владельцу (GET /admin* —
// routes/admin-pages.js, requireOwnerPage), поэтому проверка роли здесь —
// вторым эшелоном, только чтобы клиенту не показывать само меню. Роли — список,
// поэтому проверяем НАЛИЧИЕ роли, а не равенство.

(function () {
  var ADMIN_ROLE = 'owner';

  var SECTIONS = [
    { href: '/admin/bookings', label: 'Записи' },
    { href: '/admin/services', label: 'Услуги' },
    { href: '/admin/masters', label: 'Мастера' }
  ];

  // Роль — список: проверяем вхождение, а не равенство.
  function isAdmin(user) {
    return !!user && Array.isArray(user.roles) && user.roles.indexOf(ADMIN_ROLE) !== -1;
  }

  // Текущий адрес раздела без хвостового слэша: '/admin' или '/admin/bookings'.
  function currentPath() {
    return window.location.pathname.replace(/\/+$/, '') || '/admin';
  }

  function renderHeader(user) {
    var host = document.getElementById('admin-header');
    if (!host) return;

    var right = '<a class="btn btn--ghost btn--sm" href="/index.html">На главную</a>';
    if (user) {
      var name = user.username || '?';
      right =
        '<span class="adm-top__who">' + window.api.esc(name) + '</span>' +
        '<a class="btn btn--ghost btn--sm" href="/appointments.html">Кабинет</a>' +
        '<button type="button" class="btn btn--secondary btn--sm" data-logout>Выйти</button>';
    } else {
      right =
        '<a class="btn btn--ghost btn--sm" href="/login.html">Войти</a>';
    }

    host.innerHTML =
      '<header class="adm-top">' +
        '<div class="container adm-top__inner">' +
          '<a class="brand" href="/index.html">' +
            '<span class="brand__dot" aria-hidden="true"></span>Ноготочки' +
          '</a>' +
          '<div class="adm-top__right">' + right + '</div>' +
        '</div>' +
      '</header>';

    var out = host.querySelector('[data-logout]');
    if (out) out.addEventListener('click', function () { window.api.logout(); });
  }

  function renderMenu() {
    var host = document.getElementById('admin-menu');
    if (!host) return;

    var here = currentPath();
    host.innerHTML =
      '<nav class="adm-menu" aria-label="Разделы панели">' +
        SECTIONS.map(function (s) {
          return '<a class="adm-menu__link"' +
            (s.href === here ? ' aria-current="page"' : '') +
            ' href="' + s.href + '">' + s.label + '</a>';
        }).join('') +
      '</nav>';
  }

  window.api.me().then(function (user) {
    renderHeader(user);
    // Клиенту меню не показываем. Настоящая защита — на сервере: страницу он
    // всё равно не получил бы.
    if (isAdmin(user)) renderMenu();
  });
})();