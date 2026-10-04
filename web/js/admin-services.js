'use strict';

// Страница раздела «Услуги» (/admin/services): список всех услуг, включая
// отключённые, добавление, редактирование, включение/выключение и удаление.
//
// Данные — GET/POST/PATCH/DELETE /api/admin/services. Решение об удалении
// принимает сервер: если по услуге есть записи, он не удаляет, а отключает и
// объясняет причину в поле message. Поэтому здесь мы НЕ решаем, можно ли
// удалять: отправляем DELETE и показываем ответ как есть.
//
// Отключённые услуги клиенту не видны — это обеспечивает сам сервер
// (listServices с activeOnly: true в GET /api/services), здесь мы лишь помечаем
// их в списке, чтобы администратор видел всю картину.

(function () {
  var listHost = document.getElementById('svcList');
  if (!listHost) return;

  var form = document.getElementById('svcForm');
  var nameInput = document.getElementById('svcName');
  var descInput = document.getElementById('svcDesc');
  var priceInput = document.getElementById('svcPrice');
  var durInput = document.getElementById('svcDuration');
  var activeInput = document.getElementById('svcActive');
  var legend = document.getElementById('svcFormLegend');
  var resetBtn = document.getElementById('svcReset');
  var hiddenId = document.getElementById('svcId');
  var note = document.getElementById('svcNote');
  var editId = null;

  // Ответ сервера на удаление: 'deleted' | 'disabled' | 'already_disabled'.
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

  function render(list) {
    if (!list.length) {
      listHost.innerHTML =
        '<div class="empty-state"><p>Услуг пока нет.</p></div>';
      return;
    }

    var rows = list.map(function (s) {
      var off = !s.is_active;
      return '<tr>' +
        '<td><b>' + window.api.esc(s.name) + '</b>' +
          (s.description ? '<span class="adm-sub">' + window.api.esc(s.description) + '</span>' : '') +
        '</td>' +
        '<td class="adm-when">' + window.api.rub(s.price_kopecks) + '</td>' +
        '<td class="adm-when">' + window.api.duration(s.duration_minutes) + '</td>' +
        '<td>' + (off
          ? '<span class="badge badge--done">Отключена</span>'
          : '<span class="badge badge--confirmed">Активна</span>') + '</td>' +
        '<td class="adm-actions">' +
          '<button type="button" class="btn btn--secondary btn--sm" data-edit="' + s.id + '">Изменить</button> ' +
          '<button type="button" class="btn btn--ghost btn--sm" data-toggle="' + s.id + '">' +
            (off ? 'Включить' : 'Отключить') + '</button> ' +
          '<button type="button" class="btn btn--ghost btn--sm" data-del="' + s.id + '">Удалить</button>' +
        '</td>' +
      '</tr>';
    }).join('');

    listHost.innerHTML =
      '<div class="adm-table-wrap"><table class="adm-table">' +
        '<thead><tr><th>Услуга</th><th>Цена</th><th>Длительность</th><th>Состояние</th><th>Действия</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table></div>';
  }

  function load() {
    return window.api.request('/api/admin/services').then(function (r) {
      render(r.services || []);
    });
  }

  function findById(id) {
    return window.api.request('/api/admin/services').then(function (r) {
      var found = (r.services || []).filter(function (s) { return s.id === id; })[0];
      if (!found) throw new Error('Услуга не найдена.');
      return found;
    });
  }

  // ---- Форма: создание и редактирование ----

  function startEdit(s) {
    editId = s.id;
    hiddenId.value = s.id;
    legend.textContent = 'Изменить услугу';
    nameInput.value = s.name;
    descInput.value = s.description || '';
    priceInput.value = (Number(s.price_kopecks) / 100).toFixed(2).replace(/\.00$/, '');
    durInput.value = s.duration_minutes;
    activeInput.checked = !!s.is_active;
    resetBtn.hidden = false;
    window.scrollTo(0, 0);
  }

  function resetForm() {
    editId = null;
    hiddenId.value = '';
    legend.textContent = 'Добавить услугу';
    form.reset();
    activeInput.checked = true;
    resetBtn.hidden = true;
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    window.ui.clear();
    clearNote();

    // Клиентская проверка — только для подсказки. Настоящая проверка на
    // сервере: пустое название и неположительные цена/длительность он
    // отклоняет сам, и его текст показывается через api.request -> #error.
    var name = nameInput.value.trim();
    var price = Number(priceInput.value);
    var dur = Number(durInput.value);
    var localBad = false;
    if (name.length < 2) {
      window.ui.error('Название: минимум 2 символа.');
      localBad = true;
    }
    if (!(price > 0)) {
      window.ui.error('Цена должна быть больше нуля.');
      localBad = true;
    }
    if (!(dur > 0) || !Number.isInteger(dur)) {
      window.ui.error('Длительность — целое число минут больше нуля.');
      localBad = true;
    }
    if (localBad) return;

    var body = {
      name: name,
      description: descInput.value.trim(),
      price_kopecks: Math.round(price * 100),
      duration_minutes: dur,
      is_active: activeInput.checked ? 1 : 0
    };

    var req = editId
      ? window.api.request('/api/admin/services/' + editId, { method: 'PATCH', json: body })
      : window.api.request('/api/admin/services', { method: 'POST', json: body });

    req.then(function () {
      resetForm();
      return load();
    }).catch(function () {
      // Текст ошибки уже показан в #error (api.request) — форму не сбрасываем,
      // чтобы администратор не потерял введённое.
    });
  });

  resetBtn.addEventListener('click', function () {
    resetForm();
    window.ui.clear();
    clearNote();
  });

  // ---- Действия в списке ----

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
      findById(id).then(function (s) {
        // Включение/выключение идёт тем же PATCH, что и правка полей: меняем
        // только is_active, остальные поля сервер берёт существующие.
        return window.api.request('/api/admin/services/' + id, {
          method: 'PATCH',
          json: { is_active: s.is_active ? 0 : 1 }
        });
      }).then(load);
      return;
    }

    var del = t.getAttribute('data-del');
    if (del) {
      var did = Number(del);
      findById(did).then(function (s) {
        var ok = window.confirm(
          'Удалить услугу «' + s.name + '»?\n\n' +
          'Если по ней есть записи, сервер не удалит её, а отключит и объяснит почему.'
        );
        if (!ok) return;
        return window.api.request('/api/admin/services/' + did, { method: 'DELETE' })
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