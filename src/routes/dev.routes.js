const express = require('express');
const funnel = require('../services/funnel.service');
const { success, error } = require('../utils/response');

const router = express.Router();

// Local testing only — simulate an incoming WhatsApp text message
router.post('/simulate', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return error(res, 'Not available in production', 403);
  }

  const { phone, message } = req.body;
  if (!phone || !message) return error(res, 'phone and message required');

  const mockMessage = {
    id: `sim_${Date.now()}`,
    type: 'text',
    text: { body: message },
  };

  try {
    await funnel.handleIncoming(phone, mockMessage);
    return success(res, { simulated: true, phone, message });
  } catch (err) {
    console.error('[Simulate]', err);
    return error(res, err.message, 500);
  }
});

module.exports = router;
