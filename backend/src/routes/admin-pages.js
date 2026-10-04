'use strict';

// Страницы раздела администратора: /admin, /admin/bookings, /admin/services,
// /admin/masters.
//
// Проверка прав живёт ЗДЕСЬ, на сервере, а не в интерфейсе. Роутер монтируется
// в app.js ДО express.static(web) — и это обязательно: иначе статика отдала бы
// файлы раздела любому посетителю, и прятать пункт меню было бы единственной
// защитой. Не владелец получает 403 и страницу denied.html.
//
// Роли приходят из user_roles при КАЖДОМ запросе (middleware/auth.js) и
// проверяются на НАЛИЧИЕ в списке через hasRole(), а не на равенство:
// у пользователя может быть несколько ролей.

const express = require('express');
const path = require('path');

const { authenticate, hasRole } = require('../middleware/auth');

const ADMIN_ROLE = 'owner';

const WEB_ROOT = path.join(__dirname, '..', '..', '..', 'web');
const ADMIN_DIR = path.join(WEB_ROOT, 'admin');
const DENIED_FILE = path.join(ADMIN_DIR, 'denied.html');

// Только эти страницы. Имя файла берётся из таблицы, а не из запроса,
// поэтому выйти из каталога через «..» невозможно.
const PAGES = {
  '/': 'index.html',
  '/bookings': 'bookings.html',
  '/services': 'services.html',
  '/masters': 'masters.html',
};

// Гейт раздела. Стоит первым, поэтому под /admin/* не проходит никто без роли
// owner — включая неизвестные пути внутри раздела: до статики они не дойдут.
function requireOwnerPage(req, res, next) {
  const user = authenticate(req);
  if (!user || !hasRole(user, ADMIN_ROLE)) {
    return res.status(403).sendFile(DENIED_FILE);
  }
  req.user = user;
  return next();
}

function sendPage(name) {
  return function (req, res) {
    return res.sendFile(path.join(ADMIN_DIR, name));
  };
}

const section = express.Router();

section.use(requireOwnerPage);
section.get('/', sendPage(PAGES['/']));
section.get('/bookings', sendPage(PAGES['/bookings']));
section.get('/services', sendPage(PAGES['/services']));
section.get('/masters', sendPage(PAGES['/masters']));

// Адрес с расширением -> чистый адрес раздела.
['bookings', 'services', 'masters'].forEach(function (name) {
  section.get('/' + name + '.html', function (req, res) {
    res.redirect(302, '/admin/' + name);
  });
});

// Владелец спросил неизвестную страницу раздела. Дальше — намеренно НЕ
// next(): иначе запрос ушёл бы в express.static(web) и отдал бы файл мимо гейта.
section.use(function (req, res) {
  res.status(404).json({
    error: { message: 'Страница раздела «' + req.path + '» не найдена.', code: 'NOT_FOUND' },
  });
});

const router = express.Router();

// Префикс '/admin' в app.use() матчится по границе сегмента, поэтому
// '/administrator' под него не попадает.
router.use('/admin', section);

// Одностраничная панель прошлой итерации (web/admin.html) — тоже за гейтом,
// иначе это была бы незакрытая административная страница.
router.get('/admin.html', requireOwnerPage, function (req, res) {
  res.sendFile(path.join(WEB_ROOT, 'admin.html'));
});

module.exports = router;