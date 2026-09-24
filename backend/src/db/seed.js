'use strict';

// Тестовые данные для разработки: пользователи (admin/master/client) с хешами
// паролей, мастера, услуги, график, клиенты и записи на ближайшие рабочие дни.
// Повторный запуск безопасен: уже существующие данные не дублируются.

const bcrypt = require('bcryptjs');

const config = require('../config');
const db = require('./connection');

const BCRYPT_COST = 12;

function ts() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

// Ближайший рабочий день (вт–сб, weekday 2..6), не раньше завтра
function nextWorkingDay(from) {
  const d = new Date(from);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  while (d.getDay() < 2 || d.getDay() > 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

const hasService = db.prepare('SELECT id FROM services WHERE name = ?');
const hasMaster = db.prepare('SELECT id FROM masters WHERE name = ?');
const hasUser = db.prepare('SELECT 1 FROM users WHERE username = ?');
const hasClient = db.prepare('SELECT 1 FROM clients WHERE phone = ?');
const hasSchedule = db.prepare('SELECT 1 FROM master_schedule WHERE master_id = ? AND weekday = ?');
const hasLink = db.prepare('SELECT 1 FROM master_services WHERE master_id = ? AND service_id = ?');
const hasBooking = db.prepare('SELECT 1 FROM bookings WHERE master_id = ? AND starts_at = ?');
const hasStudio = db.prepare('SELECT 1 FROM studio_info WHERE id = 1');

// 1. Три пользователя: администратор, мастер, клиент (роли из users.role)
//    Пароли храним только хешем (bcrypt cost=12) — как в боевом коде.
const USERS = [
  { username: 'admin', password: 'admin12345', role: 'owner', masterName: null },
  { username: 'master', password: 'master12345', role: 'master', masterName: 'Екатерина' },
  { username: 'client', password: 'client12345', role: 'client', masterName: null },
];

// 2. Два мастера с профилями и специализациями
const MASTERS = [
  {
    name: 'Екатерина',
    role: 'Мастер маникюра и бровей',
    since: 2019,
    services: ['Маникюр с покрытием гель-лаком', 'Маникюр и педикюр', 'Наращивание ногтей', 'Коррекция и окрашивание бровей', 'Ламинирование бровей'],
  },
  {
    name: 'Анна',
    role: 'Мастер маникюра',
    since: 2021,
    services: ['Маникюр с покрытием гель-лаком', 'Маникюр и педикюр', 'Наращивание ногтей'],
  },
];

// 3. Пять услуг: цена в копейках, длительность в минутах
const SERVICES = [
  { name: 'Маникюр с покрытием гель-лаком', desc: 'Уход за ногтями и стойкое покрытие на 3–4 недели', price: 180000, dur: 90 },
  { name: 'Маникюр и педикюр', desc: 'Комплекс из двух процедур за один визит', price: 320000, dur: 150 },
  { name: 'Наращивание ногтей', desc: 'Моделирование желаемой формы и длины ногтей', price: 280000, dur: 150 },
  { name: 'Коррекция и окрашивание бровей', desc: 'Коррекция формы и окрашивание волосков', price: 120000, dur: 40 },
  { name: 'Ламинирование бровей', desc: 'Укладка и стойкая форма бровей на 4–6 недель', price: 180000, dur: 60 },
];

// Клиенты для записей (таблица clients — отдельно от роли 'client' в users)
const CLIENTS = [
  { name: 'Анна Петрова', phone: '+79000000001', tg: null },
  { name: 'Ирина Соколова', phone: '+79000000002', tg: 987654321 },
];

// Счётчики для итогового вывода «что появилось в базе»
const counts = {
  studio_info: 0,
  services: 0,
  masters: 0,
  master_services: 0,
  master_schedule: 0,
  users: 0,
  clients: 0,
  bookings: 0,
};

function insertStudio() {
  if (hasStudio.get()) return;
  db.prepare(
    'INSERT INTO studio_info (id, studio_name, address, phone, telegram, map_hint, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)'
  ).run('Ноготочки', 'г. Воронеж, Проспект Революции, д. 10', '+79004535000', '@Vibekatena', 'Вход во дворе, вывеска «Ноготочки»', ts());
  counts.studio_info += 1;
}

function insertServices() {
  const ids = {};
  const ins = db.prepare(
    'INSERT INTO services (name, description, price_kopecks, duration_minutes, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  for (const s of SERVICES) {
    const row = hasService.get(s.name);
    if (row) {
      ids[s.name] = row.id;
      continue;
    }
    ids[s.name] = ins.run(s.name, s.desc, s.price, s.dur, ts()).lastInsertRowid;
    counts.services += 1;
  }
  return ids;
}

function insertMasters(serviceIds) {
  const ids = {};
  const insMaster = db.prepare(
    'INSERT INTO masters (name, role, experience_years, photo_path, created_at) VALUES (?, ?, ?, NULL, ?)'
  );
  const insLink = db.prepare('INSERT INTO master_services (master_id, service_id) VALUES (?, ?)');
  const insSched = db.prepare(
    'INSERT INTO master_schedule (master_id, weekday, start_minutes, end_minutes) VALUES (?, ?, ?, ?)'
  );

  for (const m of MASTERS) {
    let mid = hasMaster.get(m.name);
    if (!mid) {
      mid = {
        id: insMaster.run(m.name, m.role, new Date().getFullYear() - m.since, ts()).lastInsertRowid,
      };
      counts.masters += 1;
    }
    ids[m.name] = mid.id;

    // Связи «мастер умеет услугу» + график вт–сб 10:00–20:00
    for (const sname of m.services) {
      if (!hasLink.get(mid.id, serviceIds[sname])) {
        insLink.run(mid.id, serviceIds[sname]);
        counts.master_services += 1;
      }
    }
    for (let wd = 2; wd <= 6; wd += 1) {
      if (!hasSchedule.get(mid.id, wd)) {
        insSched.run(mid.id, wd, 600, 1200);
        counts.master_schedule += 1;
      }
    }
  }
  return ids;
}

function insertUsers(masterIds) {
  const ins = db.prepare(
    'INSERT INTO users (username, password_hash, master_id, role, is_active) VALUES (?, ?, ?, ?, 1)'
  );
  for (const u of USERS) {
    if (hasUser.get(u.username)) continue;
    const hash = bcrypt.hashSync(u.password, BCRYPT_COST);
    ins.run(u.username, hash, u.masterName ? masterIds[u.masterName] : null, u.role);
    counts.users += 1;
  }
}

function insertClients() {
  const ins = db.prepare('INSERT INTO clients (name, phone, telegram_id, created_at) VALUES (?, ?, ?, ?)');
  for (const c of CLIENTS) {
    if (hasClient.get(c.phone)) continue;
    ins.run(c.name, c.phone, c.tg, ts());
    counts.clients += 1;
  }
}

// 5. Две-три записи на ближайшие рабочие дни, чтобы календарь не был пустым.
//    Даты считаются от «сегодня»; слоты не пересекаются с графиком.
//    Повторно записи не создаются: сидим их ровно один раз (пока таблица пуста).
function insertBookings(masterIds, serviceIds) {
  const bookingsCount = db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n;
  if (bookingsCount > 0) {
    console.log('Записи уже есть — пропускаю (чтобы не копить дубли при каждом запуске).');
    return;
  }
  const ins = db.prepare(
    'INSERT INTO bookings (client_id, service_id, master_id, starts_at, ends_at, status, comment, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const clientByPhone = db.prepare('SELECT id FROM clients WHERE phone = ?');

  const day1 = nextWorkingDay(new Date());
  const day2 = nextWorkingDay(day1);

  const slots = [
    {
      master: 'Екатерина',
      service: 'Маникюр с покрытием гель-лаком',
      day: day1, hour: 11, min: 0,
      client: '+79000000001', status: 'confirmed', source: 'web', comment: null,
    },
    {
      master: 'Анна',
      service: 'Маникюр и педикюр',
      day: day1, hour: 13, min: 0,
      client: '+79000000002', status: 'wait', source: 'telegram', comment: 'Хочу нюдовый дизайн',
    },
    {
      master: 'Екатерина',
      service: 'Ламинирование бровей',
      day: day2, hour: 10, min: 30,
      client: '+79000000001', status: 'confirmed', source: 'web', comment: null,
    },
  ];

  for (const s of slots) {
    const starts = new Date(s.day);
    starts.setHours(s.hour, s.min, 0, 0);
    const startsAt = fmtDate(starts);
    if (hasBooking.get(masterIds[s.master], startsAt)) continue;

    const service = SERVICES.find((x) => x.name === s.service);
    const endsAt = fmtDate(addMinutes(starts, service.dur));
    ins.run(
      clientByPhone.get(s.client).id,
      serviceIds[s.service],
      masterIds[s.master],
      startsAt,
      endsAt,
      s.status,
      s.comment,
      s.source,
      ts()
    );
    counts.bookings += 1;
  }
}

function summary() {
  const line = (label, rows) => {
    console.log(`\n${label} (${rows.length}):`);
    for (const r of rows) console.log('  ' + r);
  };

  line('Пользователи', db
    .prepare('SELECT username, role, is_active FROM users ORDER BY id')
    .all()
    .map((u) => `${u.username} — роль: ${u.role}, активен: ${u.is_active ? 'да' : 'нет'}`));

  line('Мастера', db
    .prepare('SELECT name, role, experience_years FROM masters ORDER BY id')
    .all()
    .map((m) => `${m.name} — ${m.role}, в профессии с опытом ${m.experience_years} г.`));

  line('Услуги', db
    .prepare('SELECT name, price_kopecks, duration_minutes, is_active FROM services ORDER BY id')
    .all()
    .map((s) => `${s.name} — ${(s.price_kopecks / 100).toFixed(0).replace('.', ',')} ₽, ${s.duration_minutes} мин, активна: ${s.is_active ? 'да' : 'нет'}`));

  line('График мастеров', db
    .prepare(`
      SELECT m.name AS master, ms.weekday, ms.start_minutes, ms.end_minutes
      FROM master_schedule ms JOIN masters m ON m.id = ms.master_id
      ORDER BY ms.master_id, ms.weekday`)
    .all()
    .map((r) => {
      const days = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
      const hm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
      return `${r.master}: ${days[r.weekday]} ${hm(r.start_minutes)}–${hm(r.end_minutes)}`;
    }));

  line('Клиенты', db
    .prepare('SELECT name, phone, telegram_id FROM clients ORDER BY id')
    .all()
    .map((c) => `${c.name}, тел. ${c.phone}${c.telegram_id ? `, tg ${c.telegram_id}` : ''}`));

  line('Записи', db
    .prepare(`
      SELECT b.starts_at, b.ends_at, b.status, b.source,
             m.name AS master, s.name AS service, c.name AS client
      FROM bookings b
      JOIN masters m ON m.id = b.master_id
      JOIN services s ON s.id = b.service_id
      JOIN clients c ON c.id = b.client_id
      ORDER BY b.starts_at`)
    .all()
    .map((b) => `${b.starts_at}–${b.ends_at} | ${b.client} → ${b.service} | мастер: ${b.master} | ${b.status} (${b.source})`));

  console.log('\nСоздано за этот запуск:', JSON.stringify(counts));
}

module.exports = function seed() {
  if (config.nodeEnv === 'production') {
    throw new Error('[db:seed] Запрещено при NODE_ENV=production: тестовые данные не должны попадать в боевую базу.');
  }

  db.transaction(() => {
    insertStudio();
    const serviceIds = insertServices();
    const masterIds = insertMasters(serviceIds);
    insertUsers(masterIds);
    insertClients();
    insertBookings(masterIds, serviceIds);
  })();

  console.log('Сид применён.');
  summary();
};

if (require.main === module) {
  seed();
  db.close();
}