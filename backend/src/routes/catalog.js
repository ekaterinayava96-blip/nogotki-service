'use strict';

// Публичный каталог: услуги и мастера.

const express = require('express');

const db = require('../db/connection');
const q = require('../repo/queries');
const { asyncH } = require('../lib/http');

const router = express.Router();

// Список активных услуг: только публичные поля, цены в копейках.
router.get(
  '/services',
  asyncH(async (req, res) => {
    res.json({
      services: q.listServices({ activeOnly: true }).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        price_kopecks: s.price_kopecks,
        duration_minutes: s.duration_minutes,
      })),
    });
  })
);

// Список активных мастеров с их услугами.
router.get(
  '/masters',
  asyncH(async (req, res) => {
    res.json({ masters: q.listMasters({ activeOnly: true }) });
  })
);

// Информация о студии: название, адрес, телефон, Telegram, подсказка как найти.
// График работы студии — сводка расписаний активных мастеров по дням недели
// (общее «окно работы» студии на день: минимум старта — максимум конца).
router.get(
  '/studio',
  asyncH(async (req, res) => {
    const info = q.studioInfo();
    if (!info) {
      return res.status(404).json({ error: { message: 'Информация о студии не заполнена.', code: 'NOT_FOUND' } });
    }
    const schedule = db
      .prepare(`
        SELECT ms.weekday,
               MIN(ms.start_minutes) AS start_minutes,
               MAX(ms.end_minutes) AS end_minutes
        FROM master_schedule ms
        JOIN masters m ON m.id = ms.master_id
        WHERE m.is_active = 1
        GROUP BY ms.weekday
        ORDER BY ms.weekday`)
      .all();
    res.json({
      studio: {
        id: info.id,
        studio_name: info.studio_name,
        address: info.address,
        phone: info.phone,
        telegram: info.telegram,
        map_hint: info.map_hint,
        work_hours: schedule.map((s) => ({
          weekday: s.weekday,
          start_minutes: s.start_minutes,
          end_minutes: s.end_minutes,
        })),
      },
    });
  })
);

module.exports = router;