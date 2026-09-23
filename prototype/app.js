/* ============================================================
   «НОГОТОЧКИ» — кликабельный прототип. Логика и демо-данные.
   ============================================================ */
(function () {
  "use strict";

  /* ---------- ДЕМО-ДАННЫЕ ---------- */
  const SERVICES = [
    { id: 1, name: "Маникюр с покрытием гель-лаком", desc: "Уход за ногтями и стойкое покрытие на 3–4 недели", price: 1800, duration: "1,5 часа", img: "assets/service-manicure.svg" },
    { id: 2, name: "Маникюр и педикюр", desc: "Комплекс из двух процедур за один визит", price: 3200, duration: "2,5 часа", img: "assets/service-pedicure.svg" },
    { id: 3, name: "Наращивание ногтей", desc: "Моделирование желаемой формы и длины ногтей", price: 2800, duration: "2,5 часа", img: "assets/service-ext.svg" },
    { id: 4, name: "Дизайн ногтей", desc: "Рисунок, втирка, стразы или френч", price: 300, duration: "+15–30 мин", img: "assets/service-design.svg" },
    { id: 5, name: "Коррекция и окрашивание бровей", desc: "Коррекция формы и окрашивание волосков", price: 1200, duration: "40 минут", img: "assets/service-brows.svg" },
    { id: 6, name: "Ламинирование бровей", desc: "Укладка и стойкая форма бровей на 4–6 недель", price: 1800, duration: "1 час", img: "assets/service-lamination.svg" },
  ];

  // Мастера: services — какие услуги может выполнять мастер
  const MASTERS = [
    { id: 1, name: "Екатерина", role: "Мастер маникюра и бровей", exp: "с 2019 года", services: [1, 2, 3, 4, 5, 6], photo: "assets/master-manicure.svg" },
    { id: 2, name: "Анна", role: "Мастер маникюра", exp: "с 2021 года", services: [1, 2, 3, 4], photo: "assets/master-manicure.svg" },
    { id: 3, name: "Ольга", role: "Бровист", exp: "с 2020 года", services: [5, 6], photo: "assets/master-brows.svg" },
  ];

  // Рабочие часы: вт—сб 10:00–20:00
  const WORK_DAYS = [2, 3, 4, 5, 6]; // 0=вс
  const WORK_START = 10, WORK_END = 20;

  // Занятые слоты в демо (карта "день_смещение_относительно_сегодня:час")
  const DEMO_BUSY = {
    0: [11, 12, 16],
    1: [13, 14, 18],
    2: [10, 15, 16],
    3: [12, 17],
    5: [11, 12, 13],
    6: [15, 16, 19],
  };
  const DEMO_PAUSED = {
    0: [14],
    3: [15],
    5: [17],
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const money = (n) => n.toLocaleString("ru-RU") + " ₽";

  /* ---------- УТИЛИТЫ ДАТ ---------- */
  function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function fmtDate(d) { return d.toISOString().slice(0, 10); }
  const WEEK_DAYS_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
  const MONTHS_RU = ["январь","февраль","март","апрель","май","июнь","июль","август","сентябрь","октябрь","ноябрь","декабрь"];
  function humanDate(d) {
    const m = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
    return `${d.getDate()} ${m[d.getMonth()]}`;
  }

  /* ---------- ЛОКАЛЬНОЕ ХРАНИЛИЩЕ ---------- */
  const store = {
    get(key, def) { try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; } },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* quota/offline */ } },
    bookings() { return this.get("nogt_bookings", []); },
    addBooking(b) { const list = this.bookings(); list.unshift(b); this.set("nogt_bookings", list); },
    removeBooking(id) { this.set("nogt_bookings", this.bookings().filter((x) => x.id !== id)); },
  };

  let bookingDraft = { service: null, master: null, date: null, time: null, name: "", phone: "" };
  let currentDayOffset = 0;

  /* ---------- ФОТО МАСТЕРОВ (загружаемые пользователем) ---------- */
  function masterPhoto(m) {
    const saved = store.get("nogt_photo_" + m.id, null);
    return saved && saved.length > 6 ? saved : m.photo;
  }

  function saveMasterPhoto(id, dataUrl) {
    store.set("nogt_photo_" + id, dataUrl);
    // обновляем все <img> мастера на странице
    $$('img[data-photo="' + id + '"]').forEach((img) => { img.src = dataUrl; });
  }

  function initPhotoUpload() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.style.display = "none";
    document.body.appendChild(input);

    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-upload-photo]");
      if (!btn) return;
      input.dataset.target = btn.dataset.uploadPhoto;
      input.value = "";
      input.click();
    });

    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (!file || !file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = () => saveMasterPhoto(Number(input.dataset.target), reader.result);
      reader.readAsDataURL(file);
    });
  }

  /* ---------- ФОТО УСЛУГ (загружаемые пользователем) ---------- */
  function servicePhoto(s) {
    const saved = store.get("nogt_photo_svc_" + s.id, null);
    return saved && saved.length > 6 ? saved : s.img;
  }

  function saveServicePhoto(id, dataUrl) {
    store.set("nogt_photo_svc_" + id, dataUrl);
    $$('img[data-photo-svc="' + id + '"]').forEach((img) => { img.src = dataUrl; });
  }

  function initServicePhotoUpload() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.style.display = "none";
    document.body.appendChild(input);

    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-upload-photo-svc]");
      if (!btn) return;
      input.dataset.target = btn.dataset.uploadPhotoSvc;
      input.value = "";
      input.click();
    });

    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (!file || !file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = () => saveServicePhoto(Number(input.dataset.target), reader.result);
      reader.readAsDataURL(file);
    });
  }

  /* ---------- КАТАЛОГ УСЛУГ НА ЛЕНДИНГЕ ---------- */
  function renderCatalog() {
    const grid = $("#catalogGrid");
    if (!grid) return;
    grid.innerHTML = SERVICES.map((s) => `
      <article class="card-service">
        <div class="card-service__media-wrap">
          <img class="card-service__img" data-photo-svc="${s.id}" src="${servicePhoto(s)}" alt="${s.name}" />
          <button class="media-upload" data-upload-photo-svc="${s.id}" title="Загрузить фото" aria-label="Загрузить фото услуги ${s.name}">📷</button>
        </div>
        <div class="card-service__body">
          <h3 class="card-service__title">${s.name}</h3>
          <p class="card-service__desc">${s.desc}</p>
          <div class="card-service__meta">
            <span class="card-service__price">${money(s.price)}</span>
            <span class="card-service__time">⏱ ${s.duration}</span>
          </div>
          <a class="btn btn--primary btn--block" style="margin-top:16px" href="booking.html?service=${s.id}">Записаться</a>
        </div>
      </article>`).join("");
  }

  /* ---------- МАСТЕРА НА ЛЕНДИНГЕ ---------- */
  function renderMastersGrid() {
    const grid = $("#mastersGrid");
    if (!grid) return;
    grid.innerHTML = MASTERS.map((m) => `
      <div class="panel" style="text-align:center">
        <div class="master__photo-wrap">
          <img class="master__avatar" style="width:96px; height:96px" data-photo="${m.id}" src="${masterPhoto(m)}" alt="${m.name}" />
          <button class="avatar-upload" data-upload-photo="${m.id}" title="Загрузить фото" aria-label="Загрузить фото ${m.name}">📷</button>
        </div>
        <h3 style="font-family:var(--font-body); font-size:1.125rem">${m.name}</h3>
        <p style="color:var(--neutral-500); font-size:var(--text-sm)">${m.role}</p>
        <p style="color:var(--neutral-500); font-size:var(--text-sm); margin-top:var(--space-1)">в профессии ${m.exp}</p>
      </div>`).join("");
  }

  /* ---------- ПРЕДВЫБОР УСЛУГИ ВО ФЛОУ ---------- */
  function initBookingFlow() {
    const params = new URLSearchParams(location.search);
    const sid = Number(params.get("service"));
    if (sid) bookingDraft.service = SERVICES.find((s) => s.id === sid) || null;

    renderServiceStep();
    bindStepper();
  }

  function renderServiceStep() {
    const box = $("#serviceList");
    if (!box) return;
    box.innerHTML = SERVICES.map((s) => `
      <article class="card-service" data-service="${s.id}">
        <div class="card-service__media-wrap">
          <img class="card-service__img" data-photo-svc="${s.id}" src="${servicePhoto(s)}" alt="${s.name}" />
          <button class="media-upload" data-upload-photo-svc="${s.id}" title="Загрузить фото" aria-label="Загрузить фото услуги ${s.name}">📷</button>
        </div>
        <div class="card-service__body">
          <h3 class="card-service__title">${s.name}</h3>
          <p class="card-service__desc">${s.desc}</p>
          <div class="card-service__meta">
            <span class="card-service__price">${money(s.price)}</span>
            <span class="card-service__time">⏱ ${s.duration}</span>
          </div>
        </div>
      </article>`).join("");

    $$(".card-service[data-service]", box).forEach((card) => {
      card.addEventListener("click", (e) => {
        if (e.target.closest("[data-upload-photo-svc]")) return;
        const id = Number(card.dataset.service);
        bookingDraft.service = SERVICES.find((s) => s.id === id);
        bookingDraft.master = null;
        bookingDraft.date = null;
        bookingDraft.time = null;
        updateSummary();
        renderMasters();
        goToStep(2);
      });
    });

    if (bookingDraft.service) {
      const want = $("#serviceList [data-service=\"" + bookingDraft.service.id + "\"]");
      if (want) { want.classList.add("master--selected"); }
    }
  }

  /* ---------- МАСТЕРА ---------- */
  function availableMasters() {
    const svc = bookingDraft.service;
    if (!svc) return MASTERS;
    return MASTERS.filter((m) => m.services.includes(svc.id));
  }

  function renderMasters() {
    const box = $("#masterList");
    if (!box) return;
    const list = availableMasters();
    if (!list.length) {
      box.innerHTML = `<div class="alert alert--warning">Для этой услуги пока нет подходящего мастера. Выберите другую услугу.</div>`;
      return;
    }
    box.innerHTML = list.map((m) => `
      <div class="master" data-master="${m.id}">
        <div class="master__photo-wrap">
          <img class="master__avatar" data-photo="${m.id}" src="${masterPhoto(m)}" alt="${m.name}" />
          <button class="avatar-upload avatar-upload--sm" data-upload-photo="${m.id}" title="Загрузить фото" aria-label="Загрузить фото ${m.name}">📷</button>
        </div>
        <div>
          <div class="master__name">${m.name}</div>
          <div class="master__role">${m.role} · в профессии ${m.exp}</div>
        </div>
      </div>`).join("");

    $$(".master[data-master]", box).forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest("[data-upload-photo]")) return;
        bookingDraft.master = MASTERS.find((m) => m.id === Number(el.dataset.master));
        bookingDraft.date = null;
        bookingDraft.time = null;
        $$(".master", box).forEach((x) => x.classList.remove("master--selected"));
        el.classList.add("master--selected");
        updateSummary();
        renderCalendar();
        goToStep(3);
      });
    });
  }

  /* ---------- КАЛЕНДАРЬ ---------- */
  function renderCalendar() {
    const cal = $("#calendar");
    if (!cal) return;
    bookingDraft.date = null;
    bookingDraft.time = null;

    const today = new Date();
    const grid = [];
    grid.push('<div class="calendar__dow">пн</div><div class="calendar__dow">вт</div><div class="calendar__dow">ср</div><div class="calendar__dow">чт</div><div class="calendar__dow">пт</div><div class="calendar__dow">сб</div><div class="calendar__dow">вс</div>');

    // Начинаем с понедельника текущей недели
    const monday = addDays(today, 1 - ((today.getDay() + 6) % 7));
    for (let i = 0; i < 14; i++) {
      const d = addDays(monday, i);
      const inPast = d < addDays(today, 0) && fmtDate(d) !== fmtDate(today);
      const isWork = WORK_DAYS.includes(d.getDay());
      const busyCount = DEMO_BUSY[currentDayOffset] ? DEMO_BUSY[currentDayOffset].length : 0;
      // большинство рабочих дней доступны
      const hasFree = isWork && !inPast && busyCount < 5 && d.getDay() !== 0;

      grid.push(`
        <button type="button" class="calendar__day ${isWork ? "calendar__day--free" : "calendar__day--busy"}"
          data-offset="${i}" data-date="${fmtDate(d)}"
          ${hasFree ? "" : "disabled"}>
          ${d.getDate()}
        </button>`);
    }

    cal.innerHTML = grid.join("");
    $("#calendarMonth").textContent = `${MONTHS_RU[addDays(monday, 0).getMonth()].slice(0,3)} — ${MONTHS_RU[addDays(monday, 13).getMonth()].slice(0,3)} ${addDays(monday, 13).getFullYear()}`;

    $$(".calendar__day", cal).forEach((btn) => {
      if (btn.disabled) return;
      btn.addEventListener("click", () => {
        bookingDraft.date = btn.dataset.date;
        bookingDraft.dayOffset = Number(btn.dataset.offset);
        $$(".calendar__day", cal).forEach((x) => x.classList.remove("calendar__day--selected"));
        btn.classList.add("calendar__day--selected");
        renderSlots();
        updateSummary();
        goToStep(4);
      });
    });
  }

  /* ---------- СЛОТЫ ---------- */
  function renderSlots() {
    const box = $("#slotList");
    if (!box) return;
    const off = bookingDraft.dayOffset ?? 0;
    const busy = DEMO_BUSY[off] || [];
    const paused = DEMO_PAUSED[off] || [];
    const slots = [];
    for (let h = WORK_START; h < WORK_END; h++) {
      slots.push(`${h}:00`);
    }
    box.innerHTML = slots.map((t) => {
      const hour = Number(t.split(":")[0]);
      let cls = "slot";
      let disabled = false;
      if (busy.includes(hour))           { cls += " slot--busy"; disabled = true; }
      else if (paused.includes(hour))    { cls += " slot--paused"; disabled = true; }
      return `<button type="button" class="${cls}" data-time="${t}" ${disabled ? "disabled" : ""}>${t}</button>`;
    }).join("");

    $$(".slot", box).forEach((btn) => {
      if (btn.disabled) return;
      btn.addEventListener("click", () => {
        bookingDraft.time = btn.dataset.time;
        $$(".slot", box).forEach((x) => x.classList.remove("slot--selected"));
        btn.classList.add("slot--selected");
        updateSummary();
        goToStep(5);
      });
    });
  }

  /* ---------- РЕЗЮМЕ БРОНИ ---------- */
  function updateSummary() {
    const rows = { service: $("#sumService"), master: $("#sumMaster"), when: $("#sumWhen"), price: $("#sumPrice") };
    if (!rows.service) return;
    rows.service.textContent = bookingDraft.service ? bookingDraft.service.name : "—";
    rows.master.textContent = bookingDraft.master ? bookingDraft.master.name : "—";
    rows.when.textContent = (bookingDraft.date && bookingDraft.time)
      ? `${humanDate(new Date(bookingDraft.date + "T00:00:00"))} · ${bookingDraft.time}`
      : "—";
    rows.price.textContent = bookingDraft.service ? money(bookingDraft.service.price) : "—";
  }

  /* ---------- ШАГИ ---------- */
  const STEPS = [
    { id: "service", label: "Услуга" },
    { id: "master",  label: "Мастер" },
    { id: "date",    label: "Дата" },
    { id: "time",    label: "Время" },
    { id: "contacts",label: "Контакты" },
  ];

  function goToStep(n) {
    $$(".step").forEach((el) => el.classList.remove("is-visible"));
    const target = $("#step-" + STEPS[n - 1].id);
    if (target) target.classList.add("is-visible");

    $$(".stepper__step").forEach((el, i) => {
      el.classList.toggle("is-done", i < n - 1);
      el.classList.toggle("is-active", i === n - 1);
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function bindStepper() {
    // только переходы «назад»
    $$("[data-step]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const num = Number(btn.dataset.step);
        if (num >= 1) goToStep(num);
      });
    });

    // Контакты → подтверждение
    $("#submitBooking")?.addEventListener("click", () => {
      const name = $("#clientName").value.trim();
      const phone = $("#clientPhone").value.trim();
      if (!name) { markErr("#clientName", true); return; }
      if (phone.replace(/\D/g, "").length < 10) { markErr("#clientPhone", true); return; }
      markErr("#clientName", false);
      markErr("#clientPhone", false);

      const b = {
        id: Date.now(),
        service: bookingDraft.service.name,
        price: bookingDraft.service.price,
        master: bookingDraft.master.name,
        date: bookingDraft.date,
        time: bookingDraft.time,
        name,
        phone,
        status: "wait",
        createdAt: new Date().toISOString(),
      };
      store.addBooking(b);
      localStorage.setItem("nogt_last", JSON.stringify(b));
      location.href = "success.html";
    });
  }

  function markErr(sel, on) {
    const el = $(sel);
    if (el) el.closest(".field").classList.toggle("field--error", on);
  }

  // Автомат маски телефона
  document.addEventListener("input", (e) => {
    if (e.target.matches("#clientPhone")) {
      let v = e.target.value.replace(/\D/g, "");
      if (v.startsWith("8")) v = "7" + v.slice(1);
      if (v.startsWith("7")) v = v.slice(1);
      v = v.slice(0, 10);
      let out = "+7 (";
      if (v.length > 3)      out += v.slice(0, 3) + ") ";
      else if (v.length > 0) { out += v; e.target.value = out; return; }
      if (v.length > 6)      out += v.slice(3, 6) + "-" + v.slice(6, 8) + "-" + v.slice(8, 10);
      else if (v.length > 3) out += v.slice(3);
      e.target.value = out;
    }
  });

  /* ---------- «МОИ ЗАПИСИ» ---------- */
  function renderAppointments() {
    const list = $("#appointmentsList");
    if (!list) return;
    const bookings = store.bookings();
    if (!bookings.length) {
      list.innerHTML = `<div class="alert alert--warning">У вас пока нет записей. <a href="index.html">Выберите услугу</a> и запишитесь за 2 минуты.</div>`;
      return;
    }
    const STATUS = {
      wait:       `<span class="badge badge--wait">Ожидает подтверждения</span>`,
      confirmed:  `<span class="badge badge--confirmed">Подтверждена</span>`,
      done:       `<span class="badge badge--done">Выполнена</span>`,
      canceled:   `<span class="badge badge--canceled">Отменена</span>`,
    };
    list.innerHTML = bookings.map((b) => `
      <div class="card-appointment">
        <div class="card-appointment__top">
          <div>
            <div class="card-appointment__title">${b.service}</div>
            <div class="card-appointment__meta">${humanDate(new Date(b.date + "T00:00:00"))} · ${b.time} · Мастер: ${b.master}</div>
            <div class="card-appointment__meta">${money(b.price)}</div>
          </div>
          ${STATUS[b.status] || ""}
        </div>
        <div class="card-appointment__actions">
          <a class="btn btn--secondary btn--sm" href="javascript:void(0)" onclick="window.__cancel('${b.id}')">Отменить запись</a>
          <a class="btn btn--ghost btn--sm" href="index.html">Записаться ещё</a>
        </div>
      </div>`).join("");
  }
  window.__cancel = (id) => {
    store.removeBooking(Number(id));
    renderAppointments();
  };

  /* ---------- УСПЕХ ---------- */
  function renderSuccess() {
    const last = store.get("nogt_last", null);
    if (!last) { const box = $("#successBox"); if (box) box.innerHTML = `<p>Запись не найдена.</p>`; return; }
    const el = $("#successSummary");
    if (!el) return;
    el.innerHTML = `
      <div class="alert alert--success">✅ Запись создана, ждём подтверждения мастера</div>
      <div class="card-appointment">
        <div class="card-appointment__title">${last.service}</div>
        <dl class="summary">
          <div class="summary__row"><dt>Мастер</dt><dd>${last.master}</dd></div>
          <div class="summary__row"><dt>Дата и время</dt><dd>${humanDate(new Date(last.date + "T00:00:00"))} · ${last.time}</dd></div>
          <div class="summary__row"><dt>Контакт</dt><dd>${last.name}, ${last.phone}</dd></div>
          <div class="summary__divider"></div>
          <div class="summary__total summary__row"><dt>К оплате</dt><dd>${money(last.price)}</dd></div>
        </dl>
      </div>`;
  }

  /* ---------- АДМИН: ДАШБОРД И РАСПИСАНИЕ ---------- */
  function renderAdmin() {
    const bookings = store.bookings();
    const statCounts = $("#statCounts");
    if (statCounts) {
      const confirmed = bookings.filter((b) => ["wait", "confirmed"].includes(b.status)).length;
      const revenue = bookings.filter((b) => b.status !== "canceled").reduce((s, b) => s + b.price, 0);
      statCounts.innerHTML = `
        <div class="stat-card"><div class="stat-card__value">${bookings.length}</div><div class="stat-card__label">Записей всего</div></div>
        <div class="stat-card"><div class="stat-card__value">${confirmed}</div><div class="stat-card__label">Активные</div></div>
        <div class="stat-card"><div class="stat-card__value">${money(revenue)}</div><div class="stat-card__label">На сумму</div></div>
        <div class="stat-card"><div class="stat-card__value">${MASTERS.length}</div><div class="stat-card__label">Мастера</div></div>`;
    }

    const mastersBox = $("#mastersTableBody");
    if (mastersBox) {
      mastersBox.innerHTML = MASTERS.map((m) => `
        <tr>
          <td style="display:flex; align-items:center; gap:12px">
            <img class="master__avatar" style="width:40px; height:40px" data-photo="${m.id}" src="${masterPhoto(m)}" alt="${m.name}" />
            <b>${m.name}</b>
          </td>
          <td>${m.role}</td>
          <td>${m.exp}</td>
          <td>${m.services.map((id) => SERVICES.find((s) => s.id === id).name).join(", ")}</td>
        </tr>`).join("");
    }

    const tbody = $("#requestsBody");
    if (tbody) {
      if (!bookings.length) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--neutral-500)">Записей пока нет. Новые заявки появятся здесь автоматически ⏳</td></tr>`;
      } else {
        tbody.innerHTML = bookings.map((b) => `
          <tr>
            <td><b>${b.service}</b><br><small style="color:var(--neutral-500)">${b.master}</small></td>
            <td>${b.name}<br><small style="color:var(--neutral-500)">${b.phone}</small></td>
            <td>${humanDate(new Date(b.date + "T00:00:00"))} · ${b.time}</td>
            <td>${money(b.price)}</td>
            <td>${b.status === "wait" ? `<span class="badge badge--wait">Ожидает</span>` : b.status === "confirmed" ? `<span class="badge badge--confirmed">Подтверждена</span>` : `<span class="badge badge--done">Выполнена</span>`}</td>
          </tr>`).join("");
      }
    }

    const sch = $("#scheduleWeek");
    if (sch) {
      const todayWeekday = new Date().getDay();
      const monday = addDays(new Date(), 1 - ((new Date().getDay() + 6) % 7));
      let col = `<div></div>`;
      for (let i = 0; i < 7; i++) {
        const d = addDays(monday, i);
        const isToday = d.getDay() === todayWeekday;
        col += `<div class="schedule__day">
          <div class="schedule__day-head">${WEEK_DAYS_SHORT[d.getDay()]}<br>${d.getDate()}</div>
          <div class="schedule__block ${isToday ? "schedule__block--booked" : ""}">${isToday ? "10:00 – Алена · Маникюр" : "—"}</div>
          <div class="schedule__block schedule__block--paused">13:00 – перерыв</div>
        </div>`;
      }
      sch.innerHTML = col;
    }
  }

  /* ---------- ИНИЦИАЛИЗАЦИЯ ---------- */
  function init() {
    if ($("#catalogGrid")) renderCatalog();
    if ($("#mastersGrid")) renderMastersGrid();
    if ($("#serviceList")) initBookingFlow();
    if ($("#masterList"))  renderMasters();
    if ($("#calendar"))    { renderCalendar(); goToStep(1); }
    if ($("#appointmentsList")) renderAppointments();
    if ($("#successSummary")) renderSuccess();
    if ($("#adminApp"))    renderAdmin();
    if ($("#clientName"))  goToStep(1);
  }

  document.addEventListener("DOMContentLoaded", init);
  document.addEventListener("DOMContentLoaded", initPhotoUpload);
  document.addEventListener("DOMContentLoaded", initServicePhotoUpload);
})();