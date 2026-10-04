'use strict';

// Уведомления внутри кабинета. Работают только здесь: почта и внешние сервисы
// не подключаются.
//
// GET /notifications — список уведомлений пользователя ВМЕСТЕ со счётчиком
// непрочитанных. Отдельного запроса ради одного числа нет: счётчик нужен и
// шапке, и экрану, а список всё равно забирает экран.
//
// POST /notifications/:id/read — отметка «прочитано», только своё уведомление.

const express = require('express');

const { asyncH } = require('../lib/http');
const { authRequired } = require('../middleware/auth');
const notifications = require('../lib/notifications');
const v = require('../lib/validate');

const router = express.Router();

router.get(
  '/',
  authRequired,
  asyncH(async (req, res) => {
    const list = notifications.listNotifications(req.user.id);
    return res.json({
      notifications: list,
      // Счётчик идёт в этом же ответе — отдельный эндпоинт не нужен.
      unread: notifications.unreadCount(req.user.id),
    });
  })
);

router.post(
  '/:id/read',
  authRequired,
  asyncH(async (req, res) => {
    const id = v.intId(req.params.id, 'id');
    if (!notifications.markRead(req.user.id, id)) {
      return res.status(404).json({ error: { message: 'Уведомление не найдено.', code: 'NOT_FOUND' } });
    }
    return res.json({
      notification_id: id,
      unread: notifications.unreadCount(req.user.id),
    });
  })
);

module.exports = router;