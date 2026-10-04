'use strict';

// Общий помощник боевого фронтенда (web/): запросы с кукой-сессией, показ
// ошибок текстом, форматирование. Сессия живёт на сервере (httpOnly-кука,
// ставится при входе/регистрации) — токен на клиенте НЕ хранится ни в
// localStorage, ни в памяти. Запросы идут на тот же origin, что сервит
// страницы (Express раздаёт web/), поэтому CORS не нужен.

(function () {
  var SALON_OFFSET_MINUTES = 180; // UTC+3, как lib/time.js на бэкенде

  function pad(n) { return String(n).padStart(2, '0'); }

  window.api = {
    // Текущий пользователь по сессии (кука). Не залогинен → null.
    me: function () {
      return fetch('/api/auth/me').then(function (res) {
        if (!res.ok) return null;
        return res.json().catch(function () { return null; });
      }).then(function (data) {
        return data && data.user ? data.user : null;
      });
    },

    // Выход: сервер отзывает сессию и снимает куку.
    logout: function () {
      fetch('/api/auth/logout', { method: 'POST' }).catch(function () {});
      window.location.href = 'login.html';
    },

    // Универсальный запрос. Кука уходит автоматически (same-origin).
    // При ошибке выводит текст в элемент #error и бросает исключение
    // с полями status/code/data.
    request: function (path, opts) {
      opts = opts || {};
      var headers = Object.assign({}, opts.headers || {});
      if (opts.json !== undefined) headers['Content-Type'] = 'application/json';

      return fetch(path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok) {
            var msg = (data && data.error && data.error.message) || ('Ошибка запроса: ' + res.status);
            // Ближайшие свободные окна приходят и при 409 на удержание, и при 409
            // на создание записи — показываем их в тексте ошибки в обоих случаях
            if (data && data.error && Array.isArray(data.error.nearest_free) && data.error.nearest_free.length) {
              msg = msg + '\n' + data.error.nearest_free
                .map(function (s) { return window.api.fmt(s.starts_at); })
                .join(', ');
            }
            var err = new Error(msg);
            err.status = res.status;
            err.code = data && data.error && data.error.code;
            err.data = data;
            window.ui.error(err.message);
            throw err;
          }
          return data;
        });
      });
    },

    // Копейки -> «1 200 ₽»
    rub: function (kop) {
      var rub = Number(kop || 0) / 100;
      return rub.toFixed(rub % 1 === 0 ? 0 : 2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' \u20bd';
    },

    // Минуты -> «1 ч 30 мин» / «40 мин» (длительности приходят с сервера)
    duration: function (minutes) {
      var m = Number(minutes || 0);
      var h = Math.floor(m / 60);
      var rest = m % 60;
      if (!h) return rest + ' мин';
      return h + ' ч' + (rest ? ' ' + rest + ' мин' : '');
    },

    // Услуги записи. Сервер отдаёт набор services (запись может закрывать
    // несколько услуг); поле service — первая услуга, остаётся для совместимости
    // со старыми ответами. Итоги — по набору.
    servicesOf: function (booking) {
      var list = booking && Array.isArray(booking.services) && booking.services.length
        ? booking.services
        : (booking && booking.service ? [booking.service] : []);
      var sum = function (field) {
        return list.reduce(function (acc, s) { return acc + Number(s[field] || 0); }, 0);
      };
      return {
        list: list,
        names: list.map(function (s) { return s.name; }).join(' + '),
        minutes: booking && booking.total_duration_minutes !== undefined
          ? booking.total_duration_minutes : sum('duration_minutes'),
        price: booking && booking.total_price_kopecks !== undefined
          ? booking.total_price_kopecks : sum('price_kopecks'),
      };
    },

    // UTC ISO -> время салона «HH:MM»
    hour: function (iso) {
      var d = new Date(new Date(iso).getTime() + SALON_OFFSET_MINUTES * 60000);
      return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
    },

    // UTC ISO -> «ДД.ММ.ГГГГ»
    day: function (iso) {
      var d = new Date(new Date(iso).getTime() + SALON_OFFSET_MINUTES * 60000);
      return pad(d.getUTCDate()) + '.' + pad(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear();
    },

    // UTC ISO -> «ДД.ММ.ГГГГ HH:MM»
    fmt: function (iso) {
      return window.api.day(iso) + ' ' + window.api.hour(iso);
    },

    // Сегодняшний календарный день салона: «YYYY-MM-DD»
    todaySalon: function () {
      return new Date(Date.now() + SALON_OFFSET_MINUTES * 60000).toISOString().slice(0, 10);
    },

    // значения <input type="datetime-local"> (салонное время) -> ISO +03:00
    inputToIso: function (value) {
      if (!value) return null;
      return value + ':00+03:00';
    },

    // datetime-local из ISO (для подстановки в форму переноса)
    isoToInput: function (iso) {
      var d = new Date(new Date(iso).getTime() + SALON_OFFSET_MINUTES * 60000);
      return d.toISOString().slice(0, 16);
    },

    // HTML-экранирование пользовательских строк
    esc: function (s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
  };

  // Словари статусов (те же, что в черновом фронтенде)
  window.BOOKING_STATUS = {
    wait: 'Ожидает',
    confirmed: 'Подтверждена',
    done: 'Выполнена',
    canceled: 'Отменена'
  };
  window.FEEDBACK_STATUS = { new: 'Новое', read: 'Прочитано', answered: 'Отвечено' };

  // Сообщения на странице: #error (красный) и #ok (зелёный)
  window.ui = {
    isTarget: function (id) { return !!document.getElementById(id); },
    error: function (msg) {
      var el = document.getElementById('error');
      if (el) { el.textContent = msg; el.hidden = false; }
      console.error('[api] ' + msg);
    },
    ok: function (msg) {
      var el = document.getElementById('ok');
      if (el) { el.textContent = msg; el.hidden = false; }
    },
    clear: function () {
      [{ id: 'error' }, { id: 'ok' }].forEach(function (x) {
        var el = document.getElementById(x.id);
        if (el) el.hidden = true;
      });
    },
    // Внутренний путь вида «booking.html?service=1». Всё, что не похоже на
    // файл внутри web/ (http://, //внешний.хост, ../), отбрасывается —
    // иначе через returnTo можно было бы увести клиента на чужой сайт.
    safePath: function (value, fallback) {
      var v = String(value == null ? '' : value);
      return /^[\w.\-]+\.html(\?[\w.\-=&%]*)?$/.test(v) ? v : fallback;
    },
    // Куда отправить после входа: владельцу — раздел администратора,
    // остальным — кабинет клиента. Роль приходит списком, поэтому проверяем
    // НАЛИЧИЕ 'owner', а не равенство: у пользователя может быть несколько ролей.
    homeFor: function (user) {
      var roles = user && Array.isArray(user.roles) ? user.roles : [];
      return roles.indexOf('owner') !== -1 ? '/admin' : 'appointments.html';
    },
    // Куда отправить после успешного входа/регистрации: адрес из returnTo,
    // иначе cabinet (fallback подставляет вызывающий — см. homeFor).
    afterAuth: function (fallback) {
      var q = new URLSearchParams(window.location.search).get('returnTo');
      window.location.href = window.ui.safePath(q, fallback || 'appointments.html');
    }
  };
})();