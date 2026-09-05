const axios = require('axios');
const messageRepo = require('../repositories/message.repository');
const { normalizeWhatsAppPhone } = require('../utils/phone');

const API_URL = 'https://graph.facebook.com/v21.0';

function getConfig() {
  return {
    token: process.env.WHATSAPP_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  };
}

async function sendRequest(payload) {
  const { token, phoneNumberId } = getConfig();
  if (!token || !phoneNumberId) {
    console.warn('[WhatsApp] Missing WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID — message not sent');
    console.log('[WhatsApp] Would send:', JSON.stringify(payload, null, 2));
    return { mock: true };
  }

  payload.to = normalizeWhatsAppPhone(payload.to);
  if (!payload.to) {
    throw new Error('Invalid WhatsApp phone number');
  }

  const url = `${API_URL}/${phoneNumberId}/messages`;
  try {
    const response = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    return response.data;
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.error('[WhatsApp] Send failed:', detail, '| to:', payload.to);
    throw new Error(detail);
  }
}

async function logOutbound(phone, content, messageType, bookingId, metadata) {
  await messageRepo.log({
    guest_phone: normalizeWhatsAppPhone(phone) || phone,
    booking_id: bookingId,
    direction: 'outbound',
    message_type: messageType,
    content,
    metadata,
  });
}

async function sendText(to, text, bookingId) {
  await logOutbound(to, text, 'text', bookingId);
  return sendRequest({
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  });
}

async function sendButtons(to, bodyText, buttons, bookingId, options = {}) {
  let imageUrl = options.imageUrl;
  // Resolve relative /menu/... paths to public URL for WhatsApp
  if (imageUrl && imageUrl.startsWith('/')) {
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    imageUrl = base ? `${base}${imageUrl}` : null;
  }

  await logOutbound(to, bodyText, 'button', bookingId, { buttons, image: imageUrl });

  const interactive = {
    type: 'button',
    body: { text: bodyText },
    action: {
      buttons: buttons.slice(0, 3).map((b) => ({
        type: 'reply',
        reply: { id: b.id, title: b.title.slice(0, 20) },
      })),
    },
  };

  if (imageUrl) {
    interactive.header = {
      type: 'image',
      image: { link: imageUrl },
    };
  }
  if (options.footer) {
    interactive.footer = { text: options.footer.slice(0, 60) };
  }

  return sendRequest({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive,
  });
}

async function sendImage(to, imageUrl, caption, bookingId) {
  await logOutbound(to, caption || imageUrl, 'text', bookingId, { imageUrl });
  return sendRequest({
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: {
      link: imageUrl,
      ...(caption ? { caption: caption.slice(0, 1024) } : {}),
    },
  });
}

async function sendList(to, bodyText, buttonText, sections, bookingId) {
  await logOutbound(to, bodyText, 'list', bookingId, { sections });
  return sendRequest({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: { button: buttonText.slice(0, 20), sections },
    },
  });
}

/**
 * Send a WhatsApp Flow (e.g. laundry CheckboxGroup form).
 * Requires published Flow ID from Meta Business Manager.
 */
async function sendFlow(to, options, bookingId) {
  const {
    flowId,
    flowCta = 'Open Form',
    bodyText,
    headerText,
    footerText,
    screen = null,
    flowToken = null,
  } = options;

  if (!flowId) throw new Error('flowId is required');

  await logOutbound(to, bodyText || `Flow: ${flowId}`, 'interactive', bookingId, {
    flowId,
    flowCta,
  });

  const parameters = {
    flow_message_version: '3',
    flow_id: String(flowId),
    flow_cta: flowCta.slice(0, 30),
    flow_action: screen ? 'navigate' : 'navigate',
  };

  if (flowToken) parameters.flow_token = String(flowToken);
  if (screen) {
    parameters.flow_action_payload = {
      screen,
      data: {},
    };
  }

  const interactive = {
    type: 'flow',
    body: { text: bodyText || 'Please fill the form' },
    action: {
      name: 'flow',
      parameters,
    },
  };

  if (headerText) {
    interactive.header = { type: 'text', text: headerText.slice(0, 60) };
  }
  if (footerText) {
    interactive.footer = { text: footerText.slice(0, 60) };
  }

  return sendRequest({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive,
  });
}

/**
 * Send an approved WhatsApp template (needed outside 24h session).
 * bodyParams: array of strings mapped to {{1}}, {{2}}, ...
 */
async function sendTemplate(to, name, bodyParams = [], bookingId, languageCode = 'en') {
  await logOutbound(to, `[template:${name}] ${bodyParams.join(' | ')}`, 'text', bookingId, {
    template: name,
    bodyParams,
  });

  const components = [];
  if (bodyParams.length) {
    components.push({
      type: 'body',
      parameters: bodyParams.map((text) => ({
        type: 'text',
        text: String(text).slice(0, 1024) || '-',
      })),
    });
  }

  return sendRequest({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name,
      language: { code: languageCode },
      ...(components.length ? { components } : {}),
    },
  });
}

/**
 * Session text first; if 24h window closed, send matching template.
 */
async function sendTextOrTemplate(to, text, bookingId, template) {
  try {
    return await sendText(to, text, bookingId);
  } catch (err) {
    const msg = String(err.message || '');
    const outsideWindow = /131047|24 hour|outside.*window|not in/i.test(msg);
    if (outsideWindow && template?.name) {
      console.warn('[WhatsApp] Session closed, sending template:', template.name);
      return sendTemplate(to, template.name, template.params || [], bookingId, template.language || 'en');
    }
    throw err;
  }
}

module.exports = {
  sendText,
  sendButtons,
  sendList,
  sendImage,
  sendFlow,
  sendTemplate,
  sendTextOrTemplate,
  sendRequest,
};
