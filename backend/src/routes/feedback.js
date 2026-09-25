'use strict';

// Обратная связь клиентов (функция паспорта «Обратная связь и отзывы»):
// клиент оставляет отзыв/жалобу/вопрос, владелец смотрит и меняет статус.

const express = require('express');

const q = require('../repo/queries');
const v = require('../lib/validate');
const { asyncH } = require('../lib/http');
const { authRequired, requireRole, hasRole } = require('../middleware/auth');

const router = express.Router();

// POST /feedback — клиент оставляет отзыв. body: { text }
router.post(
  '/',
  requireRole('client'),
  asyncH(async (req, res) => {
    const text = v.str(req.body.text, 'text', { min: 1, max: 2000 });
    const clientId = q.clientIdForUser(req.user.id);
    if (!clientId) {
      return res.status(403).json({ error: { message: 'Профиль клиента не найден.', code: 'NO_CLIENT_PROFILE' } });
    }
    const id = q.createFeedback({ clientId, text });
    return res.status(201).json({ feedback: q.serializeFeedback(q.feedbackById(id)) });
  })
);

// GET /feedback — свои отзывы текущего клиента.
router.get(
  '/',
  authRequired,
  asyncH(async (req, res) => {
    if (hasRole(req.user, 'client')) {
      const clientId = q.clientIdForUser(req.user.id);
      return res.json({ feedback: clientId ? q.listFeedback({ clientId }) : [] });
    }
    // owner видит все отзывы (то же, что и /admin/feedback, но без панели)
    return res.json({ feedback: q.listFeedback({}) });
  })
);

module.exports = router;