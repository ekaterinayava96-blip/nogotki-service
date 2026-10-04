'use strict';

// Страница раздела «Мастера» (/admin/masters): список всех мастеров, включая
// отключённых, добавление, редактирование, включение/выключение и удаление.
//
// Данные — GET/POST/PATCH/DELETE /api/admin/masters, список услуг для отметок
// — GET /api/admin/services (нужны и отключённые: иначе нельзя было бы увидеть
// и убрать связь). Удаление опять же решает сервер: при наличии записей он
// отключает мастера и объясняет причину в message.
//
// Связь с услугами — service_ids в теле POST/PATCH. Клиентский выбор мастера
// её уже учитывает: GET /api/masters отдаёт services[], страница записи
// блокирует мастера, который не делает выбранные услуги, а POST /api/bookings
// отклоняет такой выбор на сервере (MASTER_SERVICE_MISMATCH).

(function () {
  var listHost = document.getElementById('mstList');
  if (!listHost) return;

  var form = document.getElementById('mstForm');
  var nameInput = document.getElementById('mstName');
  var roleInput = document.getElementById('mstRole');
  var expInput = document.getElementById('mstExp');
  var activeInput = document.getElementById('mstActive');
  var servicesBox = document.getElementById('mstServices');
  var legend = document.getElementById('mstFormLegend');
  var resetBtn = document.getElementById('mstReset');
  var hiddenId = document.getElementById('mstId');
  var note = document.getElementById('mstNote');
  var editId = null;

  // Все услуги, включая отключённые: связь мастера с отключённой услугой должна
  // быть видна и снимаема, иначе она осталась бы «слепой».
  var allServices = [];

  function renderNote(outcome, message) {
    var cls = outcome === 'deleted' ? 'alert--success' : 'alert--warning';
    note.className = 'alert ' + cls;
    note.textContent = message;
    note.hidden = false;
  }

  function clearNote() {
    note.hidden = true;
    note.textContent = '';
  }

  function renderServiceChecks(selectedIds) {
    if (!allServices.length) {
      servicesBox.innerHTML = '<p class="stub">Услуг пока нет — создайте их на странице «Услуги».</p>';
      return;
    }
    servicesBox.innerHTML = allServices.map(function (s) {
      var on = selectedIds.indexOf(s.id) !== -1;
      return '<label class="adm-check adm-check--inline">' +
        '<input type="checkbox" value="' + s.id + '"' + (on ? ' checked' : '') + '> ' +
        window.api.esc(s.name) +
        (s.is_active ? '' : ' <span class="adm-sub">отключена</span>') +
      '</label>';
    }).join('');
  }

  function checkedServiceIds() {
    return Array.prototype.slice
      .call(servicesBox.querySelectorAll('input[type="checkbox"]:checked'))
      .map(function (cb) { return Number(cb.value); });
  }

  function render(masters) {
    if (!masters.length) {
      listHost.innerHTML = '<div class="empty-state"><p>Мастеров пока нет.</p></div>';
      return;
    }

    var rows = masters.map(function (m) {
      var off = !m.is_active;
      var svc = (m.services || []);
      return '<tr>' +
        '<td><b>' + window.api.esc(m.name) + '</b>' +
          '<span class="adm-sub">' + window.api.esc(m.role || '') +
          (m.experience_years ? ' · в профессии ' + m.experience_years + ' лет' : '') +
          ' · записей: ' + Number(m.bookings_count || 0) +
        '</span></td>' +
        '<td>' + (svc.length
          ? window.api.esc(svc.map(function (s) { return s.name; }).join(', '))
          : '<span class="adm-sub">не назначены</span>') + '</td>' +
        '<td>' + (off
          ? '<span class="badge badge--done">Отключён</span>'
          : '<span class="badge badge--confirmed">Активен</span>') + '</td>' +
        '<td class="adm-actions">' +
          '<button type="button" class="btn btn--secondary btn--sm" data-edit="' + m.id + '">Изменить</button> ' +
          '<button type="button" class="btn btn--ghost btn--sm" data-toggle="' + m.id + '">' +
            (off ? 'Включить' : 'Отключить') + '</button> ' +
          '<button type="button" class="btn btn--ghost btn--sm" data-del="' + m.id + '">Удалить</button>' +
        '</td>' +
      '</tr>';
    }).join('');

    listHost.innerHTML =
      '<div class="adm-table-wrap"><table class="adm-table">' +
        '<thead><tr><th>Мастер</th><th>Услуги</th><th>Состояние</th><th>Действия</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table></div>';
  }

  function load() {
    return Promise.all([
      window.api.request('/api/admin/masters'),
      window.api.request('/api/admin/services')
    ]).then(function (rs) {
      allServices = rs[1].services || [];
      render(rs[0].masters || []);
      // Отметки в форме перерисовываем, сохраняя то, что уже отмечено:
      // иначе перезагрузка списка сбрасывала бы правку.
      var keep = checkedServiceIds();
      if (!editId) renderServiceChecks(keep);
    });
  }

  function findById(id) {
    return window.api.request('/api/admin/masters').then(function (r) {
      var found = (r.masters || []).filter(function (m) { return m.id === id; })[0];
      if (!found) throw new Error('Мастер не найден.');
      return found;
    });
  }

  function startEdit(m) {
    editId = m.id;
    hiddenId.value = m.id;
    legend.textContent = 'Изменить мастера';
    nameInput.value = m.name;
    roleInput.value = m.role || '';
    expInput.value = m.experience_years || 0;
    activeInput.checked = !!m.is_active;
    renderServiceChecks((m.services || []).map(function (s) { return s.id; }));
    resetBtn.hidden = false;
    window.scrollTo(0, 0);
  }

  function resetForm() {
    editId = null;
    hiddenId.value = '';
    legend.textContent = 'Добавить мастера';
    form.reset();
    activeInput.checked = true;
    renderServiceChecks([]);
    resetBtn.hidden = true;
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    window.ui.clear();
    clearNote();

    var name = nameInput.value.trim();
    var role = roleInput.value.trim();
    var exp = Number(expInput.value || 0);
    var localBad = false;
    if (name.length < 2) {
      window.ui.error('Имя мастера: минимум 2 символа.');
      localBad = true;
    }
    if (role.length < 2) {
      window.ui.error('Специализация: минимум 2 символа.');
      localBad = true;
    }
    if (!(exp >= 0) || !Number.isInteger(exp)) {
      window.ui.error('Опыт — целое число лет, не меньше нуля.');
      localBad = true;
    }
    if (localBad) return;

    var body = {
      name: name,
      role: role,
      experience_years: exp,
      is_active: activeInput.checked ? 1 : 0,
      service_ids: checkedServiceIds()
    };

    var req = editId
      ? window.api.request('/api/admin/masters/' + editId, { method: 'PATCH', json: body })
      : window.api.request('/api/admin/masters', { method: 'POST', json: body });

    req.then(function () {
      resetForm();
      return load();
    }).catch(function () {
      // Текст ошибки в #error, форма не сбрасывается.
    });
  });

  resetBtn.addEventListener('click', function () {
    resetForm();
    window.ui.clear();
    clearNote();
  });

  listHost.addEventListener('click', function (ev) {
    var t = ev.target.closest('button');
    if (!t) return;
    window.ui.clear();
    clearNote();

    var edit = t.getAttribute('data-edit');
    if (edit) {
      findById(Number(edit)).then(startEdit);
      return;
    }

    var toggle = t.getAttribute('data-toggle');
    if (toggle) {
      var id = Number(toggle);
      findById(id).then(function (m) {
        return window.api.request('/api/admin/masters/' + id, {
          method: 'PATCH',
          json: { is_active: m.is_active ? 0 : 1 }
        });
      }).then(load);
      return;
    }

    var del = t.getAttribute('data-del');
    if (del) {
      var did = Number(del);
      findById(did).then(function (m) {
        var ok = window.confirm(
          'Удалить мастера «' + m.name + '»?\n\n' +
          'Если у него есть записи, сервер не удалит его, а отключит и объяснит почему.'
        );
        if (!ok) return;
        return window.api.request('/api/admin/masters/' + did, { method: 'DELETE' })
          .then(function (r) {
            renderNote(r.outcome, r.message);
            if (editId === did) resetForm();
            return load();
          });
      }).catch(function () { /* текст в #error */ });
    }
  });

  load();
})();