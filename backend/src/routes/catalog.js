'use strict';

// Публичный каталог: услуги и мастера.

const express = require('express');

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

module.exports = router;