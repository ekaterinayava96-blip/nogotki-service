'use strict';

// Незавершённый выбор клиента на шагах записи. Черновой фронт держит его в
// sessionStorage под ключом 'pending_booking' (backend/public/booking.html и
// slots.html) — здесь тот же механизм, вынесенный в отдельный файл, чтобы
// страницы не придумывали своё хранилище.
//
// В sessionStorage лежит только выбор: id услуг, id мастера, дата и начало
// слота. Токен удержания сюда не пишется — он живёт в памяти страницы до
// подтверждения, а сессия — в httpOnly-куке.

(function () {
  var KEY = 'pending_booking';

  function empty() {
    return { service_ids: [], master_id: null, date: null, starts_at: null, updated_at: null };
  }

  function read() {
    try {
      var raw = sessionStorage.getItem(KEY);
      if (!raw) return empty();
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return empty();
      var draft = empty();
      draft.service_ids = Array.isArray(data.service_ids)
        ? data.service_ids.map(Number).filter(function (id) { return Number.isFinite(id) && id > 0; })
        : [];
      var masterId = Number(data.master_id);
      draft.master_id = data.master_id == null || !Number.isFinite(masterId) ? null : masterId;
      draft.date = typeof data.date === 'string' ? data.date : null;
      draft.starts_at = typeof data.starts_at === 'string' ? data.starts_at : null;
      draft.updated_at = typeof data.updated_at === 'string' ? data.updated_at : null;
      return draft;
    } catch (e) {
      return empty();
    }
  }

  window.store = {
    key: KEY,

    load: function () {
      return read();
    },

    // Пишем только те поля, что передали: каталог меняет услуги и мастера,
    // а дату и слот, выбранные в записи, стирать не должен.
    save: function (draft) {
      var data = read();
      Object.keys(empty()).forEach(function (key) {
        if (draft && Object.prototype.hasOwnProperty.call(draft, key)) data[key] = draft[key];
      });
      data.service_ids = (data.service_ids || []).map(Number).filter(function (id) { return id > 0; });
      data.updated_at = new Date().toISOString();
      try {
        sessionStorage.setItem(KEY, JSON.stringify(data));
      } catch (e) {
        // Приватный режим или переполнение — запись просто не сохранится.
      }
      return data;
    },

    clear: function () {
      try { sessionStorage.removeItem(KEY); } catch (e) { /* нечего удалять */ }
    }
  };
})();
