const guestService = require('./guest.service');
const whatsapp = require('./whatsapp.service');
const openai = require('./openai.service');
const orderService = require('./order.service');
const requestService = require('./request.service');
const flowService = require('./flow.service');
const menuRepo = require('../repositories/menu.repository');
const messageRepo = require('../repositories/message.repository');
const hotelRepo = require('../repositories/hotel.repository');
const faqRepo = require('../repositories/faq.repository');
const orderRepo = require('../repositories/order.repository');
const requestRepo = require('../repositories/request.repository');

const HOTEL_ID = parseInt(process.env.DEFAULT_HOTEL_ID || '1', 10);

// WhatsApp Flows OFF for demo until Meta Business is verified/approved.
// Set USE_WHATSAPP_FLOWS=true in .env after Flow IDs are published.
const USE_WHATSAPP_FLOWS = process.env.USE_WHATSAPP_FLOWS === 'true';

const LAUNDRY_ITEMS = flowService.LAUNDRY_CATALOG;

async function handleIncoming(phone, message) {
  const { type, text, interactive } = parseMessage(message);

  await messageRepo.log({
    guest_phone: phone,
    direction: 'inbound',
    message_type: type,
    content: text || JSON.stringify(interactive),
    wa_message_id: message.id,
  });

  // 1) Always verify active check-in first
  const booking = await guestService.authenticateGuest(phone);
  const session = await guestService.getOrCreateSession(phone);
  const sessionData = guestService.parseSessionData(session);

  // 2) WhatsApp Flow completion — only when USE_WHATSAPP_FLOWS=true
  if (USE_WHATSAPP_FLOWS && interactive?.kind === 'flow') {
    return handleFlowSubmission(phone, booking, interactive.response);
  }

  if (interactive) {
    return handleInteractive(phone, interactive, booking, session, sessionData);
  }

  if (session.current_state !== 'idle' && type === 'text') {
    return handleStateInput(phone, text, booking, session, sessionData);
  }

  return handleFreeText(phone, text, booking, session, sessionData);
}

function parseMessage(message) {
  if (message.type === 'text') {
    return { type: 'text', text: message.text.body };
  }
  if (message.type === 'interactive') {
    const interactive = message.interactive;
    if (interactive.type === 'button_reply') {
      return {
        type: 'interactive',
        interactive: {
          kind: 'button',
          id: interactive.button_reply.id,
          title: interactive.button_reply.title,
        },
      };
    }
    if (interactive.type === 'list_reply') {
      return {
        type: 'interactive',
        interactive: {
          kind: 'list',
          id: interactive.list_reply.id,
          title: interactive.list_reply.title,
        },
      };
    }
    // WhatsApp Flows submit → nfm_reply
    if (interactive.type === 'nfm_reply') {
      const parsed = flowService.parseFlowResponse(interactive.nfm_reply?.response_json);
      return {
        type: 'interactive',
        interactive: {
          kind: 'flow',
          response: parsed,
          body: interactive.nfm_reply?.body,
        },
      };
    }
  }
  return { type: 'unknown', text: '' };
}

/**
 * After Flow form submit — route by flow_name. Guest already check-in verified.
 */
async function handleFlowSubmission(phone, booking, flowResponse) {
  if (!booking) return blockNonGuest(phone);
  if (!flowResponse) {
    return whatsapp.sendText(phone, 'Form submit incomplete. Please try again.', booking.id);
  }

  const name = flowResponse.flow_name || flowResponse.raw?.flow_name;
  const raw = flowResponse.raw || {};

  switch (name) {
    case 'laundry_press':
    case 'laundry': {
      if (!flowResponse.items?.length) {
        return whatsapp.sendText(phone, 'Koi item select nahi hua.', booking.id)
          .then(() => sendLaundryMenu(phone, booking));
      }
      const laundryCart = flowService.buildLaundryCartFromFlowItems(flowResponse.items);
      if (!laundryCart.length) {
        return whatsapp.sendText(phone, 'Invalid laundry items.', booking.id);
      }
      return placeLaundryOrder(phone, booking, { laundryCart });
    }

    case 'housekeeping': {
      const labels = flowService.labelHousekeepingItems(flowResponse.items || []);
      if (!labels) {
        return whatsapp.sendText(phone, 'Please select at least one item.', booking.id)
          .then(() => sendHousekeepingMenu(phone, booking));
      }
      return createHousekeepingRequest(phone, booking, labels);
    }

    case 'valet': {
      const sub = flowService.labelValet(raw.valet_type);
      return createValetRequest(phone, booking, sub);
    }

    case 'transport': {
      const dest = flowService.labelDestination(raw.destination);
      const notes = raw.notes ? ` | Notes: ${raw.notes}` : '';
      return createTransportRequest(phone, booking, `${dest}${notes}`);
    }

    case 'maintenance': {
      const issue = [raw.issue_type, raw.details].filter(Boolean).join(': ') || 'Maintenance issue';
      const priority = raw.priority || 'medium';
      return createMaintenanceRequest(phone, booking, issue, priority);
    }

    case 'checkout': {
      if (raw.checkout_type === 'late') {
        const desc = `Late checkout request${raw.preferred_time ? ` at ${raw.preferred_time}` : ''}`;
        return createLateCheckoutRequest(phone, booking, desc);
      }
      return createCheckoutRequest(phone, booking);
    }

    case 'food': {
      return placeFoodOrderFromFlow(phone, booking, flowResponse.items || [], raw.quantity_each || '1');
    }

    default:
      console.warn('[Flow] Unknown flow_name:', name, raw);
      return whatsapp.sendText(phone, 'Request received. Front desk will follow up.', booking.id);
  }
}

async function openHotelFlow(phone, booking, flowKey, bodyExtra = '') {
  // Disabled for demo — enable with USE_WHATSAPP_FLOWS=true after Meta approval
  if (!USE_WHATSAPP_FLOWS) return false;

  const meta = flowService.getFlowMeta(flowKey);
  const flowId = flowService.getFlowId(flowKey);
  if (!meta || !flowId) return false;

  await guestService.updateSession(phone, `${flowKey}_flow`, {}, booking.id);
  try {
    await whatsapp.sendFlow(
      phone,
      {
        flowId,
        flowCta: meta.cta,
        headerText: meta.header,
        bodyText: `Room ${booking.room_number}\n\n${bodyExtra || 'Form fill karke submit karein.'}`.slice(0, 1024),
        footerText: 'Hotel Services',
        screen: meta.screen,
        flowToken: `${flowKey}:${booking.id}:${phone}`,
      },
      booking.id
    );
    return true;
  } catch (err) {
    console.error(`[Flow] ${flowKey} send failed:`, err.message);
    return false;
  }
}

async function placeFoodOrderFromFlow(phone, booking, itemKeys, qtyEach) {
  const qty = Math.min(3, Math.max(1, parseInt(qtyEach, 10) || 1));
  const allItems = await menuRepo.findAllItems(HOTEL_ID);
  const cart = [];

  for (const key of itemKeys) {
    const wantName = flowService.FOOD_FLOW_ITEMS[key];
    if (!wantName) continue;
    const menuItem = allItems.find(
      (i) => i.is_available && i.name.toLowerCase() === wantName.toLowerCase()
    );
    if (!menuItem) continue;
    cart.push({
      menu_item_id: menuItem.id,
      name: menuItem.name,
      quantity: qty,
      price: parseFloat(menuItem.price),
    });
  }

  if (!cart.length) {
    return whatsapp.sendText(phone, 'Selected items menu mein available nahi. Chat se order karein.', booking.id)
      .then(() => startFoodFlow(phone, booking));
  }

  return confirmOrder(phone, booking, { cart });
}

async function handleInteractive(phone, interactive, booking, session, sessionData) {
  const { id } = interactive;
  if (!booking && !id.startsWith('main_')) {
    return blockNonGuest(phone);
  }

  // Main menu
  if (id === 'main_food') return startFoodFlow(phone, booking);
  if (id === 'main_laundry') return sendLaundryMenu(phone, booking);
  if (id === 'main_transport') return sendTransportMenu(phone, booking);
  if (id === 'main_facilities') return sendFacilitiesMenu(phone, booking);
  if (id === 'main_reception') return createReceptionRequest(phone, booking);
  if (id === 'main_services') return sendServicesMenu(phone, booking);
  if (id === 'main_faq') return sendFacilitiesMenu(phone, booking);
  if (id === 'main_stay') return sendStayInfo(phone, booking);
  if (id === 'main_menu') return sendMainMenu(phone, booking);

  // Food
  if (id.startsWith('meal_')) return showCategories(phone, booking, id.replace('meal_', ''), sessionData);
  if (id.startsWith('cat_')) return showItems(phone, booking, parseInt(id.replace('cat_', ''), 10), sessionData);
  if (id.startsWith('item_')) return askQuantity(phone, booking, parseInt(id.replace('item_', ''), 10), sessionData);
  if (id.startsWith('qty_')) return addToCart(phone, booking, id.replace('qty_', ''), sessionData);
  if (id === 'cart_add_more') return showMealTypes(phone, booking, sessionData);
  if (id === 'cart_view') return showCart(phone, booking, sessionData);
  if (id === 'cart_confirm' || id === 'cart_place') return confirmOrder(phone, booking, sessionData);
  if (id === 'cart_cancel') return cancelCart(phone, booking);

  // Laundry
  if (id === 'laundry_combo_shirt_pant') {
    return addLaundryCombo(phone, booking, [
      { key: 'shirt', quantity: 1 },
      { key: 'pant', quantity: 1 },
    ], sessionData);
  }
  if (id === 'laundry_combo_full') {
    return addLaundryCombo(phone, booking, [
      { key: 'shirt', quantity: 1 },
      { key: 'pant', quantity: 1 },
      { key: 'suit', quantity: 1 },
    ], sessionData);
  }
  if (id === 'laundry_place') return placeLaundryOrder(phone, booking, sessionData);
  if (id === 'laundry_view') return showLaundryCart(phone, booking, sessionData);
  if (id === 'laundry_add_more') return showLaundryItemList(phone, booking, sessionData);
  if (id === 'laundry_cancel') return cancelLaundry(phone, booking);
  if (id === 'laundry_no') return whatsapp.sendText(phone, 'No problem! How else can I help you?', booking.id).then(() => sendMainMenu(phone, booking));
  if (id.startsWith('lq_')) {
    const [key, qty] = id.replace('lq_', '').split('_');
    return addLaundryToCart(phone, booking, key, parseInt(qty, 10), sessionData);
  }
  if (id.startsWith('laundry_')) return askLaundryQty(phone, booking, id.replace('laundry_', ''), sessionData);

  // Transport
  if (id.startsWith('cab_')) return createTransportRequest(phone, booking, id.replace('cab_', '').replace(/_/g, ' '));

  // Facilities / FAQ pick
  if (id.startsWith('faq_')) return answerFaqById(phone, booking, parseInt(id.replace('faq_', ''), 10));

  // Legacy services
  if (id === 'valet_luggage') return createValetRequest(phone, booking, 'Luggage Down');
  if (id === 'valet_car') return createValetRequest(phone, booking, 'Car Retrieve');
  if (id.startsWith('hk_')) return createHousekeepingRequest(phone, booking, id.replace('hk_', '').replace(/_/g, ' '));
  if (id === 'svc_valet') return sendValetMenu(phone, booking);
  if (id === 'svc_housekeeping') return sendHousekeepingMenu(phone, booking);
  if (id === 'svc_maintenance') return promptMaintenance(phone, booking);
  if (id === 'svc_checkout') return sendCheckoutMenu(phone, booking);
  if (id === 'svc_laundry') return sendLaundryMenu(phone, booking);
  if (id === 'svc_transport') return sendTransportMenu(phone, booking);

  return sendMainMenu(phone, booking);
}

async function handleFreeText(phone, text, booking) {
  if (!booking) return blockNonGuest(phone);

  const intent = await openai.detectIntent(text);
  const lang = intent.language || 'mixed';

  switch (intent.intent) {
    case 'greeting':
      return sendWelcome(phone, booking);
    case 'food':
      return handleFoodFreeText(phone, booking, text);
    case 'laundry':
      return sendLaundryMenu(phone, booking);
    case 'transport':
      return sendTransportMenu(phone, booking);
    case 'order_status':
      return replyOrderStatus(phone, booking, text, lang);
    case 'request_status':
      return replyRequestStatus(phone, booking, text, lang);
    case 'facilities':
    case 'faq':
      return replyHotelQuestion(phone, booking, text, lang, intent.faq_keyword);
    case 'off_topic':
      return whatsapp.sendText(phone, openai.OFF_TOPIC_REPLY, booking.id);
    case 'reception':
      return createReceptionRequest(phone, booking);
    case 'valet':
      return sendValetMenu(phone, booking);
    case 'housekeeping':
      if (intent.issue || /bhej|chahiye|do |please|request/i.test(text)) {
        return createHousekeepingRequest(phone, booking, intent.issue || text);
      }
      return sendHousekeepingMenu(phone, booking);
    case 'maintenance':
      return createMaintenanceRequest(phone, booking, intent.issue || text, intent.priority);
    case 'checkout':
      return sendCheckoutMenu(phone, booking);
    case 'late_checkout':
      return createLateCheckoutRequest(phone, booking, text);
    default: {
      // Try hotel Q&A before dumping main menu
      const answered = await replyHotelQuestion(phone, booking, text, lang, text, true);
      if (answered) return answered;
      return sendWelcome(phone, booking);
    }
  }
}

async function replyOrderStatus(phone, booking, text, language) {
  const orders = await orderRepo.findAll({ booking_id: booking.id });
  const result = await openai.phraseStatusUpdate(text, {
    orders,
    requests: [],
    language,
    kind: 'order',
  });
  return whatsapp.sendText(phone, result.answer, booking.id);
}

/** Free-text food: match menu items; clearly say when something is not on the menu. */
async function handleFoodFreeText(phone, booking, text) {
  const menuItems = await menuRepo.findAllItems(HOTEL_ID);
  const parsed = await openai.parseFoodOrder(text, menuItems);
  const unmatched = (parsed.unmatched || []).filter(Boolean);

  // Place whatever matched; also tell guest about missing items
  if (parsed.ok && parsed.items.length) {
    await placeDirectOrder(phone, booking, parsed.items);
    if (unmatched.length) {
      return whatsapp.sendText(
        phone,
        notOnMenuMessage(unmatched),
        booking.id
      );
    }
    return;
  }

  if (unmatched.length && !parsed.browse_menu) {
    return whatsapp.sendButtons(
      phone,
      notOnMenuMessage(unmatched),
      [
        { id: 'main_food', title: 'View Menu' },
        { id: 'main_menu', title: 'Main Menu' },
      ],
      booking.id
    );
  }

  return startFoodFlow(phone, booking);
}

function notOnMenuMessage(unmatched) {
  const list = unmatched.map((u) => `• ${u}`).join('\n');
  return (
    `❌ Sorry, ye menu mein available nahi hai:\n${list}\n\n` +
    `Kripya menu se koi available item order karein (e.g. Masala Chai, Sandwich, Chicken Biryani).`
  );
}

async function placeDirectOrder(phone, booking, items) {
  const cart = items.map((i) => ({
    menu_item_id: i.menu_item_id,
    quantity: i.quantity,
  }));

  const order = await orderService.createOrder(booking.id, cart);
  await guestService.updateSession(phone, 'idle', { cart: [] }, booking.id);

  const itemLines = (order.items || [])
    .map((i) => `• ${i.item_name} × ${i.quantity} — ₹${parseFloat(i.subtotal).toFixed(0)}`)
    .join('\n');

  return whatsapp.sendText(
    phone,
    `✅ Order Confirmed!\n\n` +
      `Order ID: #${order.order_ref}\n` +
      `Room: ${booking.room_number}\n` +
      `Items:\n${itemLines}\n` +
      `Total: ₹${parseFloat(order.total_amount).toFixed(0)}\n` +
      `Estimated Delivery: ~30 min\n\n` +
      `Kitchen ko bhej diya hai. Update milega jab status change hoga. 🍽️`,
    booking.id
  );
}

async function replyRequestStatus(phone, booking, text, language) {
  const requests = await requestRepo.findAll({ booking_id: booking.id });
  const result = await openai.phraseStatusUpdate(text, {
    orders: [],
    requests,
    language,
    kind: 'request',
  });
  return whatsapp.sendText(phone, result.answer, booking.id);
}

/**
 * Answer hotel FAQ / facility questions with AI grounded on DB FAQ + hotel row.
 * If soft=true, return null when unanswered (so caller can fall back to menu).
 */
async function replyHotelQuestion(phone, booking, text, language, faqKeyword, soft = false) {
  const [hotel, faqs] = await Promise.all([
    hotelRepo.findById(HOTEL_ID),
    faqRepo.findActive(HOTEL_ID),
  ]);

  // Fast path: keyword FAQ match
  const keyword = faqKeyword || text;
  const matched = await openai.matchFaq(HOTEL_ID, keyword);
  if (matched) {
    return whatsapp.sendText(phone, `✅ ${matched.answer}`, booking.id);
  }

  const result = await openai.answerHotelQuestion(text, { hotel, faqs, language });
  if (result.ok && result.answer) {
    return whatsapp.sendText(phone, `✅ ${result.answer}`, booking.id);
  }

  if (result.reason === 'off_topic') {
    return whatsapp.sendText(phone, openai.OFF_TOPIC_REPLY, booking.id);
  }

  if (soft) return null;
  return sendFacilitiesMenu(phone, booking);
}

async function handleStateInput(phone, text, booking, session) {
  if (!booking) {
    await guestService.resetSession(phone);
    return blockNonGuest(phone);
  }

  if (session.current_state === 'awaiting_maintenance') {
    await guestService.resetSession(phone);
    return createMaintenanceRequest(phone, booking, text, 'medium');
  }

  // Manual menus + free text both work — typing never blocked by list/button state
  return handleFreeText(phone, text, booking);
}

async function blockNonGuest(phone) {
  return whatsapp.sendText(
    phone,
    'Is WhatsApp number par koi active stay nahi mili.\nCheck-in ke baad hotel services available hongi. 🙂',
    null
  );
}

// ─── Welcome / Main Menu ─────────────────────────────────────────────────────

async function sendWelcome(phone, booking) {
  if (!booking) return blockNonGuest(phone);

  const hotel = await hotelRepo.findById(HOTEL_ID);
  await guestService.updateSession(phone, 'idle', {}, booking.id);

  const name = hotel?.name || 'our hotel';
  return whatsapp.sendList(
    phone,
    `Welcome to ${name} 👋\n\nHello ${booking.guest_name}!\nRoom: ${booking.room_number} | Booking: ${booking.booking_ref}\nCheck-in: ${formatDate(booking.check_in_date)} → Check-out: ${formatDate(booking.check_out_date)}\n\nHow can I help you today?`,
    'Select Service',
    [{
      title: 'Services',
      rows: [
        { id: 'main_food', title: 'Food / Dining', description: 'Menu tap ya type karke order' },
        { id: 'main_laundry', title: 'Laundry / Press', description: 'Clothes press & laundry' },
        { id: 'main_transport', title: 'Transport / Cab', description: 'Airport & local cab' },
        { id: 'main_facilities', title: 'Hotel Facilities', description: 'WiFi, pool, spa, timings' },
        { id: 'main_reception', title: 'Reception', description: 'Talk to front desk' },
        { id: 'main_services', title: 'More Services', description: 'Valet, cleaning, checkout' },
        { id: 'main_stay', title: 'My Stay', description: 'Your room & booking info' },
      ],
    }],
    booking.id
  );
}

async function sendMainMenu(phone, booking) {
  if (!booking) return blockNonGuest(phone);
  await guestService.updateSession(phone, 'idle', {}, booking.id);
  return whatsapp.sendList(
    phone,
    'How can I help you?',
    'Select Service',
    [{
      title: 'Services',
      rows: [
        { id: 'main_food', title: 'Food / Dining', description: 'Menu tap ya type karke order' },
        { id: 'main_laundry', title: 'Laundry / Press', description: 'Clothes press & laundry' },
        { id: 'main_transport', title: 'Transport / Cab', description: 'Airport & local cab' },
        { id: 'main_facilities', title: 'Hotel Facilities', description: 'WiFi, pool, spa, timings' },
        { id: 'main_reception', title: 'Reception', description: 'Talk to front desk' },
        { id: 'main_services', title: 'More Services', description: 'Valet, cleaning, checkout' },
      ],
    }],
    booking.id
  );
}

async function sendStayInfo(phone, booking) {
  return whatsapp.sendButtons(
    phone,
    `🏨 My Stay\n\nGuest: ${booking.guest_name}\nRoom: ${booking.room_number}\nBooking: ${booking.booking_ref}\nCheck-in: ${formatDate(booking.check_in_date)}\nCheck-out: ${formatDate(booking.check_out_date)}\nStatus: ${booking.status.replace('_', ' ')}`,
    [{ id: 'main_menu', title: 'Main Menu' }],
    booking.id
  );
}

// ─── Food Ordering ───────────────────────────────────────────────────────────

async function startFoodFlow(phone, booking) {
  if (!booking) return whatsapp.sendText(phone, 'Food ordering requires an active stay.', null);

  if (flowService.isFlowConfigured('food')) {
    const ok = await openHotelFlow(
      phone,
      booking,
      'food',
      'Popular items checkboxes se select karein.\nFull category menu bhi chat se available hai.'
    );
    if (ok) return;
  }

  const session = await guestService.getOrCreateSession(phone);
  const existing = guestService.parseSessionData(session);
  const cart = existing.cart || [];
  await guestService.updateSession(phone, 'food_meal', { cart }, booking.id);
  return showMealTypes(phone, booking, { cart });
}

async function showMealTypes(phone, booking, sessionData = {}) {
  return whatsapp.sendList(
    phone,
    '🍽️ Food / Dining\n\nMenu se select karein, ya seedha type karein\n(e.g. "2 cup chai aur 1 water bottle").',
    'View Menu',
    [{
      title: 'Menu',
      rows: [
        { id: 'meal_dinner', title: 'Dinner Menu', description: 'Starters, mains, drinks, desserts' },
        { id: 'meal_breakfast', title: 'Breakfast', description: 'Morning favourites' },
        { id: 'meal_snacks', title: 'Snacks', description: 'Quick bites anytime' },
      ],
    }],
    booking.id
  );
}

async function showCategories(phone, booking, mealType, sessionData = {}) {
  const categories = await menuRepo.getCategoriesByMealType(HOTEL_ID, mealType);
  if (!categories.length) {
    return whatsapp.sendText(phone, 'Is meal type ke liye menu available nahi hai.', booking.id);
  }

  await guestService.updateSession(phone, 'food_category', {
    cart: sessionData.cart || [],
    mealType,
  }, booking.id);

  const label = mealType.charAt(0).toUpperCase() + mealType.slice(1);
  return whatsapp.sendList(
    phone,
    `${label} Menu 🍴\n\nSelect a category:`,
    'Categories',
    [{
      title: 'Categories',
      rows: categories.map((c) => ({
        id: `cat_${c.id}`,
        title: c.name.slice(0, 24),
        description: 'Tap to view items',
      })),
    }],
    booking.id
  );
}

async function showItems(phone, booking, categoryId, sessionData = {}) {
  const items = await menuRepo.getItemsByCategory(categoryId);
  if (!items.length) {
    return whatsapp.sendText(phone, 'Is category mein items available nahi hain.', booking.id);
  }

  await guestService.updateSession(phone, 'food_item', {
    ...sessionData,
    cart: sessionData.cart || [],
    categoryId,
  }, booking.id);

  let text = '📋 Menu Items\n\n';
  text += items.map((i) => `• ${i.name} — ₹${parseFloat(i.price).toFixed(0)}`).join('\n');
  text += '\n\nList se choose karein, ya naam type karein (e.g. "2 Masala Chai").';

  return whatsapp.sendList(
    phone,
    text.slice(0, 1024),
    'Add Item',
    [{
      title: 'Items',
      rows: items.slice(0, 10).map((i) => ({
        id: `item_${i.id}`,
        title: i.name.slice(0, 24),
        description: `₹${parseFloat(i.price).toFixed(0)} — tap to add`,
      })),
    }],
    booking.id
  );
}

async function askQuantity(phone, booking, itemId, sessionData = {}) {
  const item = await menuRepo.getItemById(itemId);
  if (!item) return whatsapp.sendText(phone, 'Item not found.', booking.id);

  await guestService.updateSession(phone, 'food_qty', {
    ...sessionData,
    cart: sessionData.cart || [],
    pendingItemId: itemId,
  }, booking.id);

  return whatsapp.sendButtons(
    phone,
    `🛒 ${item.name}\nPrice: ₹${parseFloat(item.price).toFixed(0)}\n\nSelect quantity:`,
    [
      { id: 'qty_1', title: 'Add × 1' },
      { id: 'qty_2', title: 'Add × 2' },
      { id: 'qty_3', title: 'Add × 3' },
    ],
    booking.id,
    {
      imageUrl: item.image_url || undefined,
      footer: 'In-room dining',
    }
  );
}

async function addToCart(phone, booking, qtyStr, sessionData = {}) {
  const quantity = parseInt(qtyStr, 10);
  const itemId = sessionData.pendingItemId;
  const item = await menuRepo.getItemById(itemId);
  if (!item) return whatsapp.sendText(phone, 'Item not found.', booking.id);

  const cart = [...(sessionData.cart || [])];
  const existing = cart.find((c) => c.menu_item_id === itemId);
  if (existing) existing.quantity += quantity;
  else cart.push({ menu_item_id: itemId, name: item.name, quantity, price: parseFloat(item.price) });

  await guestService.updateSession(phone, 'food_cart', { cart }, booking.id);

  return whatsapp.sendButtons(
    phone,
    `✅ Added to cart\n${item.name} × ${quantity} — ₹${(parseFloat(item.price) * quantity).toFixed(0)}`,
    [
      { id: 'cart_add_more', title: 'Add More Items' },
      { id: 'cart_view', title: 'View Cart' },
      { id: 'cart_place', title: 'Place Order' },
    ],
    booking.id
  );
}

async function showCart(phone, booking, sessionData = {}) {
  const cart = sessionData.cart || [];
  if (!cart.length) {
    return whatsapp.sendText(phone, 'Your cart is empty. Food order shuru karein?', booking.id)
      .then(() => startFoodFlow(phone, booking));
  }

  let total = 0;
  const lines = cart.map((c) => {
    const sub = c.price * c.quantity;
    total += sub;
    return `• ${c.name} × ${c.quantity} — ₹${sub.toFixed(0)}`;
  });

  return whatsapp.sendButtons(
    phone,
    `🛒 Your Cart\n\n${lines.join('\n')}\n\n────────────\nTotal: ₹${total.toFixed(0)}`,
    [
      { id: 'cart_add_more', title: 'Add More Items' },
      { id: 'cart_place', title: 'Place Order' },
      { id: 'cart_cancel', title: 'Cancel' },
    ],
    booking.id
  );
}

async function confirmOrder(phone, booking, sessionData = {}) {
  const cart = sessionData.cart || [];
  if (!cart.length) return whatsapp.sendText(phone, 'Cart is empty.', booking.id);

  const order = await orderService.createOrder(
    booking.id,
    cart.map((c) => ({ menu_item_id: c.menu_item_id, quantity: c.quantity }))
  );

  await guestService.updateSession(phone, 'idle', { cart: [] }, booking.id);

  const itemLines = (order.items || []).map((i) => `• ${i.item_name} × ${i.quantity}`).join('\n');

  return whatsapp.sendText(
    phone,
    `✅ Order Confirmed!\n\n` +
    `Order ID: #${order.order_ref}\n` +
    `Room: ${booking.room_number}\n` +
    `Items:\n${itemLines}\n` +
    `Total Amount: ₹${parseFloat(order.total_amount).toFixed(0)}\n` +
    `Estimated Delivery: 30 Minutes\n\n` +
    `You will receive an update shortly. 🍽️`,
    booking.id
  );
}

async function cancelCart(phone, booking) {
  await guestService.updateSession(phone, 'idle', { cart: [] }, booking.id);
  return whatsapp.sendText(phone, 'Order cancelled. ✅', booking.id)
    .then(() => sendMainMenu(phone, booking));
}

// ─── Laundry / Press ─────────────────────────────────────────────────────────

async function sendLaundryMenu(phone, booking, sessionData = {}) {
  if (!booking) return blockNonGuest(phone);

  if (flowService.isFlowConfigured('laundry')) {
    const ok = await openHotelFlow(
      phone,
      booking,
      'laundry',
      'Shirt ₹50 · Pant ₹70 · Suit ₹150\nCheckboxes se items select karein.'
    );
    if (ok) return;
  }

  const laundryCart = sessionData.laundryCart || [];
  await guestService.updateSession(phone, 'laundry', { laundryCart }, booking.id);

  if (!laundryCart.length) {
    return whatsapp.sendButtons(
      phone,
      '👔 Laundry / Press\n\n• Shirt — ₹50\n• Pant — ₹70\n• Suit — ₹150\n\nShirt + Pant = ₹120',
      [
        { id: 'laundry_combo_shirt_pant', title: 'Shirt + Pant' },
        { id: 'laundry_shirt', title: 'Only Shirt' },
        { id: 'laundry_add_more', title: 'More Options' },
      ],
      booking.id
    );
  }

  return showLaundryItemList(phone, booking, { laundryCart });
}

async function showLaundryItemList(phone, booking, sessionData = {}) {
  const laundryCart = sessionData.laundryCart || [];
  await guestService.updateSession(phone, 'laundry', { laundryCart }, booking.id);

  const cartHint = laundryCart.length
    ? `\n\n🧺 Cart: ${laundryCart.map((c) => `${c.name} ×${c.quantity}`).join(', ')}`
    : '';

  return whatsapp.sendList(
    phone,
    `👔 Select items (ek-ek karke add kar sakte ho):${cartHint}\n\nShirt ₹50 | Pant ₹70 | Suit ₹150`,
    'Select Item',
    [{
      title: 'Press Items',
      rows: [
        { id: 'laundry_combo_shirt_pant', title: 'Shirt + Pant', description: '₹120 — both together' },
        { id: 'laundry_shirt', title: 'Shirt Press', description: '₹50 per piece' },
        { id: 'laundry_pant', title: 'Pant Press', description: '₹70 per piece' },
        { id: 'laundry_suit', title: 'Suit Press', description: '₹150 per piece' },
        ...(laundryCart.length
          ? [{ id: 'laundry_view', title: 'View / Place Order', description: 'Open cart' }]
          : []),
      ],
    }],
    booking.id
  );
}

async function addLaundryCombo(phone, booking, items, sessionData = {}) {
  const laundryCart = [...(sessionData.laundryCart || [])];

  for (const { key, quantity } of items) {
    const item = LAUNDRY_ITEMS[key];
    if (!item) continue;
    const existing = laundryCart.find((c) => c.key === key);
    if (existing) existing.quantity += quantity;
    else laundryCart.push({ key, name: item.name, quantity, price: item.price });
  }

  await guestService.updateSession(phone, 'laundry', { laundryCart }, booking.id);
  return showLaundryCart(phone, booking, { laundryCart });
}

async function askLaundryQty(phone, booking, key, sessionData = {}) {
  const item = LAUNDRY_ITEMS[key];
  if (!item) return sendLaundryMenu(phone, booking, sessionData);

  await guestService.updateSession(phone, 'laundry_qty', {
    laundryCart: sessionData.laundryCart || [],
    pendingLaundry: key,
  }, booking.id);

  return whatsapp.sendButtons(
    phone,
    `👔 ${item.name} — ₹${item.price} each\n\nKitne pieces?`,
    [
      { id: `lq_${key}_1`, title: '× 1' },
      { id: `lq_${key}_2`, title: '× 2' },
      { id: `lq_${key}_3`, title: '× 3' },
    ],
    booking.id
  );
}

async function addLaundryToCart(phone, booking, key, quantity, sessionData = {}) {
  const item = LAUNDRY_ITEMS[key];
  if (!item || !quantity) return sendLaundryMenu(phone, booking, sessionData);

  const laundryCart = [...(sessionData.laundryCart || [])];
  const existing = laundryCart.find((c) => c.key === key);
  if (existing) existing.quantity += quantity;
  else laundryCart.push({ key, name: item.name, quantity, price: item.price });

  await guestService.updateSession(phone, 'laundry', { laundryCart }, booking.id);

  const line = `${item.name} × ${quantity} — ₹${item.price * quantity}`;
  return whatsapp.sendButtons(
    phone,
    `✅ Added\n${line}`,
    [
      { id: 'laundry_add_more', title: 'Add More' },
      { id: 'laundry_view', title: 'View Cart' },
      { id: 'laundry_place', title: 'Place Order' },
    ],
    booking.id
  );
}

async function showLaundryCart(phone, booking, sessionData = {}) {
  const laundryCart = sessionData.laundryCart || [];
  if (!laundryCart.length) {
    return whatsapp.sendText(phone, 'Laundry cart empty hai.', booking.id)
      .then(() => sendLaundryMenu(phone, booking));
  }

  let total = 0;
  const lines = laundryCart.map((c) => {
    const sub = c.price * c.quantity;
    total += sub;
    return `• ${c.name} × ${c.quantity} — ₹${sub}`;
  });

  return whatsapp.sendButtons(
    phone,
    `🧺 Laundry Cart\n\n${lines.join('\n')}\n\n────────────\nTotal: ₹${total}`,
    [
      { id: 'laundry_add_more', title: 'Add More' },
      { id: 'laundry_place', title: 'Place Order' },
      { id: 'laundry_cancel', title: 'Cancel' },
    ],
    booking.id
  );
}

async function placeLaundryOrder(phone, booking, sessionData = {}) {
  const laundryCart = sessionData.laundryCart || [];
  if (!laundryCart.length) {
    return whatsapp.sendText(phone, 'Pehle items add karein.', booking.id)
      .then(() => sendLaundryMenu(phone, booking));
  }

  let total = 0;
  const lines = laundryCart.map((c) => {
    const sub = c.price * c.quantity;
    total += sub;
    return `• ${c.name} × ${c.quantity} — ₹${sub}`;
  });

  const req = await requestService.createRequest(booking.id, 'housekeeping', {
    sub_type: 'Laundry / Press',
    description: `${lines.join(' | ')} | Total ₹${total} | Room ${booking.room_number}`,
  });

  await guestService.updateSession(phone, 'idle', { laundryCart: [] }, booking.id);

  return whatsapp.sendText(
    phone,
    `✅ Laundry Request Created\n\n` +
    `Request ID: #${req.request_ref}\n` +
    `Room: ${booking.room_number}\n\n` +
    `${lines.join('\n')}\n\n` +
    `Total: ₹${total}\n` +
    `Pickup Time: ~10 mins\n\n` +
    `Staff jaldi aapke room pe aayega.`,
    booking.id
  );
}

async function cancelLaundry(phone, booking) {
  await guestService.updateSession(phone, 'idle', { laundryCart: [] }, booking.id);
  return whatsapp.sendText(phone, 'Laundry order cancelled. ✅', booking.id)
    .then(() => sendMainMenu(phone, booking));
}

// ─── Transport / Cab ─────────────────────────────────────────────────────────

async function sendTransportMenu(phone, booking) {
  if (!booking) return blockNonGuest(phone);

  if (flowService.isFlowConfigured('transport')) {
    const ok = await openHotelFlow(phone, booking, 'transport', 'Destination select karke cab request bhejein.');
    if (ok) return;
  }

  return whatsapp.sendList(
    phone,
    '🚕 Transport / Cab\n\nKahan jaana hai?',
    'Select Cab',
    [{
      title: 'Options',
      rows: [
        { id: 'cab_airport', title: 'Airport Transfer', description: 'Pickup / drop' },
        { id: 'cab_local', title: 'Local Cab', description: 'City travel' },
        { id: 'cab_station', title: 'Railway Station', description: 'Station transfer' },
        { id: 'cab_other', title: 'Other Location', description: 'Custom request' },
      ],
    }],
    booking.id
  );
}

async function createTransportRequest(phone, booking, destination) {
  const label = destination.charAt(0).toUpperCase() + destination.slice(1);
  const req = await requestService.createRequest(booking.id, 'other', {
    sub_type: 'Transport / Cab',
    description: `Cab request: ${label} | Room ${booking.room_number}`,
  });
  await guestService.resetSession(phone);
  return whatsapp.sendText(
    phone,
    `✅ Cab Request Created\n\nRequest ID: #${req.request_ref}\nType: ${label}\nRoom: ${booking.room_number}\n\nReception jald confirm karegi.`,
    booking.id
  );
}

// ─── Facilities / FAQ ────────────────────────────────────────────────────────

async function sendFacilitiesMenu(phone, booking) {
  if (!booking) return blockNonGuest(phone);
  const faqs = await faqRepo.findActive(HOTEL_ID);
  if (!faqs.length) {
    return whatsapp.sendText(phone, 'Facilities info abhi available nahi hai. Reception se contact karein.', booking.id);
  }

  return whatsapp.sendList(
    phone,
    '🏨 Hotel Facilities\n\nKya jaanna chahte ho?',
    'View Options',
    [{
      title: 'Facilities',
      rows: faqs.slice(0, 10).map((f) => ({
        id: `faq_${f.id}`,
        title: f.question.slice(0, 24),
        description: (f.keywords || '').slice(0, 72),
      })),
    }],
    booking.id
  );
}

async function answerFaqById(phone, booking, faqId) {
  const faqs = await faqRepo.findActive(HOTEL_ID);
  const faq = faqs.find((f) => f.id === faqId);
  if (!faq) {
    return whatsapp.sendText(phone, 'Sorry, ye info nahi mili. Reception se baat karein.', booking.id);
  }
  return whatsapp.sendButtons(
    phone,
    `✅ ${faq.answer}`,
    [{ id: 'main_menu', title: 'Main Menu' }, { id: 'main_facilities', title: 'More Info' }],
    booking.id
  );
}

// ─── Reception & other services ──────────────────────────────────────────────

async function createReceptionRequest(phone, booking) {
  if (!booking) return blockNonGuest(phone);
  const req = await requestService.createRequest(booking.id, 'other', {
    sub_type: 'Reception',
    description: `Guest requested reception callback | Room ${booking.room_number}`,
    priority: 'high',
  });
  return whatsapp.sendText(
    phone,
    `✅ Reception Request\n\nRequest ID: #${req.request_ref}\nRoom: ${booking.room_number}\n\nFront desk jald aapse contact karega.`,
    booking.id
  );
}

async function sendServicesMenu(phone, booking) {
  if (!booking) return blockNonGuest(phone);
  return whatsapp.sendList(
    phone,
    '🛎 More Hotel Services',
    'Services',
    [{
      title: 'Services',
      rows: [
        { id: 'svc_valet', title: 'Valet', description: 'Luggage or car retrieve' },
        { id: 'svc_housekeeping', title: 'Housekeeping', description: 'Cleaning, towels, water' },
        { id: 'svc_laundry', title: 'Laundry / Press', description: 'Clothes press' },
        { id: 'svc_transport', title: 'Transport / Cab', description: 'Airport & local' },
        { id: 'svc_maintenance', title: 'Maintenance', description: 'AC, TV, repairs' },
        { id: 'svc_checkout', title: 'Checkout', description: 'Request checkout' },
      ],
    }],
    booking.id
  );
}

async function sendValetMenu(phone, booking) {
  if (!booking) return blockNonGuest(phone);

  if (flowService.isFlowConfigured('valet')) {
    const ok = await openHotelFlow(phone, booking, 'valet', 'Luggage ya car retrieve choose karein.');
    if (ok) return;
  }

  return whatsapp.sendButtons(
    phone,
    '🚗 Valet Service\n\nLuggage down karwana hai ya car retrieve?',
    [
      { id: 'valet_luggage', title: 'Luggage Down' },
      { id: 'valet_car', title: 'Car Retrieve' },
    ],
    booking.id
  );
}

async function createValetRequest(phone, booking, subType) {
  const req = await requestService.createRequest(booking.id, 'valet', { sub_type: subType });
  await guestService.resetSession(phone);
  return whatsapp.sendText(
    phone,
    `✅ Valet Request Created\n\nRequest ID: #${req.request_ref}\nType: ${subType}\nRoom: ${booking.room_number}`,
    booking.id
  );
}

async function sendHousekeepingMenu(phone, booking) {
  if (!booking) return blockNonGuest(phone);

  if (flowService.isFlowConfigured('housekeeping')) {
    const ok = await openHotelFlow(phone, booking, 'housekeeping', 'Checkboxes se housekeeping items select karein.');
    if (ok) return;
  }

  return whatsapp.sendList(
    phone,
    '🧹 Housekeeping\n\nSelect a request:',
    'Housekeeping',
    [{
      title: 'Options',
      rows: [
        { id: 'hk_room_cleaning', title: 'Room Cleaning' },
        { id: 'hk_extra_towel', title: 'Extra Towel' },
        { id: 'hk_toiletries', title: 'Toiletries' },
        { id: 'hk_water', title: 'Drinking Water' },
        { id: 'hk_other', title: 'Other Request' },
      ],
    }],
    booking.id
  );
}

async function createHousekeepingRequest(phone, booking, subType) {
  const req = await requestService.createRequest(booking.id, 'housekeeping', {
    sub_type: subType,
    description: `Housekeeping: ${subType} | Room ${booking.room_number}`,
  });
  await guestService.resetSession(phone);
  return whatsapp.sendText(
    phone,
    `✅ Housekeeping Request\n\nRequest ID: #${req.request_ref}\nType: ${subType}\nRoom: ${booking.room_number}\n\nStaff jaldi aayega.`,
    booking.id
  );
}

async function promptMaintenance(phone, booking) {
  if (!booking) return blockNonGuest(phone);

  if (flowService.isFlowConfigured('maintenance')) {
    const ok = await openHotelFlow(phone, booking, 'maintenance', 'Issue type + details form mein bhariye.');
    if (ok) return;
  }

  await guestService.updateSession(phone, 'awaiting_maintenance', {}, booking.id);
  return whatsapp.sendText(phone, '🔧 Issue describe karein (e.g. AC nahi chal raha, TV problem):', booking.id);
}

async function createMaintenanceRequest(phone, booking, issue, priority) {
  const req = await requestService.createRequest(booking.id, 'maintenance', {
    description: issue,
    priority: priority || 'medium',
  });
  await guestService.resetSession(phone);
  return whatsapp.sendText(
    phone,
    `✅ Shikayat darj ho gayi\n\n` +
      `Request ID: #${req.request_ref}\n` +
      `Room: ${booking.room_number}\n` +
      `Issue: ${issue}\n` +
      `Priority: ${(priority || 'medium').toUpperCase()}\n\n` +
      `Admin / maintenance team ko bhej diya hai. Jaldi action hoga.`,
    booking.id
  );
}

async function createCheckoutRequest(phone, booking) {
  if (!booking) return blockNonGuest(phone);

  const req = await requestService.createRequest(booking.id, 'checkout', {
    description: `Checkout request | Room ${booking.room_number}`,
  });
  await guestService.resetSession(phone);
  return whatsapp.sendText(
    phone,
    `✅ Checkout Request\n\nRequest ID: #${req.request_ref}\nRoom: ${booking.room_number}\n\nFront desk process karega.`,
    booking.id
  );
}

async function sendCheckoutMenu(phone, booking) {
  if (!booking) return blockNonGuest(phone);
  if (flowService.isFlowConfigured('checkout')) {
    const ok = await openHotelFlow(phone, booking, 'checkout', 'Standard ya late checkout choose karein.');
    if (ok) return;
  }
  return createCheckoutRequest(phone, booking);
}

async function createLateCheckoutRequest(phone, booking, description) {
  const req = await requestService.createRequest(booking.id, 'late_checkout', {
    description,
    sub_type: 'Late Checkout',
  });
  await guestService.resetSession(phone);
  return whatsapp.sendText(
    phone,
    `✅ Late Checkout Request\n\nRequest ID: #${req.request_ref}\nRoom: ${booking.room_number}\nDetails: ${description}\nStatus: Pending approval`,
    booking.id
  );
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

module.exports = { handleIncoming };
