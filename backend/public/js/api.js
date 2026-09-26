'use strict';

// Общий помощник для чернового фронтенда: токен, запросы, сообщения об ошибках,
// форматирование. Все запросы идут на тот же origin, что сервит статику
// (Express: backend/public), поэтому CORS не нужен.

(function () {
  var TOKEN_KEY = 'nogotki_token';
  var USER_KEY = 'nogotki_user';
  var SALON_OFFSET_MINUTES = 180; // UTC+3, как lib/time.js на бэкенде

  function pad(n) { return String(n).padStart(2, '0'); }

  function getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY)) || null; } catch (e) { return null; }
  }

  function clearAuth() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  window.api = {
    token: function () { return localStorage.getItem(TOKEN_KEY); },
    user: getUser,
    isAuthed: function () { return !!localStorage.getItem(TOKEN_KEY); },
    hasRole: function (role) {
      var u = getUser();
      return !!(u && u.roles && u.roles.indexOf(role) !== -1);
    },
    saveAuth: function (token, u) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(u));
    },
    clearAuth: clearAuth,
    logout: function () {
      var headers = { 'Authorization': 'Bearer ' + window.api.token() };
      fetch('/api/auth/logout', { method: 'POST', headers: headers }).catch(function () {});
      clearAuth();
      window.location.href = 'index.html';
    },

    // Универсальный запрос. При ошибке выводит текст в элемент #error (страница),
    // а также бросает исключение с полями status/code/data.
    request: function (path, opts) {
      opts = opts || {};
      var headers = Object.assign({}, opts.headers || {});
      if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
      var t = window.api.token();
      if (t) headers['Authorization'] = 'Bearer ' + t;

      return fetch(path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok) {
            var msg = (data && data.error && data.error.message) || ('Ошибка запроса: ' + res.status);
            if (data && data.error && data.error.code === 'SLOT_BUSY' && Array.isArray(data.error.nearest_free)) {
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

  // Сообщения на странице: #error (красный) и #ok (зелёный)
  window.ui = {
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
    }
  };

  // Редирект на вход, если токена нет
  window.requireAuth = function () {
    if (!window.api.isAuthed()) {
      window.location.href = 'index.html';
      return false;
    }
    return true;
  };
})();

window.BOOKING_STATUS = {
  wait: 'Ожидает',
  confirmed: 'Подтверждена',
  done: 'Выполнена',
  canceled: 'Отменена'
};
window.FEEDBACK_STATUS = { new: 'Новое', read: 'Прочитано', answered: 'Отвечено' };