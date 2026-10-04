'use strict';

// Страница раздела «Записи» (/admin/bookings): записи выбранного дня.
//
// Данные — GET /api/admin/bookings/day?date=&master_id= (день салона) и
// GET /api/admin/bookings?limit= (список мастеров для фильтра). Время на
// экране — салонное: window.api.hour() переводит UTC в UTC+3 точно так же,
// как клиентские страницы, поэтому здесь оно не равно тому, что в базе.
//
// Действия с чужой записью (все уходят на сервер, клиент их проверяет):
//   * Отменить  — PATCH /api/admin/bookings/:id (status=canceled, reason).
//     Строка остаётся в списке с пометкой «Отменена», время освобождается.
//   * Перенести — PATCH /api/bookings/:id (starts_at). Та же запись, тот же
//     client_id: новая не создаётся, клиент не получает второго уведомления.
//   * Подтвердить / Выполнена — PATCH /api/admin/bookings/:id (status).
//   * Записать поверх занятого — POST /api/bookings с force_override, но в два
//     шага: первый возвращает 409 с can_force, запись не создаётся; второй с
//     confirm=1 создаёт.

(function () {
  var listHost = document.getElementById('bkList');
  if (!listHost) return;

  var dayInput = document.getElementById('bkDate');
  var masterSel = document.getElementById('bkMaster');
  var prevBtn = document.getElementById('bkPrev');
  var nextBtn = document.getElementById('bkNext');
  var todayBtn = document.getElementById('bkToday');
  var summary = document.getElementById('bkSummary');
  var note = document.getElementById('bkNote');
  var moveBox = document.getElementById('bkMoveBox');
  var refreshBtn = document.getElementById('bkRefresh');
  var stamp = document.getElementById('bkStamp');

  // Смещение салона в минутах. window.api не отдаёт его наружу (там только
  // hour/day/fmt), а для разбора даты записи оно нужно здесь.
  var SALON_OFFSET = 180; // UTC+3, как lib/time.js на бэкенде

  var masters = [];
  var state = { day: window.api.todaySalon(), masterId: '', move: null };

  // Дата салона в виде «YYYY-MM-DD» для <input type="date">. Нельзя брать
  // window.api.day(): он отдаёт «ДД.ММ.ГГГГ», а разворот порядка дал бы
  // «ГГГГ.ММ.ДД» — поле молча осталось бы пустым и слоты не загрузились бы.
  function dayText(iso) {
    var d = new Date(new Date(iso).getTime() + SALON_OFFSET * 60000);
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }

  function shiftDay(day, delta) {
    var parts = day.split('-');
    var d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + delta));
    return d.toISOString().slice(0, 10);
  }

  function renderNote(kind, text) {
    note.className = 'alert ' + kind;
    note.textContent = text;
    note.hidden = false;
  }

  function clearNote() {
    note.hidden = true;
    note.textContent = '';
  }

  function badge(status) {
    return '<span class="badge badge--' + window.api.esc(status) + '">' +
      window.api.esc(window.BOOKING_STATUS[status] || status) + '</span>';
  }

  function row(b) {
    var off = b.status === 'canceled';
    var marks = [];
    // Запись поверх занятого времени: помечаем обе строки, иначе двойное время
    // выглядит как ошибка в расписании.
    if (b.overlap) {
      marks.push('<span class="badge badge--wait">Два визита на это время</span>');
      if (b.conflict_note) marks.push('<span class="adm-sub">' + window.api.esc(b.conflict_note) + '</span>');
    }
    if (b.moves_count) {
      var mv = b.moved_last;
      marks.push(
        '<span class="adm-sub">перенесён с ' + window.api.esc(window.api.fmt(mv.from_at)) +
        ' (сделал ' + window.api.esc(mv.moved_by_username || '?') + ')</span>'
      );
    }
    if (off) {
      marks.push(
        '<span class="adm-sub">отменил ' +
        window.api.esc(b.canceled_by_username || 'клиент') +
        (b.canceled_reason ? ': ' + window.api.esc(b.canceled_reason) : '') +
        '</span>'
      );
    }

    // Пометки складываем в отдельный блок: .adm-sub и .badge и так блочные,
    // а между ними стоял <br>, который после блочного элемента давал лишнюю
    // пустую строку и растягивал ячейку по вертикали.
    var actions = '<td class="adm-actions">';
    if (!off) {
      actions += '<div class="adm-actions__row">' +
        '<button type="button" class="btn btn--secondary btn--sm" data-status="confirmed" data-id="' + b.id + '">Подтвердить</button>' +
        '<button type="button" class="btn btn--secondary btn--sm" data-move="' + b.id + '">Перенести</button>' +
        '<button type="button" class="btn btn--ghost btn--sm" data-cancel="' + b.id + '">Отменить</button>' +
      '</div>';
    } else {
      actions += '<span class="adm-sub">визит отменён</span>';
    }
    actions += '</td>';

    return '<tr>' +
      '<td class="adm-when"><b>' + window.api.esc(window.api.hour(b.starts_at)) + '–' +
        window.api.esc(window.api.hour(b.ends_at)) + '</b>' +
        (marks.length ? '<span class="adm-marks">' + marks.join('') + '</span>' : '') + '</td>' +
      '<td><b>' + window.api.esc(b.client.name) + '</b><span class="adm-sub">' +
        window.api.esc(b.client.phone) + '</span></td>' +
      '<td>' + window.api.esc(b.master.name) + '</td>' +
      '<td>' + window.api.esc(b.services.map(function (s) { return s.name; }).join(' + ')) +
        '<span class="adm-sub">' + window.api.esc(window.api.rub(b.total_price_kopecks)) + ' · ' +
        window.api.esc(window.api.duration(b.total_duration_minutes)) + '</span></td>' +
      '<td>' + badge(b.status) + '</td>' +
      actions +
    '</tr>';
  }

// Итоги дня: отменённые считаются отдельно от активных, сумма берётся только
  // по активным — отменённый визит выручки не приносит.
  function render(data) {
    var list = data.bookings || [];
    var active = list.filter(function (b) { return b.status !== 'canceled'; });
    var canceled = list.length - active.length;
    var sum = active.reduce(function (s, b) { return s + b.total_price_kopecks; }, 0);
    summary.textContent = 'Записей: ' + list.length +
      ' (активных ' + active.length + ', отменённых ' + canceled + ')' +
      ' · на сумму ' + window.api.rub(sum) +
      ' · две на одно время: ' + list.filter(function (b) { return b.overlap; }).length;

    if (!list.length) {
      listHost.innerHTML =
        '<div class="empty-state"><p>На этот день записей нет.</p>' +
        '<button type="button" class="btn btn--secondary btn--md" id="bkAddHere">Записать клиента на это время</button></div>';
      var add = document.getElementById('bkAddHere');
      if (add) add.addEventListener('click', function () { openNewBooking(); });
      return;
    }

    listHost.innerHTML =
      '<div class="adm-table-wrap"><table class="adm-table adm-table--bookings">' +
        '<thead><tr><th>Время</th><th>Клиент</th><th>Мастер</th><th>Услуги</th><th>Состояние</th><th>Действия</th></tr></thead>' +
        '<tbody>' + list.map(row).join('') + '</tbody>' +
      '</table></div>';
  }

  // load() возвращает ответ сервера, а не результат render: render ничего не
// возвращает, и раньше на этом шаге значение терялось — вызывающий код получал
// undefined вместо списка.
function load() {
    var url = '/api/admin/bookings/day?date=' + encodeURIComponent(state.day);
    if (state.masterId) url += '&master_id=' + encodeURIComponent(state.masterId);
    return window.api.request(url).then(function (data) {
      render(data);
      window.__bkList = data.bookings || [];
      return data;
    });
  }

  // ---- Перенос и запись поверх занятого ----

  function openMove(id) {
    var booking = (window.__bkList || []).filter(function (x) { return x.id === Number(id); })[0];
    if (!booking) {
      renderNote('alert--warning', 'Запись не найдена в списке дня — нажмите «Обновить».');
      return;
    }
    state.move = { id: booking.id };
    // Набор услуг записи известен сразу: по нему считаются слоты нужной
    // длительности, иначе мастеру предлагались бы окна не под его визит.
    window.__bkMoveServices = (booking.services || []).map(function (s) { return s.id; });
    showMoveBox(booking);
  }

  // Новая запись (из пустого дня): клиента ещё нет, поэтому его надо выбрать.
  // Без этого отправка уходила бы без client_id и сервер отвечал 400
  // CLIENT_REQUIRED.
  function openNewBooking() {
    state.move = { id: null };
    window.__bkMoveServices = ((masters[0] && masters[0].services) || []).map(function (s) { return s.id; });
    showMoveBox(null);
  }

  function showMoveBox(booking) {
    if (!moveBox) return;
    window.ui.clear();
    clearNote();
    moveBox.hidden = false;
    moveBox.innerHTML =
      '<h3>' + (booking ? 'Перенос записи #' + booking.id : 'Запись на это время') + '</h3>' +
      (booking
        ? '<p class="adm-sub">Клиент ' + window.api.esc(booking.client.name) +
          ' · ' + window.api.esc(booking.master.name) + ' · ' +
          window.api.esc(booking.services.map(function (s) { return s.name; }).join(' + ')) +
          ' · ' + window.api.esc(window.api.duration(booking.total_duration_minutes)) + '</p>'
        : '<p class="adm-sub">Клиента можно выбрать вручную: время занято, но записать разрешено.</p>') +
      '<div class="adm-form-grid">' +
        '<div class="field"><label for="bkMoveMaster">Мастер</label><select id="bkMoveMaster">' +
          masters.map(function (m) {
            return '<option value="' + m.id + '">' + window.api.esc(m.name) + '</option>';
          }).join('') + '</select></div>' +
        '<div class="field"><label for="bkMoveDate">Дата</label>' +
          '<input type="date" id="bkMoveDate" value="' + window.api.esc(state.day) + '"></div>' +
      '</div>' +
      '<div id="bkSlots" class="slots"></div>' +
      '<div class="field"><label for="bkNoteInput">Пометка (если время занято)</label>' +
        '<input id="bkNoteInput" placeholder="Клиент пришёл сам, раньше не предупредили"></div>' +
      '<div class="modal__actions">' +
        '<button type="button" class="btn btn--ghost btn--md" id="bkMoveClose">Закрыть</button>' +
        '<button type="button" class="btn btn--primary btn--md" id="bkMoveGo">Перенести / записать</button>' +
      '</div>';

    document.getElementById('bkMoveClose').addEventListener('click', function () { moveBox.hidden = true; });
    document.getElementById('bkMoveGo').addEventListener('click', submitMove);
    document.getElementById('bkMoveDate').addEventListener('change', loadSlots);
    document.getElementById('bkMoveMaster').addEventListener('change', loadSlots);
    if (booking) {
      document.getElementById('bkMoveMaster').value = String(booking.master.id);
      document.getElementById('bkMoveDate').value = dayText(booking.starts_at);
    }
    loadSlots();
  }

  function loadSlots() {
    var masterSel = document.getElementById('bkMoveMaster');
    var dateInput = document.getElementById('bkMoveDate');
    var svc = document.getElementById('bkSlots');
    if (!svc || !masterSel || !dateInput) return;

    var masterId = Number(masterSel.value);
    var date = dateInput.value;
    if (!masterId) {
      svc.innerHTML = '<p class="stub">Выберите мастера.</p>';
      return;
    }
    if (!date) {
      svc.innerHTML = '<p class="stub">Выберите дату.</p>';
      return;
    }
    svc.innerHTML = '<p class="loading"><span class="loading__spin"></span>Свободные окна…</p>';
    // Для переноса берём услуги самой записи; для новой — первую активную услугу
    // выбранного мастера (её набор услуг сервер и сам проверит).
    var serviceIds = window.__bkMoveServices || [];
    if (!serviceIds.length) {
      var m = masters.filter(function (x) { return x.id === masterId; })[0];
      serviceIds = ((m && m.services) || []).map(function (s) { return s.id; });
    }
    if (!serviceIds.length) {
      svc.innerHTML = '<p class="stub">У мастера не назначено услуг — отметьте их на странице «Мастера».</p>';
      return;
    }
    window.api.request('/api/masters/' + masterId + '/slots?date=' + encodeURIComponent(date) +
      '&service_ids=' + serviceIds.join(','))
      .then(function (r) {
        var slots = r.slots || [];
        if (!slots.length) { svc.innerHTML = '<p class="stub">В этот день свободных окон нет.</p>'; return; }
        svc.innerHTML = slots.map(function (s) {
          return '<button type="button" class="slot" data-slot="' + window.api.esc(s.starts_at) + '">' +
            window.api.esc(window.api.hour(s.starts_at)) + '</button>';
        }).join('');
      });
  }

  function submitMove() {
    var picked = moveBox.querySelector('[data-slot]');
    if (!picked) {
      renderNote('alert--warning', 'Выберите время: нажмите на свободное окно выше.');
      return;
    }
    var masterId = Number(document.getElementById('bkMoveMaster').value);
    var noteText = document.getElementById('bkNoteInput').value.trim();
    var booking = state.move;

    window.ui.clear();
    clearNote();

    if (booking && booking.id) {
      // Перенос: тот же id записи, тот же клиент. Новая запись не создаётся.
      var moveBody = { starts_at: picked.getAttribute('data-slot') };
      window.api.request('/api/bookings/' + booking.id, {
        method: 'PATCH',
        json: moveBody
      }).then(function (r) {
        moveBox.hidden = true;
        renderNote('alert--success',
          r.forced
            ? 'Запись перенесена ПОВЕРХ занятого времени: клиент, чьё время затронуто, получит уведомление. В списке дня обе строки помечены как «два визита на это время».'
            : 'Запись перенесена. В кабинете у клиента она осталась тем же визитом — второго уведомления не будет.');
        return load();
      }).catch(function (err) {
        var e = err.data && err.data.error;
        if (!e) return;
        if (e.can_force) {
          // Время занято, но администратор может положить визит поверх него.
          // Раньше здесь только показывалось пояснение, а второй запрос не
          // уходил — подтвердить было нечем.
          if (!window.confirm(
            'Это время занято: ' + (e.message || '') + '\n\n' +
            'Перенести визит поверх него можно. Клиент, чьё время затронуто, получит ' +
            'уведомление, а в списке дня обе строки будут помечены как два визита. ' +
            'Переносим?'
          )) { return; }
          window.api.request('/api/bookings/' + booking.id, {
            method: 'PATCH',
            json: {
              starts_at: moveBody.starts_at,
              force_override: 1,
              confirm: 1
            }
          }).then(function (r2) {
            moveBox.hidden = true;
            renderNote('alert--warning',
              r2.forced
                ? 'Визит перенесён поверх занятого времени пострадавшему клиенту отправлено уведомление.'
                : 'Запись перенесена.');
            return load();
          }).catch(function () { /* текст в #error */ });
        } else {
          renderNote('alert--warning', e.message);
        }
      });
      return;
    }

    // Новая запись поверх занятого — только владельцу и в два шага.
    // Клиент обязателен: сервер берёт его из client_id, а не из сессии
    // владельца, у которого клиентского профиля нет.
    var clientId = state.move && state.move.clientId;
    if (!clientId) {
      renderNote('alert--warning', 'Выберите клиента — без него запись не создать.');
      return;
    }
    window.api.request('/api/bookings', {
      method: 'POST',
      json: {
        master_id: masterId,
        service_ids: window.__bkMoveServices || [],
        client_id: clientId,
        starts_at: picked.getAttribute('data-slot'),
        force_override: 1,
        conflict_note: noteText || undefined
      }
    }).then(function () {
      moveBox.hidden = true;
      renderNote('alert--success', 'Запись создана.');
      return load();
    }).catch(function (err) {
      var e = err.data && err.data.error;
      if (e && e.can_force) {
        // Первый шаг: занято, но можно подтвердить. Повторяем с confirm.
        if (!window.confirm(
          'Это время занято.\n\n' +
          'Записать клиента поверх занятого можно — в списке дня появится пометка ' +
          'о двух визитах на это время. Подтверждаете?'
        )) { return; }
        window.api.request('/api/bookings', {
          method: 'POST',
          json: {
            master_id: masterId,
            service_ids: window.__bkMoveServices || [],
            client_id: clientId,
            starts_at: picked.getAttribute('data-slot'),
            force_override: 1,
            confirm: 1,
            conflict_note: noteText || undefined
          }
        }).then(function () {
          moveBox.hidden = true;
          renderNote('alert--success', 'Запись создана поверх занятого времени. В списке дня она помечена как «два визита на это время».');
          return load();
        }).catch(function () { /* текст в #error */ });
      } else if (e) {
        renderNote('alert--warning', e.message);
      }
    });
  }

  // ---- Смена статуса и отмена ----

  function findInList(id) {
    return (window.__bkList || []).filter(function (x) { return x.id === Number(id); })[0];
  }

  function cancelBooking(id) {
    var b = findInList(id);
    if (!b) {
      renderNote('alert--warning', 'Запись не найдена в списке дня — обновите день.');
      return;
    }
    var reason = window.prompt(
      'Отменить визит ' + window.api.hour(b.starts_at) + ' — ' + b.client.name + '?\n\n' +
      'Запись останется в списке с пометкой «Отменена», время освободится.\n' +
      'Причина обязательна — её видно в истории.',
      ''
    );
    if (reason === null) return;
    if (String(reason).trim().length < 3) {
      renderNote('alert--warning', 'Укажите причину отмены — минимум 3 символа.');
      return;
    }
    window.ui.clear();
    window.api.request('/api/admin/bookings/' + id, {
      method: 'PATCH',
      json: { status: 'canceled', reason: reason.trim() }
    }).then(function () {
      renderNote('alert--success', 'Визит отменён: строка осталась в списке, время освободилось. Клиент увидит запись в «Истории» со статусом «Отменена».');
      return load();
    }).catch(function () { /* текст в #error */ });
  }

  listHost.addEventListener('click', function (ev) {
    // Клик мог прийти не по кнопке (по строке, по бейджу) — тогда closest
    // вернёт null, и раньше обработчик на этом падал молча.
    var t = ev.target && ev.target.closest ? ev.target.closest('button') : null;
    if (!t || !t.getAttribute) return;
    window.ui.clear();
    clearNote();

    var id = t.getAttribute('data-cancel');
    if (id) { cancelBooking(Number(id)); return; }

    var mv = t.getAttribute('data-move');
    if (mv) {
      openMove(mv);
      return;
    }

    var st = t.getAttribute('data-status');
    if (st) {
      window.api.request('/api/admin/bookings/' + t.getAttribute('data-id'), {
        method: 'PATCH',
        json: { status: st }
      }).then(load);
    }
  });

  // ---- Фильтры и обновление ----

  // Страница запрашивает данные один раз и больше не перечитывает их. Клиент тем
  // временем отменяет запись у себя в кабинете — и панель продолжает показывать
  // её активной, потому что на экране просто старый снимок списка. Сервер при
  // этом отдаёт верный статус: проверено свежим запросом к /bookings/day.
  //
  // Поэтому список обновляем: по таймеру, при возврате на вкладку и по кнопке.
  // Форму переноса во время обновления не трогаем — она может быть открыта.
  var REFRESH_MS = 30000;
  var refreshTimer = null;

  function markFresh() {
    if (!stamp) return;
    stamp.textContent = 'обновлено в ' + window.api.hour(new Date().toISOString());
  }

  // Обновление не должно затирать сообщение об успешном действии и не должно
  // дёргать сервер, пока пользователь правит форму.
  function refreshSilently() {
    if (moveBox && !moveBox.hidden) return Promise.resolve();
    if (window.__bkPending) return Promise.resolve();
    return load().then(markFresh).catch(function () {
      // Фоновая ошибка не должна ничем мешать: текст и так уже был показан.
    });
  }

  function reload() {
    window.__bkPending = true;
    return load().then(function (data) {
      window.__bkPending = false;
      markFresh();
      return data;
    }).catch(function (err) {
      window.__bkPending = false;
      throw err;
    });
  }

  function startAutoRefresh() {
    if (refreshTimer) window.clearInterval(refreshTimer);
    refreshTimer = window.setInterval(refreshSilently, REFRESH_MS);
    // Вернулись на вкладку — список наверняка устарел.
    window.document.addEventListener('visibilitychange', function () {
      if (!window.document.hidden) refreshSilently();
    });
    window.addEventListener('focus', refreshSilently);
  }

  dayInput.addEventListener('change', function () {
    state.day = dayInput.value || state.day;
    dayInput.value = state.day;
    moveBox.hidden = true;
    reload();
  });
  masterSel.addEventListener('change', function () {
    state.masterId = masterSel.value;
    reload();
  });
  prevBtn.addEventListener('click', function () {
    state.day = shiftDay(state.day, -1);
    dayInput.value = state.day;
    reload();
  });
  nextBtn.addEventListener('click', function () {
    state.day = shiftDay(state.day, 1);
    dayInput.value = state.day;
    reload();
  });
  todayBtn.addEventListener('click', function () {
    state.day = window.api.todaySalon();
    dayInput.value = state.day;
    reload();
  });
  refreshBtn.addEventListener('click', function () {
    refreshSilently();
  });

// Если на выбранный день записей нет, ищем ближайший, где они есть.
  function nearestDayWithBookings(from) {
    var day = from;
    var steps = 0;
    function step() {
      if (steps > 60) return Promise.resolve(null);
      steps++;
      return window.api.request('/api/admin/bookings/day?date=' + encodeURIComponent(day))
        .then(function (r) {
          if ((r.total || 0) > 0) return day;
          day = shiftDay(day, 1);
          return step();
        });
    }
    return step();
  }

  // Значение поля даты проставляем явно: без него браузер показывает «сегодня»
  // по календарю компьютера, а на стыке суток это другой день.
  dayInput.value = state.day;
  window.api.request('/api/admin/masters').then(function (r) {
    masters = r.masters || [];
    masterSel.innerHTML = '<option value="">Все мастера</option>' + masters.map(function (m) {
      return '<option value="' + m.id + '">' + window.api.esc(m.name) + '</option>';
    }).join('');
    // Набор услуг по умолчанию — для новой записи, когда визит ещё не выбран.
    window.__bkMoveServices = ((masters[0] && masters[0].services) || []).map(function (s) { return s.id; });
    return reload();
  }).then(function () {
    if ((window.__bkList || []).length > 0) return null;
    return nearestDayWithBookings(state.day).then(function (day) {
      if (!day) return null;
      state.day = day;
      dayInput.value = day;
      renderNote('alert--warning',
        'На выбранный день записей не было — показали ближайший, где они есть: ' + day + '.');
      return reload();
    });
  }).then(startAutoRefresh);
})();