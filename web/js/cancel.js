'use strict';

// Отмена записи клиентом: одно место для правил и модального окна на всех
// экранах кабинета (список и детали). Страницы не дублируют текст правил —
// они зовут window.cancelBooking(), а сколько часов до визита ещё можно
// отменить «бесплатно», приезжает из GET /api/studio (настройка студии),
// поэтому смена правила владельцем не требует правки фронтенда.

(function () {
  var HOURS_CACHE = null; // один запрос на страницу: правило одно для всех карточек

  function studioPolicy() {
    if (HOURS_CACHE) return HOURS_CACHE;
    HOURS_CACHE = window.api
      .request('/api/studio')
      .then(function (d) {
        return { hours: d && d.studio ? Number(d.studio.free_cancel_hours || 0) : 0, studio: d && d.studio };
      })
      .catch(function () {
        // Правило не приехало — показываем нейтральную формулировку, но отмену
        // не блокируем: решение клиента принимает он, а не сеть.
        return { hours: 12, studio: null };
      });
    return HOURS_CACHE;
  }

  // Сколько часов до визита. Отрицательное значение (визит уже начался) —
  // это тоже «меньше порога», то есть предупреждение.
  function hoursLeft(booking) {
    return (new Date(booking.starts_at).getTime() - Date.now()) / 3600000;
  }

  // Правило целиком для модалки: обычный случай и предупреждение «в последний
  // момент» — это два состояния одного правила, а не разные правила.
  function policy(booking, hours) {
    var left = hoursLeft(booking);
    var isLate = hours === 0 || left < hours;
    if (hours === 0) {
      return {
        isLate: true,
        title: 'Отменить запись?',
        text:
          'Правило бесплатной отмены студией не установлено, поэтому отмена возможна в любой момент, ' +
          'но занятое время уже не вернуть в расписание мастера.',
        warn: isLate ? 'До визита осталось ' + leftText(left) + '. Отмена в последний момент.' : null,
      };
    }
    if (isLate) {
      return {
        isLate: true,
        title: 'Отменить запись?',
        text:
          'Бесплатная отмена доступна не позднее чем за ' + hours + ' ' + plural(hours, 'час', 'часа', 'часов') +
          ' до визита. Позже отмена возможна, но занятое время у мастера уже не вернуть в расписание — ' +
          'уточните последствия по телефону студии.',
        warn: 'До визита осталось ' + leftText(left) + ' — это меньше ' + hours + ' ' + plural(hours, 'часа', 'часов', 'часов') + '.',
      };
    }
    return {
      isLate: false,
      title: 'Отменить запись?',
      text:
        'Вы успеваете: бесплатная отмена доступна не позднее чем за ' + hours + ' ' +
        plural(hours, 'час', 'часа', 'часов') + ' до визита. Слот освободится для других клиентов.',
      warn: null,
    };
  }

  function leftText(hoursLeftValue) {
    var m = Math.max(1, Math.round(hoursLeftValue * 60));
    var h = Math.floor(m / 60);
    var rest = m % 60;
    if (h <= 0) return rest + ' мин';
    if (!rest) return h + ' ' + plural(h, 'час', 'часа', 'часов');
    return h + ' ' + plural(h, 'час', 'часа', 'часов') + ' ' + rest + ' мин';
  }

  function plural(n, one, few, many) {
    var m = Math.abs(n) % 100;
    var d = m % 10;
    if (m > 10 && m < 20) return many;
    if (d > 1 && d < 5) return few;
    if (d === 1) return one;
    return many;
  }

  function stamp(booking) {
    return window.api.fmt(booking.starts_at) + '—' + window.api.hour(booking.ends_at);
  }

  function names(booking) {
    return window.api.servicesOf(booking).names;
  }

  // Модалка одна на страницу: переиспользуется при отмене разных записей.
  function ensureModal() {
    var el = document.getElementById('cancelModal');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'cancelModal';
    el.className = 'modal-backdrop';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'cancelModalTitle');
    el.innerHTML =
      '<div class="modal">' +
        '<h3 id="cancelModalTitle"></h3>' +
        // Класс .modal__body нужен узкому экрану: текст правила прокручивается
        // внутри окна, а кнопки остаются на виду
        '<div class="modal__body" id="cancelModalBody"></div>' +
        '<div class="modal__actions">' +
          '<button type="button" class="btn btn--ghost btn--md" id="cancelKeep">Не отменять</button>' +
          '<button type="button" class="btn btn--primary btn--md" id="cancelConfirm" ' +
            'data-idle-label="Отменить запись">Отменить запись</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    return el;
  }

  // onDone(result) — после успешной отмены, result = booking.
  // onError(err) — после неудачи (текст уже показан в #error страницей).
  function open(booking, handlers) {
    handlers = handlers || {};
    studioPolicy().then(function (p) {
      var rules = policy(booking, p.hours);
      var el = ensureModal();
      el.querySelector('#cancelModalTitle').textContent = rules.title;
      var body = el.querySelector('#cancelModalBody');
      body.innerHTML =
        '<p class="modal__when">' + window.api.esc(stamp(booking)) + ' · ' + window.api.esc(names(booking)) + '</p>' +
        '<p class="modal__text">' + window.api.esc(rules.text) + '</p>' +
        (rules.warn
          ? '<div class="alert alert--warning" id="cancelWarn">' + window.api.esc(rules.warn) +
            (p.studio && p.studio.phone ? '<br>Телефон студии: ' + window.api.esc(p.studio.phone) : '') +
            '</div>'
          : '');
      el.hidden = false;
      document.body.classList.add('is-modal-open');
      el.querySelector('#cancelKeep').focus();

      var close = function () {
        el.hidden = true;
        document.body.classList.remove('is-modal-open');
        el.querySelector('#cancelConfirm').onclick = null;
        el.querySelector('#cancelKeep').onclick = null;
        el.onclick = null;
        document.removeEventListener('keydown', onKey);
      };
      var onKey = function (e) { if (e.key === 'Escape') close(); };

      el.querySelector('#cancelKeep').onclick = close;
      el.onclick = function (e) { if (e.target === el) close(); };
      document.addEventListener('keydown', onKey);

      // Отмена уходит только когда клиент нажал «Отменить запись». Пока он
      // читает правило и жмёт «Не отменять» (или закрывает окно), запись
      // остаётся активной: окно спрашивает, а не решает за него.
      var btn = el.querySelector('#cancelConfirm');
      btn.disabled = false;
      btn.textContent = btn.dataset.idleLabel;
      btn.onclick = function () {
        // Повторное нажатие во время запроса не должно слать второй POST.
        btn.disabled = true;
        btn.textContent = 'Отменяем…';
        window.api
          .request('/api/bookings/' + encodeURIComponent(booking.id) + '/cancel', { method: 'POST' })
          .then(function (d) {
            close();
            if (handlers.onDone) handlers.onDone(d.booking);
          })
          .catch(function (err) {
            btn.disabled = false;
            btn.textContent = btn.dataset.idleLabel;
            close();
            // 400/409 — запись уже не активна: это не ошибка сети, а изменение
            // состояния, поэтому показываем свой текст, а не серверный 400.
            if (err.status === 400 || err.status === 404 || err.status === 409) {
              window.ui.error('Эту запись уже нельзя отменить — возможно, она отменена или прошла.');
              if (handlers.onError) handlers.onError(err);
              return;
            }
            if (handlers.onError) handlers.onError(err);
          });
      };
    });
  }

  window.cancelBooking = { open: open, policy: policy, hoursLeft: hoursLeft, studioPolicy: studioPolicy };
})();
