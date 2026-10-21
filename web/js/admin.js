'use strict';

// Логика панели владельца (web/admin.html). Разделы — состояния одной
// страницы, поэтому загрузчики разделов вызываются лениво: при первом открытии
// «Записей» ещё не нужны ни расписание, ни прайс, и лишние запросы только
// замедляют открытие.
//
// Все эндпоинты — /api/admin/*, доступ только владельцу: роль проверяется
// здесь до первого запроса, а сервер проверяет её же на каждом маршруте.

(function () {
  var $ = function (id) { return document.getElementById(id); };

  // Дни недели в том же порядке, что и в backend/lib/availability.js:
  // salonWeekday() = getUTCDay() в салонном времени, 0 = воскресенье.
  var WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  var BLOCK_REASONS = {
    break: 'Перерыв', day_off: 'Выходной', vacation: 'Отпуск', sick: 'Болезнь', other: 'Другое'
  };

  // Смена статуса доступна только вперёд по lifecycle: подтвердить ожидание,
  // закрыть визит, отменить. Возврат из «выполнена» в «подтверждена» — ошибка
  // владельца, а не штатная операция.
  var NEXT_STATUS = {
    wait: [{ to: 'confirmed', label: 'Подтвердить', cls: 'btn--primary' },
           { to: 'canceled', label: 'Отменить', cls: 'btn--ghost' }],
    confirmed: [{ to: 'done', label: 'Выполнена', cls: 'btn--secondary' },
                { to: 'canceled', label: 'Отменить', cls: 'btn--ghost' }],
    done: [],
    canceled: []
  };

  var state = {
    masters: [],
    services: [],
    bookings: [],
    total: 0,
    offset: 0,
    limit: 25,
    loadedBookings: false,
    busyId: null,
    scheduleMasterId: null,
    loaded: {}
  };

  // ---------- даты и форматирование ----------

  // Дата фильтра «YYYY-MM-DD» -> момент начала суток салона в UTC ISO.
  // Правая граница в API исключающая (starts_at < to), поэтому день «по»
  // отправляем как начало СЛЕДУЮЩИХ суток, иначе 1 октября пропала бы.
  function dayStartIso(day) { return day + 'T00:00:00+03:00'; }

  function nextDayIso(day) {
    // Считаем по календарной дате, а не по UTC: салон живёт на +03:00, и
    // прибавление суток к «2026-10-01T00:00:00+03:00» в UTC съело бы день
    // назад (локальная полночь — это 21:00 предыдущих суток по UTC).
    return addDays(day, 1) + 'T00:00:00+03:00';
  }

  function addDays(day, n) {
    var p = day.split('-');
    var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n));
    return d.toISOString().slice(0, 10);
  }

  // Минуты от полуночи -> «HH:MM» для <input type="time">.
  function hm(minutes) {
    var m = Number(minutes);
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }

  // «HH:MM» -> минуты. Пустая/битая строка даёт null, чтобы отсечь её на
  // валидации, а не отправить 0 и тихо получить неверное расписание.
  function toMinutes(value) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
    if (!m) return null;
    var h = Number(m[1]);
    var min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  // Блокировки приходят в салонном локальном времени строкой
  // «YYYY-MM-DD HH:MM:SS» — это уже готовое время салона, конвертировать
  // в UTC не нужно (иначе сдвинулось бы на 3 часа).
  function fmtDbLocal(value) {
    var s = String(value || '');
    if (s.length < 16) return s;
    var d = s.slice(0, 10).split('-');
    return d[2] + '.' + d[1] + '.' + d[0] + ' ' + s.slice(11, 16);
  }

  // ---------- мелкие помощники разметки ----------

  function statTile(label, value) {
    return '<div class="adm-stat"><span class="adm-stat__value">' + window.api.esc(value) +
      '</span><span class="adm-stat__label">' + window.api.esc(label) + '</span></div>';
  }

  function cell(text, cls) {
    return '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + text + '</td>';
  }

  function badge(status) {
    return tag(status, window.BOOKING_STATUS[status] || status);
  }

  // Бейдж с любым текстом: берём палитру из badge--*, а подпись задаём сами —
  // для услуг и мастеров это «Активна»/«Выключена», а не словарь статусов.
  function tag(cls, text) {
    return '<span class="badge badge--' + window.api.esc(cls) + '">' + window.api.esc(text) + '</span>';
  }

  // Диалог подтверждения для разрушающих действий (удаление услуги/мастера,
  // снятие блокировки). Возвращает Promise<boolean>.
  function confirmDialog(title, text, okLabel) {
    return new Promise(function (resolve) {
      var el = $('admModal');
      if (!el) {
        el = document.createElement('div');
        el.id = 'admModal';
        el.className = 'modal-backdrop';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.innerHTML =
          '<div class="modal">' +
            '<h3 id="admModalTitle"></h3>' +
            '<p class="modal__text" id="admModalText"></p>' +
            '<div class="modal__actions">' +
              '<button type="button" class="btn btn--ghost btn--md" id="admModalNo">Отмена</button>' +
              '<button type="button" class="btn btn--primary btn--md" id="admModalYes"></button>' +
            '</div>' +
          '</div>';
        document.body.appendChild(el);
      }
      el.querySelector('#admModalTitle').textContent = title;
      el.querySelector('#admModalText').textContent = text;
      el.querySelector('#admModalYes').textContent = okLabel;
      el.hidden = false;
      document.body.classList.add('is-modal-open');
      el.querySelector('#admModalNo').focus();

      function close(answer) {
        el.hidden = true;
        document.body.classList.remove('is-modal-open');
        el.querySelector('#admModalYes').onclick = null;
        el.querySelector('#admModalNo').onclick = null;
        el.onclick = null;
        document.removeEventListener('keydown', onKey);
        resolve(answer);
      }
      function onKey(e) { if (e.key === 'Escape') close(false); }

      el.querySelector('#admModalNo').onclick = function () { close(false); };
      el.querySelector('#admModalYes').onclick = function () { close(true); };
      el.onclick = function (e) { if (e.target === el) close(false); };
      document.addEventListener('keydown', onKey);
    });
  }

  // ---------- разделы ----------

  var TABS = ['overview', 'bookings', 'schedule', 'services', 'masters', 'feedback', 'rules'];

  function showTab(name) {
    if (TABS.indexOf(name) === -1) name = 'overview';
    state.tab = name;
    TABS.forEach(function (t) {
      $('tab-' + t).hidden = t !== name;
      var btn = document.querySelector('.tabs__tab[data-tab="' + t + '"]');
      if (btn) btn.setAttribute('aria-selected', String(t === name));
    });
    window.ui.clear();
    if (name === 'schedule') ensureTab('schedule', loadSchedule);
    if (name === 'services') ensureTab('services', loadServices);
    if (name === 'masters') ensureTab('masters', loadMasters);
    if (name === 'feedback') ensureTab('feedback', loadFeedback);
    if (name === 'bookings' && !state.loadedBookings) loadBookings();
  }

  function ensureTab(key, loader) {
    if (state.loaded[key]) return;
    state.loaded[key] = true;
    loader();
  }

  // ---------- дашборд ----------

  function loadStats() {
    return window.api.request('/api/admin/stats').then(function (s) {
      $('stats').innerHTML =
        statTile('Всего записей', s.total_bookings) +
        statTile('Активных', s.active_bookings) +
        statTile('Сумма активных', window.api.rub(s.active_sum_kopecks)) +
        statTile('Мастеров', s.masters_count);
      $('stats').hidden = false;
    });
  }

  function periodQuery() {
    var p = [];
    var from = $('pFrom').value;
    var to = $('pTo').value;
    if (from) p.push('from=' + encodeURIComponent(dayStartIso(from)));
    // Правая граница исключающая, поэтому «по» — начало следующих суток.
    if (to) p.push('to=' + encodeURIComponent(nextDayIso(to)));
    return p.length ? '?' + p.join('&') : '';
  }

  function loadPeriod() {
    return window.api.request('/api/admin/stats/period' + periodQuery()).then(function (s) {
      $('periodStats').innerHTML =
        statTile('Записей за период', s.total_bookings) +
        statTile('Активных', s.active_bookings) +
        statTile('Выполнено', s.done_bookings) +
        statTile('Отменено', s.canceled_bookings) +
        statTile('Сумма за период', window.api.rub(s.total_sum_kopecks));
      $('periodStats').hidden = false;
      renderMasterBars(s.by_master || []);
      renderDayBars(s.by_day || []);
    });
  }

  // Столбики без библиотеки графиков: ширина = доля от максимума. Максимум
  // берём по данным выборки, поэтому один «пиковый» день не превращает все
  // остальные в невидимые полоски.
  function bar(value, max, label, side) {
    var pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
    return '<div class="adm-bar">' +
      '<div class="adm-bar__head"><span class="adm-bar__label">' + label + '</span>' +
      '<span class="adm-bar__value">' + side + '</span></div>' +
      '<div class="adm-bar__track"><div class="adm-bar__fill" style="width:' + pct + '%"></div></div>' +
    '</div>';
  }

  function renderMasterBars(list) {
    var box = $('byMaster');
    if (!list.length) { box.innerHTML = '<p class="hint">За период нет ни одной записи.</p>'; return; }
    var max = list.reduce(function (acc, m) { return Math.max(acc, m.bookings); }, 0);
    box.innerHTML = list.map(function (m) {
      return bar(m.bookings, max,
        window.api.esc(m.name) + ' · ' + m.bookings + ' ' + plural(m.bookings, 'запись', 'записи', 'записей') + ' · ' + window.api.rub(m.sum_kopecks),
        '');
    }).join('');
  }

  function renderDayBars(list) {
    var box = $('byDay');
    if (!list.length) { box.innerHTML = '<p class="hint">За период нет ни одной записи.</p>'; return; }
    var max = list.reduce(function (acc, d) { return Math.max(acc, d.sum_kopecks); }, 0);
    box.innerHTML = list.map(function (d) {
      var p = d.day.split('-');
      return bar(d.sum_kopecks, max,
        '<span title="' + window.api.esc(fmtDbLocal(d.day + ' 00:00:00')) + '">' + p[2] + '.' + p[1] + '</span> · ' +
          d.bookings + ' ' + plural(d.bookings, 'запись', 'записи', 'записей'),
        window.api.rub(d.sum_kopecks));
    }).join('');
  }

  function plural(n, one, few, many) {
    var m10 = n % 10;
    var m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  // ---------- записи ----------

  function bookingsQuery() {
    var p = ['limit=' + state.limit, 'offset=' + state.offset];
    var status = $('fStatus').value;
    var masterId = $('fMaster').value;
    var from = $('fFrom').value;
    var to = $('fTo').value;
    if (status) p.push('status=' + encodeURIComponent(status));
    if (masterId) p.push('master_id=' + encodeURIComponent(masterId));
    if (from) p.push('from=' + encodeURIComponent(dayStartIso(from)));
    if (to) p.push('to=' + encodeURIComponent(nextDayIso(to)));
    return '?' + p.join('&');
  }

  function renderRow(b) {
    var services = window.api.servicesOf(b);
    var when = '<strong>' + window.api.fmt(b.starts_at) + '</strong>' +
      '<span class="adm-sub">' + window.api.hour(b.ends_at) + ' · ' +
      window.api.duration(services.minutes) + '</span>';
    var client = '<strong>' + window.api.esc(b.client.name) + '</strong>' +
      '<span class="adm-sub">' + window.api.esc(b.client.phone || '—') + '</span>';

    var actions = (NEXT_STATUS[b.status] || []).map(function (a) {
      return '<button type="button" class="btn btn--sm ' + a.cls + '" data-booking="' + b.id +
        '" data-status="' + a.to + '"' + (state.busyId === b.id ? ' disabled' : '') + '>' +
        window.api.esc(a.label) + '</button>';
    }).join(' ');

    return '<tr>' + cell(when, 'adm-when') + cell(client) +
      cell('<span class="adm-sub">' + window.api.esc(services.names) + '</span>') +
      cell(window.api.esc(b.master.name)) + cell(window.api.rub(services.price)) +
      cell(badge(b.status)) + cell(actions || '<span class="adm-sub">—</span>', 'adm-actions') + '</tr>';
  }

  function renderBookings() {
    var has = state.bookings.length > 0;
    $('tableWrap').hidden = !has;
    $('empty').hidden = has;
    if (has) {
      $('rows').innerHTML = state.bookings.map(renderRow).join('');
    } else {
      $('rows').innerHTML = '';
      // Пустой список и неудачная загрузка — разные состояния: в первом
      // случае визиты есть, их просто не подошёл фильтр, во втором
      // владелец ещё ничего не видел и «сбросьте фильтры» его сбило бы.
      $('emptyText').textContent = state.loadedBookings
        ? 'Под фильтры ничего не нашлось — смените условия или сбросьте их'
        : 'Записи не загрузились — обновите страницу или попробуйте позже';
    }
    renderPager();
  }

  function renderPager() {
    var total = state.total;
    var pager = $('pager');
    // Постраничный список нужен владельцу, у которого записей много; при
    // пустом результате подвал с «1–0 из 0» только путает.
    if (!total || state.tab !== 'bookings') { pager.hidden = true; return; }
    var from = state.offset + 1;
    var to = Math.min(state.offset + state.limit, total);
    $('pagerInfo').textContent = 'Показано ' + from + '–' + to + ' из ' + total;
    $('pagePrev').disabled = state.offset === 0;
    $('pageNext').disabled = to >= total;
    pager.hidden = false;
  }

  function loadBookings() {
    $('loading').hidden = false;
    $('tableWrap').hidden = true;
    $('empty').hidden = true;
    return window.api.request('/api/admin/bookings' + bookingsQuery()).then(function (r) {
      state.bookings = r.bookings || [];
      state.total = Number(r.total || 0);
      state.loadedBookings = true;
      $('loading').hidden = true;
      renderBookings();
    }).catch(function (err) {
      $('loading').hidden = true;
      if (err.status === 401) { window.location.replace('login.html?returnTo=admin.html'); return; }
      if (err.status === 403) { renderForbidden(err.message); return; }
      renderBookings();
    });
  }

  function resetBookings() {
    $('fStatus').value = '';
    $('fMaster').value = '';
    $('fFrom').value = '';
    $('fTo').value = '';
    state.offset = 0;
    window.ui.clear();
    loadBookings();
  }

  // Владелец закрывает запись руками: PATCH меняет статус и возвращает
  // запись — список и цифры перечитываем, чтобы на экране не осталось
  // старой строки из памяти.
  function setStatus(id, status) {
    state.busyId = id;
    renderBookings();
    return window.api.request('/api/admin/bookings/' + id, {
      method: 'PATCH', json: { status: status }
    }).then(function (r) {
      var b = r.booking;
      window.ui.ok('Запись №' + b.id + ': ' + window.BOOKING_STATUS[b.status].toLowerCase() + '.');
      return Promise.all([loadBookings(), loadStats()]);
    }).catch(function (err) {
      if (err.status === 403) { renderForbidden(err.message); return; }
      return loadBookings();
    }).then(function () {
      state.busyId = null;
      renderBookings();
    });
  }

  // ---------- расписание мастера ----------

  function renderWeekRows(schedule) {
    var byDay = {};
    (schedule || []).forEach(function (row) { byDay[row.weekday] = row; });
    $('week').innerHTML = WEEKDAYS.map(function (name, day) {
      var row = byDay[day];
      return '<div class="adm-week__row' + (row ? ' is-on' : '') + '" data-weekday="' + day + '">' +
        '<label class="adm-week__day">' +
          '<input type="checkbox" data-day-on' + (row ? ' checked' : '') + ' /> ' + name +
        '</label>' +
        '<input type="time" class="adm-week__time" data-day-start value="' + hm(row ? row.start_minutes : 600) + '"' +
          (row ? '' : ' disabled') + ' aria-label="Начало работы: ' + name + '" />' +
        '<span class="adm-week__dash">—</span>' +
        '<input type="time" class="adm-week__time" data-day-end value="' + hm(row ? row.end_minutes : 1200) + '"' +
          (row ? '' : ' disabled') + ' aria-label="Конец работы: ' + name + '" />' +
      '</div>';
    }).join('');
  }

  function loadSchedule() {
    if (!state.masters.length) return;
    var sel = $('schMaster');
    sel.innerHTML = state.masters.map(function (m) {
      return '<option value="' + m.id + '">' + window.api.esc(m.name) +
        (m.is_active ? '' : ' (выключен)') + '</option>';
    }).join('');
    if (!state.scheduleMasterId || !sel.querySelector('option[value="' + state.scheduleMasterId + '"]')) {
      state.scheduleMasterId = state.masters[0].id;
    }
    sel.value = state.scheduleMasterId;
    loadScheduleFor();
    loadBlocks();
  }

  function loadScheduleFor() {
    if (!state.scheduleMasterId) return Promise.resolve();
    return window.api.request('/api/admin/masters/' + state.scheduleMasterId + '/schedule').then(function (r) {
      renderWeekRows(r.schedule);
    });
  }

  function saveSchedule() {
    if (!state.scheduleMasterId) return;
    var rows = [];
    var error = '';
    Array.prototype.forEach.call($('week').querySelectorAll('.adm-week__row'), function (rowEl) {
      var on = rowEl.querySelector('[data-day-on]');
      if (!on.checked) return;
      var start = toMinutes(rowEl.querySelector('[data-day-start]').value);
      var end = toMinutes(rowEl.querySelector('[data-day-end]').value);
      var day = WEEKDAYS[Number(rowEl.dataset.weekday)];
      if (start === null || end === null) { error = 'Проверьте время в строке «' + day + '»: нужен формат ЧЧ:ММ.'; return; }
      if (end <= start) { error = 'В строке «' + day + '» конец должен быть позже начала.'; return; }
      rows.push({ weekday: Number(rowEl.dataset.weekday), start_minutes: start, end_minutes: end });
    });
    if (error) { window.ui.error(error); return; }

    return window.api.request('/api/admin/masters/' + state.scheduleMasterId + '/schedule', {
      method: 'PUT', json: { schedule: rows }
    }).then(function (r) {
      renderWeekRows(r.schedule);
      window.ui.ok('Расписание сохранено: рабочих дней — ' + (r.schedule || []).length + '.');
    });
  }

  function loadBlocks() {
    if (!state.scheduleMasterId) return;
    var p = [];
    var from = $('blocksFrom').value;
    var to = $('blocksTo').value;
    if (from) p.push('from=' + encodeURIComponent(dayStartIso(from)));
    if (to) p.push('to=' + encodeURIComponent(nextDayIso(to)));
    return window.api
      .request('/api/admin/masters/' + state.scheduleMasterId + '/work-blocks' + (p.length ? '?' + p.join('&') : ''))
      .then(function (r) {
        renderBlocks(r.work_blocks || []);
      });
  }

  function renderBlocks(list) {
    var box = $('blocks');
    if (!list.length) {
      box.innerHTML = '<p class="hint">В выбранном диапазоне перерывов и выходных нет.</p>';
      return;
    }
    box.innerHTML = list.map(function (b) {
      return '<div class="adm-block">' +
        '<div class="adm-block__when">' + window.api.esc(fmtDbLocal(b.starts_at)) + ' — ' +
          window.api.esc(fmtDbLocal(b.ends_at)) + '</div>' +
        '<div class="adm-block__reason">' + window.api.esc(BLOCK_REASONS[b.reason] || b.reason) + '</div>' +
        '<button type="button" class="btn btn--ghost btn--sm adm-block__del" data-block="' + b.id + '">Снять</button>' +
      '</div>';
    }).join('');
  }

  function addBlock(ev) {
    ev.preventDefault();
    if (!state.scheduleMasterId) return;
    var start = window.api.inputToIso($('bStart').value);
    var end = window.api.inputToIso($('bEnd').value);
    if (!start || !end) {
      window.ui.error('Укажите начало и конец перерыва.');
      return;
    }
    return window.api.request('/api/admin/masters/' + state.scheduleMasterId + '/work-blocks', {
      method: 'POST',
      json: { starts_at: start, ends_at: end, reason: $('bReason').value }
    }).then(function () {
      $('blockForm').reset();
      window.ui.ok('Время закрыто.');
      return loadBlocks();
    });
  }

  function deleteBlock(id) {
    return confirmDialog('Снять перерыв?', 'Клиенты снова смогут записываться в это время.', 'Снять')
      .then(function (yes) {
        if (!yes) return;
        return window.api.request('/api/admin/work-blocks/' + id, { method: 'DELETE' })
          .then(function () {
            window.ui.ok('Перерыв снят.');
            return loadBlocks();
          });
      });
  }

  // ---------- услуги ----------

  function loadServices() {
    return window.api.request('/api/admin/services').then(function (r) {
      state.services = r.services || [];
      renderServices();
      // Список услуг мастера обновляем только пока форма правки не открыта:
      // перерисовка посреди заполнения формы съела бы выбранные галочки.
      if (!$('masterId').value) renderMasterServices();
    });
  }

  function renderServices() {
    var rows = state.services.map(function (s) {
      return '<tr>' +
        cell('<strong>' + window.api.esc(s.name) + '</strong>' +
          (s.description ? '<span class="adm-sub">' + window.api.esc(s.description) + '</span>' : '')) +
        cell(window.api.duration(s.duration_minutes)) +
        cell(window.api.rub(s.price_kopecks)) +
        cell(s.is_active ? tag('confirmed', 'Активна') : tag('canceled', 'Выключена')) +
        cell('<button type="button" class="btn btn--secondary btn--sm" data-service-edit="' + s.id + '">Изменить</button>' +
             '<button type="button" class="btn btn--ghost btn--sm" data-service-del="' + s.id + '">Удалить</button>', 'adm-actions') +
      '</tr>';
    });
    $('serviceRows').innerHTML = rows.join('');
  }

  // Цена в интерфейсе в рублях, в API — в копейках. Округляем один раз здесь,
  // на сервере price_kopecks остаётся целым числом без surprise-округлений.
  function priceToKopecks(value) {
    var rub = Number(String(value).replace(',', '.'));
    if (!Number.isFinite(rub) || rub < 0) return null;
    return Math.round(rub * 100);
  }

  function resetServiceForm() {
    $('serviceId').value = '';
    $('serviceForm').reset();
    $('sActive').checked = true;
    $('serviceFormTitle').textContent = 'Новая услуга';
    $('serviceSubmit').textContent = 'Создать';
    $('serviceCancel').hidden = true;
  }

  function fillServiceForm(id) {
    var s = state.services.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!s) return;
    $('serviceId').value = s.id;
    $('sName').value = s.name;
    $('sDesc').value = s.description || '';
    $('sPrice').value = (s.price_kopecks / 100).toFixed(2).replace(/\.?0+$/, '');
    $('sDuration').value = s.duration_minutes;
    $('sActive').checked = !!s.is_active;
    $('serviceFormTitle').textContent = 'Услуга: ' + s.name;
    $('serviceSubmit').textContent = 'Сохранить';
    $('serviceCancel').hidden = false;
    $('sName').focus();
  }

  function submitService(ev) {
    ev.preventDefault();
    var id = $('serviceId').value;
    var kopecks = priceToKopecks($('sPrice').value);
    var duration = Number($('sDuration').value);
    if (kopecks === null) { window.ui.error('Цена должна быть числом от 0.'); return; }
    if (!Number.isInteger(duration) || duration <= 0) { window.ui.error('Длительность — целое число минут больше нуля.'); return; }

    var payload = {
      name: $('sName').value.trim(),
      description: $('sDesc').value.trim(),
      price_kopecks: kopecks,
      duration_minutes: duration,
      is_active: $('sActive').checked ? 1 : 0
    };
    if (!payload.name) { window.ui.error('Укажите название услуги.'); return; }

    var editing = !!id;
    return window.api.request(editing ? '/api/admin/services/' + id : '/api/admin/services', {
      method: editing ? 'PATCH' : 'POST', json: payload
    }).then(function (r) {
      window.ui.ok('Услуга сохранена: ' + r.service.name + '.');
      resetServiceForm();
      return loadServices();
    });
  }

  function deleteService(id) {
    var s = state.services.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!s) return;
    return confirmDialog(
      'Удалить услугу?',
      '«' + s.name + '» исчезнет из каталога. Если на неё есть записи, сервер не даст удалить — тогда выключите услугу.',
      'Удалить'
    ).then(function (yes) {
      if (!yes) return;
      return window.api.request('/api/admin/services/' + id, { method: 'DELETE' }).then(function () {
        window.ui.ok('Услуга удалена.');
        if ($('serviceId').value === String(id)) resetServiceForm();
        return loadServices();
      });
    });
  }

  // ---------- мастера ----------

  function loadMasters() {
    return window.api.request('/api/admin/masters').then(function (r) {
      state.masters = r.masters || [];
      renderMasters();
      if (state.tab === 'schedule') loadSchedule();
    });
  }

  function renderMasters() {
    $('masterRows').innerHTML = state.masters.map(function (m) {
      var services = (m.services || []).map(function (s) { return s.name; }).join(', ') || '—';
      return '<tr>' +
        cell('<strong>' + window.api.esc(m.name) + '</strong><span class="adm-sub">' + window.api.esc(m.role) + '</span>') +
        cell(m.experience_years ? m.experience_years + ' лет' : '—') +
        cell(m.bookings_count) +
        cell('<span class="adm-sub">' + window.api.esc(services) + '</span>') +
        cell(m.is_active ? tag('confirmed', 'Активен') : tag('canceled', 'Выключен')) +
        cell('<button type="button" class="btn btn--secondary btn--sm" data-master-edit="' + m.id + '">Изменить</button>' +
             '<button type="button" class="btn btn--ghost btn--sm" data-master-del="' + m.id + '">Удалить</button>', 'adm-actions') +
      '</tr>';
    }).join('');
    if (!$('masterId').value) renderMasterServices();
  }

  function renderMasterServices() {
    // Набор услуг мастера — это его рабочая матрица: подрядок, у которого
    // нет ни одной услуги, клиенту недоступен вообще.
    $('masterServices').innerHTML = state.services.length
      ? state.services.map(function (s) {
          return '<label class="adm-check adm-check--inline">' +
            '<input type="checkbox" value="' + s.id + '"' + (s.is_active ? '' : ' disabled') + ' /> ' +
            window.api.esc(s.name) + (s.is_active ? '' : ' <span class="adm-sub">выключена</span>') +
          '</label>';
        }).join('')
      : '<p class="hint">Сначала добавьте услугу — мастеру её нечего оказывать.</p>';
  }

  function fillMasterForm(id) {
    var m = state.masters.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!m) return;
    $('masterId').value = m.id;
    $('mName').value = m.name;
    $('mRole').value = m.role;
    $('mExp').value = m.experience_years;
    $('mActive').checked = !!m.is_active;
    var owned = {};
    (m.services || []).forEach(function (s) { owned[s.id] = true; });
    Array.prototype.forEach.call($('masterServices').querySelectorAll('input[type="checkbox"]'), function (box) {
      box.checked = !!owned[box.value];
    });
    $('masterFormTitle').textContent = 'Мастер: ' + m.name;
    $('masterSubmit').textContent = 'Сохранить';
    $('masterCancel').hidden = false;
    $('mName').focus();
  }

  function resetMasterForm() {
    $('masterId').value = '';
    $('masterForm').reset();
    $('mActive').checked = true;
    $('masterFormTitle').textContent = 'Новый мастер';
    $('masterSubmit').textContent = 'Создать';
    $('masterCancel').hidden = true;
    renderMasterServices();
  }

  function submitMaster(ev) {
    ev.preventDefault();
    var id = $('masterId').value;
    var name = $('mName').value.trim();
    var role = $('mRole').value.trim();
    if (!name || !role) { window.ui.error('Укажите имя и специализацию мастера.'); return; }
    var exp = Number($('mExp').value || 0);
    if (!Number.isInteger(exp) || exp < 0) { window.ui.error('Опыт — целое число лет от 0.'); return; }

    var serviceIds = Array.prototype.filter
      .call($('masterServices').querySelectorAll('input[type="checkbox"]:checked'), function (b) { return b.value; })
      .map(function (b) { return Number(b.value); });

    var payload = {
      name: name,
      role: role,
      experience_years: exp,
      is_active: $('mActive').checked ? 1 : 0,
      service_ids: serviceIds
    };
    var editing = !!id;
    return window.api.request(editing ? '/api/admin/masters/' + id : '/api/admin/masters', {
      method: editing ? 'PATCH' : 'POST', json: payload
    }).then(function (r) {
      window.ui.ok('Мастер сохранён: ' + r.master.name + '. Расписание у него пустое — задайте рабочие дни.');
      resetMasterForm();
      return loadMasters();
    });
  }

  function deleteMaster(id) {
    var m = state.masters.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!m) return;
    return confirmDialog(
      'Удалить мастера?',
      '«' + m.name + '» исчезнет вместе со своим расписанием. Если на мастера есть записи, сервер не даст удалить — тогда выключите его.',
      'Удалить'
    ).then(function (yes) {
      if (!yes) return;
      return window.api.request('/api/admin/masters/' + id, { method: 'DELETE' }).then(function () {
        window.ui.ok('Мастер удалён.');
        if (state.scheduleMasterId === Number(id)) state.scheduleMasterId = null;
        resetMasterForm();
        return loadMasters();
      });
    });
  }

  // ---------- отзывы ----------

  function loadFeedback() {
    var p = [];
    var status = $('fbStatus').value;
    if (status) p.push('status=' + encodeURIComponent(status));
    return window.api.request('/api/admin/feedback' + (p.length ? '?' + p.join('&') : '')).then(function (r) {
      var list = r.feedback || [];
      $('feedbackEmpty').hidden = list.length > 0;
      $('feedback').innerHTML = list.map(renderFeedback).join('');
      // Счётчик на вкладке — про новые обращения, поэтому он не зависит от
      // выбранного фильтра: считаем его по полной выборке.
      if (!status) {
        var fresh = list.filter(function (f) { return f.status === 'new'; }).length;
        $('feedbackCount').hidden = fresh === 0;
        $('feedbackCount').textContent = fresh;
      }
    });
  }

  function renderFeedback(f) {
    var who = f.client ? f.client.name + (f.client.phone ? ', ' + f.client.phone : '') : 'Клиент удалён';
    var actions = f.status === 'new'
      ? '<button type="button" class="btn btn--secondary btn--sm" data-fb="' + f.id + '" data-fb-status="read">Прочитано</button>'
      : (f.status === 'read'
        ? '<button type="button" class="btn btn--secondary btn--sm" data-fb="' + f.id + '" data-fb-status="answered">Отвечено</button>'
        : '');
    return '<div class="panel adm-fb">' +
      '<div class="adm-fb__head">' +
        '<strong>' + window.api.esc(who) + '</strong>' +
        '<span class="adm-sub">' + window.api.esc(window.api.fmt(f.created_at)) + '</span>' +
        tag(fbBadgeClass(f.status), window.FEEDBACK_STATUS[f.status] || f.status) +
      '</div>' +
      '<p class="adm-fb__text">' + window.api.esc(f.text) + '</p>' +
      (actions ? '<div class="adm-fb__actions">' + actions + '</div>' : '') +
    '</div>';
  }

  // У отзывов нет своих цветов бейджа: переиспользуем палитру записи
  // (новое — жёлтый, прочитано — зелёный, отвечено — серый).
  function fbBadgeClass(status) {
    return status === 'new' ? 'wait' : (status === 'read' ? 'confirmed' : 'done');
  }

  function setFeedbackStatus(id, status) {
    return window.api.request('/api/admin/feedback/' + id, {
      method: 'PATCH', json: { status: status }
    }).then(function () {
      window.ui.ok('Обращение: ' + window.FEEDBACK_STATUS[status].toLowerCase() + '.');
      return loadFeedback();
    });
  }

  // ---------- правила ----------

  function loadSettings() {
    return window.api.request('/api/admin/studio').then(function (r) {
      $('cancelHours').value = Number(r.studio.free_cancel_hours);
    });
  }

  function saveSettings(ev) {
    ev.preventDefault();
    var hours = Number($('cancelHours').value);
    if (!Number.isInteger(hours) || hours < 0 || hours > 168) {
      window.ui.error('Укажите целое число часов от 0 до 168.');
      return;
    }
    return window.api.request('/api/admin/studio', { method: 'PATCH', json: { free_cancel_hours: hours } })
      .then(function (r) {
        $('cancelHours').value = Number(r.studio.free_cancel_hours);
        window.ui.ok('Правило сохранено: бесплатная отмена за ' + r.studio.free_cancel_hours + ' ч.');
      });
  }

  // ---------- доступ ----------

  // Страница и её эндпоинты только для owner. Роль проверяем до запросов,
  // чтобы клиент или мастер не увидели «Панель владельца» с чужой ошибкой.
  function renderForbidden(msg) {
    $('tabs').hidden = true;
    ['stats', 'periodForm', 'periodStats', 'pager', 'blocks', 'feedback'].forEach(function (id) {
      var el = $(id);
      if (el) el.hidden = true;
    });
    TABS.forEach(function (t) { $('tab-' + t).hidden = true; });
    var el = $('error');
    el.className = 'alert';
    el.textContent = msg || 'Панель владельца доступна только владельцу студии.';
    el.hidden = false;
  }

  // ---------- события ----------

  function bindEvents() {
    $('tabs').addEventListener('click', function (ev) {
      var btn = ev.target.closest('.tabs__tab');
      if (btn) showTab(btn.dataset.tab);
    });

    // Дашборд
    $('periodGo').addEventListener('click', function () { window.ui.clear(); loadPeriod(); });
    $('periodForm').addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-preset]');
      if (!btn) return;
      var today = window.api.todaySalon();
      if (btn.dataset.preset === 'month') {
        $('pFrom').value = today.slice(0, 8) + '01';
        $('pTo').value = today;
      } else if (btn.dataset.preset === '7') {
        $('pFrom').value = addDays(today, -6);
        $('pTo').value = today;
      } else {
        $('pFrom').value = '';
        $('pTo').value = '';
      }
      window.ui.clear();
      loadPeriod();
    });

    // Записи
    ['fStatus', 'fMaster', 'fFrom', 'fTo'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        state.offset = 0;
        window.ui.clear();
        loadBookings();
      });
    });
    $('fReset').addEventListener('click', resetBookings);
    $('emptyReset').addEventListener('click', resetBookings);
    $('fLimit').addEventListener('change', function () {
      state.limit = Number($('fLimit').value) || 25;
      state.offset = 0;
      loadBookings();
    });
    $('pagePrev').addEventListener('click', function () {
      state.offset = Math.max(0, state.offset - state.limit);
      loadBookings();
    });
    $('pageNext').addEventListener('click', function () {
      if (state.offset + state.limit < state.total) {
        state.offset += state.limit;
        loadBookings();
      }
    });
    $('rows').addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-booking]');
      if (btn && !btn.disabled) setStatus(Number(btn.dataset.booking), btn.dataset.status);
    });

    // Расписание
    $('schMaster').addEventListener('change', function () {
      state.scheduleMasterId = Number($('schMaster').value);
      window.ui.clear();
      loadScheduleFor();
      loadBlocks();
    });
    $('week').addEventListener('change', function (ev) {
      // Отметка дня включает и блокирует время: неработающий день не должен
      // выглядеть как «работает 10:00–20:00».
      if (!ev.target.matches('[data-day-on]')) return;
      var row = ev.target.closest('.adm-week__row');
      row.classList.toggle('is-on', ev.target.checked);
      row.querySelector('[data-day-start]').disabled = !ev.target.checked;
      row.querySelector('[data-day-end]').disabled = !ev.target.checked;
    });
    $('scheduleSave').addEventListener('click', function () { window.ui.clear(); saveSchedule(); });
    $('blockForm').addEventListener('submit', function (ev) { window.ui.clear(); addBlock(ev); });
    $('blocksFrom').addEventListener('change', loadBlocks);
    $('blocksTo').addEventListener('change', loadBlocks);
    $('blocks').addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-block]');
      if (btn) deleteBlock(Number(btn.dataset.block));
    });

    // Услуги
    $('serviceForm').addEventListener('submit', function (ev) { window.ui.clear(); submitService(ev); });
    $('serviceCancel').addEventListener('click', resetServiceForm);
    $('serviceRows').addEventListener('click', function (ev) {
      var edit = ev.target.closest('button[data-service-edit]');
      var del = ev.target.closest('button[data-service-del]');
      if (edit) fillServiceForm(edit.dataset.serviceEdit);
      if (del) { window.ui.clear(); deleteService(Number(del.dataset.serviceDel)); }
    });

    // Мастера
    $('masterForm').addEventListener('submit', function (ev) { window.ui.clear(); submitMaster(ev); });
    $('masterCancel').addEventListener('click', resetMasterForm);
    $('masterRows').addEventListener('click', function (ev) {
      var edit = ev.target.closest('button[data-master-edit]');
      var del = ev.target.closest('button[data-master-del]');
      if (edit) fillMasterForm(edit.dataset.masterEdit);
      if (del) { window.ui.clear(); deleteMaster(Number(del.dataset.masterDel)); }
    });

    // Отзывы
    $('fbStatus').addEventListener('change', function () { window.ui.clear(); loadFeedback(); });
    $('feedback').addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-fb]');
      if (btn) { window.ui.clear(); setFeedbackStatus(Number(btn.dataset.fb), btn.dataset.fbStatus); }
    });

    // Правила
    $('settingsForm').addEventListener('submit', function (ev) { window.ui.clear(); saveSettings(ev); });
  }

  window.api.me().then(function (user) {
    if (!user) { window.location.replace('login.html?returnTo=admin.html'); return; }
    var roles = Array.isArray(user.roles) ? user.roles : [];
    if (roles.indexOf('owner') === -1) {
      renderForbidden('Панель владельца доступна только владельцу студии.');
      return;
    }
    $('whoami').textContent = 'Владелец: ' + (user.username || '') +
      '. Записи, расписание, прайс, мастера и обращения клиентов.';
    $('tabs').hidden = false;
    bindEvents();

    // Блокировки по умолчанию показываем на месяц вперёд: это горизонт, на
    // который владелец чаще всего смотрит (отпуска, больничные, перерывы).
    var today = window.api.todaySalon();
    $('blocksFrom').value = today;
    $('blocksTo').value = addDays(today, 30);

    // Текст ошибки каждого запроса уже показывает window.ui.error, поэтому
    // в Promise.all ветки глотаем: иначе необработанный reject просто
    // засоряет консоль, а экран уже показал, что именно не пришло.
    var quietly = function (p) { return p.catch(function () {}); };
    Promise.all([loadMasters(), loadServices(), loadStats(), loadSettings(), loadBookings()].map(quietly))
      .then(function () { loadPeriod(); });
  });
})();
