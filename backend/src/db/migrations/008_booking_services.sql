-- Миграция 008: несколько услуг в одной записи.
--  1) booking_services — услуги записи. Раньше запись могла быть только на одну
--     услугу (bookings.service_id), поэтому цену и длительность считали по
--     одному JOIN'у. Теперь у записи есть СПИСОК услуг, а цена/длительность
--     сохраняются снимком на момент записи: правка прайса не переписывает
--     историю уже сделанных записей.
--  2) hold_services — какие услуги закрывает удержание слота. Раньше
--     удержание хранило только суммарную длительность, и запись сверялась с ним
--     по времени; теперь сверка идёт по набору услуг (наборы с одинаковой
--     суммой минут — разные услуги).
--
-- Обратная совместимость:
--  * bookings.service_id остаётся и равна ПЕРВОЙ услуге записи (position = 1).
--    Старая статистика, админка, сид и бот продолжают видеть одну услугу.
--  * В booking_services попадает каждая услуга записи, включая первую, —
--    список всегда полный и не требует «догадываться» по bookings.service_id.
--  * Удержания, созданные до миграции, в hold_services не попадают (услуги
--    тогда не хранились). Для них сверка остаётся по длительности — такие
--    удержания живут 10 минут, после чего удаляются по expires_at.

CREATE TABLE booking_services (
  booking_id       INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  service_id       INTEGER NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  position         INTEGER NOT NULL CHECK (position >= 1),
  -- Снимок на момент записи: услугу могут переоценить или переименовать,
  -- а сумма в истории записей должна остаться прежней.
  price_kopecks    INTEGER NOT NULL CHECK (price_kopecks >= 0),
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  PRIMARY KEY (booking_id, service_id)
);

-- Поиск «кто записан на услугу» — например, при проверке удаления услуги.
CREATE INDEX idx_booking_services_service ON booking_services(service_id);

INSERT INTO booking_services (booking_id, service_id, position, price_kopecks, duration_minutes)
SELECT b.id, b.service_id, 1, s.price_kopecks, s.duration_minutes
FROM bookings b
JOIN services s ON s.id = b.service_id;

CREATE TABLE hold_services (
  hold_id    INTEGER NOT NULL REFERENCES slot_holds(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  PRIMARY KEY (hold_id, service_id)
);
