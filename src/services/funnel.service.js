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
const { imageUrlToFlowListBase64 } = require('../utils/flowImage');

const HOTEL_ID = parseInt(process.env.DEFAULT_HOTEL_ID || '1', 10);

// WhatsApp Flows OFF for demo until Meta Business is verified/approved.
// Set USE_WHATSAPP_FLOWS=true in .env after Flow IDs are published.
const USE_WHATSAPP_FLOWS = process.env.USE_WHATSAPP_FLOWS === 'true';

const LAUNDRY_ITEMS = flowService.LAUNDRY_CATALOG;

// Static staff names for guest-facing order messages (demo)
const STAFF = {
  chef: process.env.HOTEL_CHEF_NAME || 'Chef Ramesh',
  waiter: process.env.HOTEL_WAITER_NAME || 'Amit',
};

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

  // TODO(later): re-enable free-text NLP (type "2 chai", FAQ, intent routing)
  // return handleFreeText(phone, text, booking, session, sessionData);
  return sendWelcome(phone, booking);
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
      // New qty dropdowns: qty_shirt / qty_pant / qty_suit
      let laundryCart = flowService.buildLaundryCartFromQtyPayload(raw);
      // Legacy checkbox Flow payload
      if (!laundryCart.length && flowResponse.items?.length) {
        laundryCart = flowService.buildLaundryCartFromFlowItems(flowResponse.items);
      }
      if (!laundryCart.length) {
        return whatsapp.sendText(phone, 'No laundry items selected.', booking.id)
          .then(() => sendLaundryMenu(phone, booking));
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

    case 'food':
    case 'food_edit': {
      return placeFoodOrderFromFlow(phone, booking, raw);
    }

    case 'facilities': {
      const faqId = parseInt(raw.faq_id, 10);
      if (!faqId) {
        return whatsapp.sendText(phone, 'Please select a topic.', booking.id)
          .then(() => sendFacilitiesMenu(phone, booking));
      }
      return answerFaqById(phone, booking, faqId);
    }

    default:
      console.warn('[Flow] Unknown flow_name:', name, raw);
      return whatsapp.sendText(phone, 'Request received. Front desk will follow up.', booking.id);
  }
}

async function openHotelFlow(phone, booking, flowKey, bodyExtra = '', screenData = null) {
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
        bodyText: `Room ${booking.room_number}\n\n${bodyExtra || 'Please fill the form and submit.'}`.slice(0, 1024),
        footerText: 'Hotel Services',
        screen: meta.screen,
        flowToken: `${flowKey}_${booking.id}_${String(phone).replace(/\D/g, '')}`.slice(0, 200),
        screenData,
      },
      booking.id
    );
    return true;
  } catch (err) {
    console.error(`[Flow] ${flowKey} send failed:`, err.message);
    return false;
  }
}

/** Page size for food CheckboxGroup + images (More items pagination). */
const FOOD_PAGE_SIZE = 10;

async function listFoodMenuItems(opts = {}) {
  const allItems = await menuRepo.findAllItems(HOTEL_ID);
  let available = allItems.filter(
    (item) => item.is_available === 1 || item.is_available === true
  );

  if (opts.categoryId) {
    const catId = parseInt(opts.categoryId, 10);
    available = available.filter((item) => Number(item.category_id) === catId);
  } else if (opts.mealType) {
    const meal = String(opts.mealType).toLowerCase();
    available = available.filter((item) => String(item.meal_type || '').toLowerCase() === meal);
  }
  return available;
}

/**
 * Build FOOD flow screen data: one page of products with images.
 * Returns { products, page, total, hasMore } — only `products` is sent to Meta.
 */
async function buildFoodFlowScreenData(orderItems = [], opts = {}) {
  const available = await listFoodMenuItems(opts);
  const page = Math.max(0, parseInt(opts.page, 10) || 0);

  // Prefer order-edit items on page 0 (front of list, unique)
  const ordered = [];
  const seen = new Set();
  if (page === 0) {
    for (const line of orderItems || []) {
      let item = null;
      if (line.menu_item_id != null) {
        item = available.find((row) => String(row.id) === String(line.menu_item_id));
      }
      if (!item && (line.item_name || line.name)) {
        const want = String(line.item_name || line.name).toLowerCase().trim();
        item = available.find((row) => String(row.name || '').toLowerCase() === want);
      }
      if (item && !seen.has(String(item.id))) {
        seen.add(String(item.id));
        ordered.push(item);
      }
    }
  }

  const rest = available.filter((item) => !seen.has(String(item.id)));
  // Images first within rest for nicer pages
  rest.sort((a, b) => {
    const ai = a.image_url ? 0 : 1;
    const bi = b.image_url ? 0 : 1;
    if (ai !== bi) return ai - bi;
    return 0;
  });
  const fullList = page === 0 ? [...ordered, ...rest] : available;

  const total = fullList.length;
  const startIdx = page * FOOD_PAGE_SIZE;
  const slice = fullList.slice(startIdx, startIdx + FOOD_PAGE_SIZE);
  const hasMore = startIdx + slice.length < total;

  // Smaller images when many products on one page (payload limit)
  const maxImageBytes = slice.length > 6 ? 45_000 : 80_000;

  const makeQtyOptions = (unitPrice) => {
    const price = Math.round(parseFloat(unitPrice) || 0);
    const options = [{ id: '0', title: '0 — skip' }];
    for (let q = 1; q <= 5; q += 1) {
      options.push({ id: String(q), title: `${q} · ₹${price * q}` });
    }
    return options;
  };

  const products = [];
  const data = {};

  for (let i = 0; i < FOOD_PAGE_SIZE; i += 1) {
    data[`has_${i}`] = false;
    data[`label_${i}`] = `Item ${i + 1}`;
    data[`key_${i}`] = '';
    data[`qty_options_${i}`] = makeQtyOptions(0);
    data[`init_qty_${i}`] = '1';
  }

  for (let i = 0; i < slice.length; i += 1) {
    const menuItem = slice[i];
    const id = String(menuItem.id);
    const price = Math.round(parseFloat(menuItem.price) || 0);
    const name = String(menuItem.name || 'Item');
    const entry = {
      id,
      title: `${name} · ₹${price}`.slice(0, 30),
      description: String(menuItem.category_name || 'Menu').slice(0, 30),
      'alt-text': name.slice(0, 100),
    };
    if (menuItem.image_url) {
      const raw = await imageUrlToFlowListBase64(menuItem.image_url, maxImageBytes);
      if (raw) entry.image = raw;
    }
    products.push(entry);
    data[`has_${i}`] = true;
    data[`key_${i}`] = id;
    data[`label_${i}`] = name.slice(0, 24);
    data[`qty_options_${i}`] = makeQtyOptions(price);
    data[`init_qty_${i}`] = '1';
  }

  if (!products.length) {
    products.push({
      id: '0',
      title: 'No items available',
      description: 'Ask staff',
      'alt-text': 'No items',
    });
    data.has_0 = true;
    data.key_0 = '0';
    data.label_0 = 'No items';
  }

  data.products = products;
  console.log('[Flow] Food page', page, 'products', products.length, '/', total, 'hasMore', hasMore);
  return { ...data, page, total, hasMore };
}

async function placeFoodOrderFromFlow(phone, booking, raw = {}) {
  const allItems = await menuRepo.findAllItems(HOTEL_ID);

  const resolveMenuItem = (key) => {
    if (key == null || key === '' || key === '0') return null;
    const byId = allItems.find((item) => String(item.id) === String(key));
    if (byId && (byId.is_available === 1 || byId.is_available === true)) return byId;
    const wantName = flowService.FOOD_FLOW_ITEMS[String(key)];
    if (!wantName) return null;
    return allItems.find(
      (item) => (item.is_available === 1 || item.is_available === true)
        && String(item.name || '').toLowerCase() === wantName.toLowerCase()
    ) || null;
  };

  let selected = raw.products || raw.selected_ids;
  if (typeof selected === 'string') {
    try {
      selected = JSON.parse(selected);
    } catch {
      selected = selected.includes(',') ? selected.split(',') : [selected];
    }
  }
  if (!Array.isArray(selected)) selected = [];
  const selectedSet = new Set(selected.map(String));

  const added = [];

  // Preferred: selected products + per-item qty from FOOD_QTY screen
  for (let i = 0; i < FOOD_PAGE_SIZE; i += 1) {
    const key = raw[`key_${i}`];
    if (!key || key === '0') continue;
    if (selectedSet.size && !selectedSet.has(String(key))) continue;
    const qty = Math.min(5, Math.max(0, parseInt(raw[`qty_${i}`], 10) || 0));
    if (qty < 1) continue;
    const menuItem = resolveMenuItem(key);
    if (!menuItem) continue;
    added.push({
      menu_item_id: menuItem.id,
      name: menuItem.name,
      quantity: qty,
      price: parseFloat(menuItem.price),
    });
  }

  // Fallback: selected only → qty 1 each (old single-screen flow)
  if (!added.length) {
    for (const productKey of selected) {
      const menuItem = resolveMenuItem(productKey);
      if (!menuItem) continue;
      added.push({
        menu_item_id: menuItem.id,
        name: menuItem.name,
        quantity: 1,
        price: parseFloat(menuItem.price),
      });
    }
  }

  if (!added.length && (raw.product_id || raw.product)) {
    const menuItem = resolveMenuItem(raw.product_id || raw.product);
    const qty = Math.min(10, Math.max(1, parseInt(raw.qty, 10) || 1));
    if (menuItem) {
      added.push({
        menu_item_id: menuItem.id,
        name: menuItem.name,
        quantity: qty,
        price: parseFloat(menuItem.price),
      });
    }
  }

  if (!added.length) {
    return whatsapp.sendText(
      phone,
      'No items selected. Please choose at least one product.',
      booking.id
    ).then(() => startFoodFlow(phone, booking));
  }

  const session = await guestService.getOrCreateSession(phone);
  const sessionData = guestService.parseSessionData(session);
  const cart = [...(sessionData.cart || [])];

  for (const line of added) {
    const existing = cart.find((c) => String(c.menu_item_id) === String(line.menu_item_id));
    if (existing) existing.quantity += line.quantity;
    else cart.push({ ...line });
  }

  const foodPage = Math.max(0, parseInt(sessionData.foodPage, 10) || 0);
  const foodHasMore = Boolean(sessionData.foodHasMore);
  const mealType = sessionData.mealType || null;
  const categoryId = sessionData.categoryId || null;

  await guestService.updateSession(phone, 'food_cart', {
    cart,
    foodPage,
    foodHasMore,
    mealType,
    categoryId,
  }, booking.id);

  const names = added.map((a) => a.name).join(', ');

  if (foodHasMore) {
    return whatsapp.sendButtons(
      phone,
      `Added to cart: ${names}\n\nCart: ${cart.length} item(s).\nMore products available on the next page.`,
      [
        { id: 'food_more_items', title: 'More Items' },
        { id: 'food_review_order', title: 'Review Order' },
        { id: 'cart_cancel', title: 'Cancel' },
      ],
      booking.id
    );
  }

  return askOrderConfirm(phone, booking, cart);
}

async function openFoodMoreItems(phone, booking, sessionData = {}) {
  const nextPage = Math.max(0, parseInt(sessionData.foodPage, 10) || 0) + 1;
  const ok = await openFoodMenuFlow(
    phone,
    booking,
    {
      page: nextPage,
      mealType: sessionData.mealType,
      categoryId: sessionData.categoryId,
      orderItems: sessionData.cart || [],
    },
    `More items — page ${nextPage + 1}. Select products with images.`
  );
  if (ok) return;
  return askOrderConfirm(phone, booking, sessionData.cart || []);
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
  if (id === 'food_quick' || id === 'food_full_menu') return startFoodFlow(phone, booking);
  if (id.startsWith('meal_')) return showCategories(phone, booking, id.replace('meal_', ''), sessionData);
  if (id.startsWith('cat_')) return showItems(phone, booking, parseInt(id.replace('cat_', ''), 10), sessionData);
  if (id.startsWith('item_')) return askQuantity(phone, booking, parseInt(id.replace('item_', ''), 10), sessionData);
  if (id.startsWith('qty_')) return addToCart(phone, booking, id.replace('qty_', ''), sessionData);
  if (id === 'cart_add_more') return showMealTypes(phone, booking, sessionData);
  if (id === 'food_more_items') return openFoodMoreItems(phone, booking, sessionData);
  if (id === 'food_review_order') return askOrderConfirm(phone, booking, sessionData.cart || []);
  if (id === 'cart_view') return showCart(phone, booking, sessionData);
  if (id === 'cart_place') return askOrderConfirm(phone, booking, sessionData.cart || []);
  if (id === 'cart_confirm' || id === 'order_yes') return confirmOrder(phone, booking, sessionData);
  if (id === 'order_no' || id === 'cart_cancel') return cancelCart(phone, booking);
  if (id === 'guest_order_cancel') return handleGuestOrderCancel(phone, booking);
  // TODO(tomorrow): re-enable Edit Order with Flow Data Endpoint
  // if (id === 'guest_order_edit') return handleGuestOrderEdit(phone, booking);

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
  if (id === 'co_late') {
    await guestService.updateSession(phone, 'awaiting_late_checkout', {}, booking.id);
    return whatsapp.sendText(
      phone,
      '🕐 Late checkout ke liye time likhein (e.g. "2 PM" ya "3 baje").',
      booking.id
    );
  }
  if (id === 'svc_laundry') return sendLaundryMenu(phone, booking);
  if (id === 'svc_transport') return sendTransportMenu(phone, booking);

  return sendMainMenu(phone, booking);
}

// TODO(later): unused in MVP — guests use buttons/flows only. Re-enable via handleIncoming.
async function handleFreeText(phone, text, booking) {
  if (!booking) return blockNonGuest(phone);

  const intent = await openai.detectIntent(text);
  const lang = intent.language || 'mixed';
  const t = (text || '').trim();

  switch (intent.intent) {
    case 'greeting':
      return sendWelcome(phone, booking);
    case 'food':
      return handleFoodFreeText(phone, booking, text);
    case 'laundry':
      return isBrowseOnly(t, ['laundry', 'laundry menu', 'press', 'iron', 'kapde', 'clothes press', 'dry clean'])
        ? sendLaundryEntry(phone, booking)
        : sendLaundryMenu(phone, booking);
    case 'transport':
      return isBrowseOnly(t, ['transport', 'cab', 'taxi', 'gaadi', 'cab book', 'taxi book'])
        || /^(airport|station)\s*[?.!]*$/i.test(t)
        ? sendTransportEntry(phone, booking)
        : sendTransportMenu(phone, booking);
    case 'services':
      return sendServicesEntry(phone, booking);
    case 'order_status':
      return replyOrderStatus(phone, booking, text, lang);
    case 'order_cancel':
      return handleGuestOrderCancel(phone, booking);
    // TODO(tomorrow): re-enable Edit Order with Flow Data Endpoint
    // case 'order_edit':
    //   return handleGuestOrderEdit(phone, booking);
    case 'request_status':
      return replyRequestStatus(phone, booking, text, lang);
    case 'facilities':
    case 'faq': {
      if (isBrowseOnly(t, ['facilities', 'facility', 'hotel facilities', 'info', 'hotel info'])) {
        return sendFacilitiesEntry(phone, booking);
      }
      return replyHotelQuestion(phone, booking, text, lang, intent.faq_keyword);
    }
    case 'off_topic':
      return whatsapp.sendText(phone, openai.OFF_TOPIC_REPLY, booking.id);
    case 'reception':
      return sendReceptionEntry(phone, booking);
    case 'valet':
      return sendValetEntry(phone, booking);
    case 'housekeeping':
      if (isBrowseOnly(t, ['housekeeping', 'hk', 'cleaning', 'room cleaning'])) {
        return sendHousekeepingEntry(phone, booking);
      }
      if (/towel/i.test(text)) return createHousekeepingRequest(phone, booking, 'Extra Towels');
      if (/toiletries/i.test(text)) return createHousekeepingRequest(phone, booking, 'Toiletries');
      if (/clean|safai/i.test(text)) return createHousekeepingRequest(phone, booking, 'Room Cleaning');
      if (intent.issue) return createHousekeepingRequest(phone, booking, intent.issue);
      return sendHousekeepingEntry(phone, booking);
    case 'maintenance':
      if (isBrowseOnly(t, ['maintenance', 'repair', 'technician', 'fix'])) {
        return sendMaintenanceEntry(phone, booking);
      }
      return createMaintenanceRequest(phone, booking, intent.issue || text, intent.priority);
    case 'checkout':
      return sendCheckoutEntry(phone, booking);
    case 'late_checkout':
      return createLateCheckoutRequest(phone, booking, text);
    default: {
      if (isBrowseOnly(t, ['services', 'service', 'more services'])) {
        return sendServicesEntry(phone, booking);
      }
      const answered = await replyHotelQuestion(phone, booking, text, lang, text, true);
      if (answered) return answered;
      return sendWelcome(phone, booking);
    }
  }
}

function isBrowseOnly(text, phrases) {
  const t = (text || '').trim().toLowerCase().replace(/[?.!]+$/g, '').trim();
  return phrases.some((p) => t === p.toLowerCase());
}

async function sendLaundryEntry(phone, booking) {
  if (!booking) return blockNonGuest(phone);
  await guestService.updateSession(phone, 'idle', {}, booking.id);
  return whatsapp.sendButtons(
    phone,
    '👔 Laundry / Press\n\nShirt ₹50 · Pant ₹70 · Suit ₹150\nShirt+Pant = ₹120\n\nButton se shuru karein.',
    [
      { id: 'main_laundry', title: 'Open Laundry' },
      { id: 'laundry_combo_shirt_pant', title: 'Shirt + Pant' },
      { id: 'laundry_add_more', title: 'More Options' },
    ],
    booking.id
  );
}

async function sendTransportEntry(phone, booking) {
  if (!booking) return blockNonGuest(phone);
  await guestService.updateSession(phone, 'idle', {}, booking.id);
  return whatsapp.sendButtons(
    phone,
    '🚕 Transport / Cab\n\nKahan jaana hai? Button choose karein.',
    [
      { id: 'cab_airport', title: 'Airport' },
      { id: 'cab_local', title: 'Local Cab' },
      { id: 'cab_station', title: 'Station' },
    ],
    booking.id
  );
}

async function sendServicesEntry(phone, booking) {
  if (!booking) return blockNonGuest(phone);
  await guestService.updateSession(phone, 'idle', {}, booking.id);
  return whatsapp.sendButtons(
    phone,
    '🛎 Hotel Services\n\nKaunsi service chahiye?',
    [
      { id: 'svc_valet', title: 'Valet' },
      { id: 'svc_housekeeping', title: 'Housekeeping' },
      { id: 'main_services', title: 'More Services' },
    ],
    booking.id
  );
}

async function sendFacilitiesEntry(phone, booking) {
  if (!booking) return blockNonGuest(phone);
  await guestService.updateSession(phone, 'idle', {}, booking.id);
  return whatsapp.sendButtons(
    phone,
    '🏨 Hotel Facilities\n\nInfo dekhne ke liye button dabayein.',
    [
      { id: 'main_facilities', title: 'View Facilities' },
      { id: 'main_menu', title: 'Main Menu' },
    ],
    booking.id
  );
}

async function sendReceptionEntry(phone, booking) {
  if (!booking) return blockNonGuest(phone);
  await guestService.updateSession(phone, 'idle', {}, booking.id);
  return whatsapp.sendButtons(
    phone,
    '☎️ Reception\n\nFront desk se baat karni hai? Confirm karein — hum request bhej denge.',
    [
      { id: 'main_reception', title: 'Call Reception' },
      { id: 'main_menu', title: 'Main Menu' },
    ],
    booking.id
  );
}

async function sendValetEntry(phone, booking) {
  if (!booking) return blockNonGuest(phone);
  await guestService.updateSession(phone, 'idle', {}, booking.id);
  return whatsapp.sendButtons(
    phone,
    '🚗 Valet\n\nLuggage down ya car retrieve?',
    [
      { id: 'valet_luggage', title: 'Luggage Down' },
      { id: 'valet_car', title: 'Car Retrieve' },
      { id: 'main_menu', title: 'Main Menu' },
    ],
    booking.id
  );
}

async function sendHousekeepingEntry(phone, booking) {
  if (!booking) return blockNonGuest(phone);
  await guestService.updateSession(phone, 'idle', {}, booking.id);
  return whatsapp.sendButtons(
    phone,
    '🧹 Housekeeping\n\nKya chahiye? Button choose karein.',
    [
      { id: 'hk_extra_towel', title: 'Extra Towels' },
      { id: 'hk_room_cleaning', title: 'Room Cleaning' },
      { id: 'svc_housekeeping', title: 'More Options' },
    ],
    booking.id
  );
}

async function sendMaintenanceEntry(phone, booking) {
  if (!booking) return blockNonGuest(phone);
  await guestService.updateSession(phone, 'idle', {}, booking.id);
  return whatsapp.sendButtons(
    phone,
    '🔧 Maintenance\n\nIssue report karne ke liye button dabayein.',
    [
      { id: 'svc_maintenance', title: 'Report Issue' },
      { id: 'main_menu', title: 'Main Menu' },
    ],
    booking.id
  );
}

async function sendCheckoutEntry(phone, booking) {
  if (!booking) return blockNonGuest(phone);
  await guestService.updateSession(phone, 'idle', {}, booking.id);
  return whatsapp.sendButtons(
    phone,
    '🚪 Checkout\n\nStandard checkout ya late checkout?',
    [
      { id: 'svc_checkout', title: 'Checkout Now' },
      { id: 'co_late', title: 'Late Checkout' },
      { id: 'main_menu', title: 'Main Menu' },
    ],
    booking.id
  );
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
  const wantsMenuOnly =
    parsed.browse_menu ||
    /^(menu|food menu|khana menu|menu dikhao|menu dikha|show menu)\s*[?.!]*$/i.test((text || '').trim());

  // Place whatever matched — ask Yes/No first
  if (parsed.ok && parsed.items.length) {
    const cart = parsed.items.map((i) => ({
      menu_item_id: i.menu_item_id,
      name: i.name,
      quantity: i.quantity,
      price: i.price,
    }));
    return askOrderConfirm(phone, booking, cart, unmatched);
  }

  if (unmatched.length && !wantsMenuOnly) {
    return whatsapp.sendButtons(
      phone,
      notOnMenuMessage(unmatched),
      [
        { id: 'main_food', title: '🍽 View Menu' },
        { id: 'main_menu', title: 'Main Menu' },
      ],
      booking.id
    );
  }

  // "menu" typed → give Menu button (don't jump into categories yet)
  if (wantsMenuOnly || !parsed.ok) {
    return sendMenuButtons(phone, booking);
  }

  return startFoodFlow(phone, booking);
}

async function sendMenuButtons(phone, booking) {
  if (!booking) return blockNonGuest(phone);
  await guestService.updateSession(phone, 'idle', {}, booking.id);
  return whatsapp.sendButtons(
    phone,
    '🍽️ Food Menu\n\nMenu dekhne ke liye button dabayein.',
    [
      { id: 'main_food', title: '🍽 View Menu' },
      { id: 'meal_dinner', title: '🌙 Dinner' },
      { id: 'meal_snacks', title: '🍿 Snacks' },
    ],
    booking.id
  );
}

function notOnMenuMessage(unmatched) {
  const list = unmatched.map((u) => `• ${u}`).join('\n');
  return (
    `❌ Sorry, ye menu mein available nahi hai:\n${list}\n\n` +
    `Kripya menu se koi available item order karein (e.g. Masala Chai, Sandwich, Chicken Biryani).`
  );
}

async function askOrderConfirm(phone, booking, cartItems, unmatched = []) {
  if (!booking) return blockNonGuest(phone);
  const cart = (cartItems || []).filter((c) => c.menu_item_id && c.quantity);
  if (!cart.length) {
    return whatsapp.sendText(phone, 'Cart empty hai. Pehle item add karein.', booking.id);
  }

  // Ensure name/price for display
  const displayCart = [];
  for (const c of cart) {
    let name = c.name;
    let price = c.price;
    if (name == null || price == null) {
      const item = await menuRepo.getItemById(c.menu_item_id);
      if (!item) continue;
      name = item.name;
      price = parseFloat(item.price);
    }
    displayCart.push({
      menu_item_id: c.menu_item_id,
      name,
      quantity: c.quantity,
      price: parseFloat(price),
    });
  }

  if (!displayCart.length) {
    return whatsapp.sendText(phone, 'Items available nahi mile.', booking.id);
  }

  let total = 0;
  const lines = displayCart.map((c) => {
    const sub = c.price * c.quantity;
    total += sub;
    return `• ${c.name} × ${c.quantity} — ₹${sub.toFixed(0)}`;
  });

  let extra = '';
  if (unmatched.length) {
    extra = `\n\n⚠️ Menu mein nahi: ${unmatched.join(', ')}`;
  }

  await guestService.updateSession(phone, 'food_confirm', { cart: displayCart }, booking.id);

  return whatsapp.sendButtons(
    phone,
    `Confirm your order?\n\n` +
      `Room: ${booking.room_number}\n\n` +
      `${lines.join('\n')}\n\n` +
      `────────────\n` +
      `Total: ₹${total.toFixed(0)}\n\n` +
      `Chef: ${STAFF.chef}\n` +
      `Waiter: ${STAFF.waiter}` +
      extra +
      `\n\nTap Confirm to send this to the kitchen.`,
    [
      { id: 'order_yes', title: 'Confirm' },
      { id: 'order_no', title: 'Cancel' },
    ],
    booking.id
  );
}

async function placeDirectOrder(phone, booking, items) {
  return askOrderConfirm(phone, booking, items);
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

async function handleStateInput(phone, text, booking, session, sessionData = {}) {
  if (!booking) {
    await guestService.resetSession(phone);
    return blockNonGuest(phone);
  }

  if (session.current_state === 'food_confirm') {
    const lower = (text || '').trim().toLowerCase();
    const data = sessionData && Object.keys(sessionData).length
      ? sessionData
      : guestService.parseSessionData(session);
    if (/^(yes|y|haan|ha|ok|confirm|order karo)$/i.test(lower)) {
      return confirmOrder(phone, booking, data);
    }
    if (/^(no|n|nahi|cancel|mat karo)$/i.test(lower)) {
      return cancelCart(phone, booking);
    }
    return askOrderConfirm(phone, booking, data.cart || []);
  }

  if (session.current_state === 'awaiting_maintenance') {
    await guestService.resetSession(phone);
    return createMaintenanceRequest(phone, booking, text, 'medium');
  }

  if (session.current_state === 'awaiting_late_checkout') {
    await guestService.resetSession(phone);
    return createLateCheckoutRequest(phone, booking, text);
  }

  // TODO(later): re-enable free-text NLP — typing never blocked by list/button state
  // return handleFreeText(phone, text, booking);
  return sendWelcome(phone, booking);
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
        { id: 'main_food', title: '🍽 Food / Dining', description: 'Order from the menu' },
        { id: 'main_laundry', title: '👔 Laundry / Press', description: 'Clothes press & laundry' },
        { id: 'main_transport', title: '🚕 Transport / Cab', description: 'Airport & local cab' },
        { id: 'main_facilities', title: 'ℹ️ Hotel Facilities', description: 'WiFi, pool, spa, timings' },
        { id: 'main_reception', title: '🛎️ Reception', description: 'Talk to front desk' },
        { id: 'main_services', title: '✨ More Services', description: 'Valet, cleaning, checkout' },
        { id: 'main_stay', title: '🛏️ My Stay', description: 'Your room & booking info' },
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
        { id: 'main_food', title: '🍽 Food / Dining', description: 'Order from the menu' },
        { id: 'main_laundry', title: '👔 Laundry / Press', description: 'Clothes press & laundry' },
        { id: 'main_transport', title: '🚕 Transport / Cab', description: 'Airport & local cab' },
        { id: 'main_facilities', title: 'ℹ️ Hotel Facilities', description: 'WiFi, pool, spa, timings' },
        { id: 'main_reception', title: '🛎️ Reception', description: 'Talk to front desk' },
        { id: 'main_services', title: '✨ More Services', description: 'Valet, cleaning, checkout' },
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

  const session = await guestService.getOrCreateSession(phone);
  const existing = guestService.parseSessionData(session);
  const cart = existing.cart || [];
  await guestService.updateSession(phone, 'food_home', { cart }, booking.id);

  return showMealTypes(phone, booking, { cart });
}

/** Open food Flow (CheckboxGroup + images), one page at a time. */
async function openFoodMenuFlow(phone, booking, opts = {}, bodyExtra = '') {
  if (!booking) return whatsapp.sendText(phone, 'Food ordering requires an active stay.', null);
  if (!flowService.isFlowConfigured('food')) return false;

  const session = await guestService.getOrCreateSession(phone);
  const existing = guestService.parseSessionData(session);
  const page = Math.max(0, parseInt(opts.page, 10) || 0);

  const built = await buildFoodFlowScreenData(opts.orderItems || existing.cart || [], {
    mealType: opts.mealType ?? existing.mealType,
    categoryId: opts.categoryId ?? existing.categoryId,
    page,
  });

  if (!built.products?.length || built.products[0]?.id === '0') {
    return false;
  }

  await guestService.updateSession(phone, 'food_flow', {
    cart: existing.cart || [],
    foodPage: built.page,
    foodHasMore: built.hasMore,
    foodTotal: built.total,
    mealType: opts.mealType ?? existing.mealType ?? null,
    categoryId: opts.categoryId ?? existing.categoryId ?? null,
  }, booking.id);

  const pageLabel = built.total > FOOD_PAGE_SIZE
    ? ` (page ${built.page + 1}/${Math.ceil(built.total / FOOD_PAGE_SIZE)})`
    : '';

  return openHotelFlow(
    phone,
    booking,
    'food',
    bodyExtra || `Select products with images${pageLabel}, then set quantity.`,
    (() => {
      const { page: _p, total: _t, hasMore: _h, ...screenData } = built;
      return screenData;
    })()
  );
}

async function showMealTypes(phone, booking, sessionData = {}) {
  return whatsapp.sendList(
    phone,
    'Food / Dining\n\nPick a menu, then order in the form (items + qty + total confirm).',
    'View Menu',
    [{
      title: 'Menu',
      rows: [
        { id: 'meal_dinner', title: '🌙 Dinner Menu', description: 'Order from dinner items' },
        { id: 'meal_breakfast', title: '🌅 Breakfast', description: 'Order from breakfast items' },
        { id: 'meal_snacks', title: '🍿 Snacks', description: 'Order from snacks' },
      ],
    }],
    booking.id
  );
}

async function showCategories(phone, booking, mealType, sessionData = {}) {
  const label = mealType.charAt(0).toUpperCase() + mealType.slice(1);

  // Prefer food Flow for this meal (Dinner / Breakfast / Snacks) — page 0
  const flowOk = await openFoodMenuFlow(
    phone,
    booking,
    { mealType, page: 0, orderItems: sessionData.cart || [] },
    `${label} menu — select products with images.`
  );
  if (flowOk) return;

  const categories = await menuRepo.getCategoriesByMealType(HOTEL_ID, mealType);
  if (!categories.length) {
    return whatsapp.sendText(phone, 'Is meal type ke liye menu available nahi hai.', booking.id);
  }

  await guestService.updateSession(phone, 'food_category', {
    cart: sessionData.cart || [],
    mealType,
  }, booking.id);

  return whatsapp.sendList(
    phone,
    `${label} Menu\n\nSelect a category:`,
    'Categories',
    [{
      title: 'Categories',
      rows: categories.map((c) => ({
        id: `cat_${c.id}`,
        title: c.name.slice(0, 24),
        description: 'Tap to order items',
      })),
    }],
    booking.id
  );
}

async function showItems(phone, booking, categoryId, sessionData = {}) {
  // Prefer food-quick Flow for this category
  const cats = await menuRepo.findAllCategories(HOTEL_ID);
  const cat = cats.find((c) => Number(c.id) === Number(categoryId));
  const flowOk = await openFoodMenuFlow(
    phone,
    booking,
    { categoryId, page: 0, orderItems: sessionData.cart || [] },
    cat ? `${cat.name} — select products with images.` : 'Select products with images.'
  );
  if (flowOk) return;

  const items = await menuRepo.getItemsByCategory(categoryId);
  if (!items.length) {
    return whatsapp.sendText(phone, 'Is category mein items available nahi hain.', booking.id);
  }

  await guestService.updateSession(phone, 'food_item', {
    ...sessionData,
    cart: sessionData.cart || [],
    categoryId,
  }, booking.id);

  let text = 'Menu Items\n\n';
  text += items.map((i) => `• ${i.name} — ₹${parseFloat(i.price).toFixed(0)}`).join('\n');
  text += '\n\nList se item choose karein.';

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

  return whatsapp.sendButtons(
    phone,
    `✅ Order Placed!\n\n` +
    `Order ID: #${order.order_ref}\n` +
    `Room: ${booking.room_number}\n` +
    `Items:\n${itemLines}\n` +
    `Total Amount: ₹${parseFloat(order.total_amount).toFixed(0)}\n` +
    `Status: Pending (admin confirm ka wait)\n` +
    `Estimated Delivery: 30 Minutes\n` +
    `👨‍🍳 Chef: ${STAFF.chef}\n` +
    `🧑‍🍳 Waiter: ${STAFF.waiter}\n\n` +
    `Admin confirm se pehle aap Cancel kar sakte ho.`,
    [
      { id: 'guest_order_cancel', title: 'Cancel Order' },
      // TODO(tomorrow): re-enable Edit Order with Flow Data Endpoint
      // { id: 'guest_order_edit', title: 'Edit Order' },
      { id: 'main_menu', title: 'Main Menu' },
    ],
    booking.id
  );
}

const ORDER_LOCKED_MSG =
  '✅ Order confirm ho chuka hai admin/kitchen se.\nAb cancel nahi ho sakta.';

async function getLatestModifiableOrder(bookingId) {
  const orders = await orderRepo.findAll({ booking_id: bookingId });
  const pending = orders.find((o) => o.status === 'pending');
  if (pending) return { order: pending, locked: false };
  const confirmed = orders.find((o) =>
    ['accepted', 'preparing', 'out_for_delivery', 'delivered'].includes(o.status)
  );
  if (confirmed) return { order: confirmed, locked: true };
  return { order: null, locked: false };
}

async function handleGuestOrderCancel(phone, booking) {
  if (!booking) return blockNonGuest(phone);
  const { order, locked } = await getLatestModifiableOrder(booking.id);

  if (!order) {
    return whatsapp.sendText(phone, 'Koi active food order nahi mila cancel karne ke liye.', booking.id);
  }
  if (locked) {
    return whatsapp.sendText(
      phone,
      `Order #${order.order_ref} — ${ORDER_LOCKED_MSG}`,
      booking.id
    );
  }

  await orderService.updateStatus(order.id, 'cancelled');
  await guestService.updateSession(phone, 'idle', { cart: [] }, booking.id);
  return whatsapp.sendButtons(
    phone,
    `❌ Order cancel ho gaya.\n\nOrder ID: #${order.order_ref}\nRoom: ${booking.room_number}\n\nNaya order karna ho to menu se order karein.`,
    [
      { id: 'main_food', title: 'Order Again' },
      { id: 'main_menu', title: 'Main Menu' },
    ],
    booking.id
  );
}

// TODO(tomorrow): re-enable Edit Order with Flow Data Endpoint
async function handleGuestOrderEdit(phone, booking) {
  if (!booking) return blockNonGuest(phone);
  return whatsapp.sendText(
    phone,
    'Edit Order temporarily unavailable. Cancel the order and place a new one, or try again later.',
    booking.id
  );
  /*
  const { order, locked } = await getLatestModifiableOrder(booking.id);

  if (!order) {
    return whatsapp.sendText(phone, 'No active food order found to edit.', booking.id);
  }
  if (locked) {
    return whatsapp.sendText(
      phone,
      `Order #${order.order_ref} — ${ORDER_LOCKED_MSG}`,
      booking.id
    );
  }

  const full = await orderRepo.findById(order.id);
  await orderService.updateStatus(order.id, 'cancelled');

  if (flowService.isFlowConfigured('food_edit') || flowService.isFlowConfigured('food')) {
    const screenData = await buildFoodFlowScreenData(full.items || []);
    const flowKey = flowService.isFlowConfigured('food_edit') ? 'food_edit' : 'food';
    const ok = await openHotelFlow(
      phone,
      booking,
      flowKey,
      `Editing order #${order.order_ref}. Update quantities and submit.\nPrevious pending order was cancelled.`,
      screenData
    );
    if (ok) return;
  }

  const cart = (full.items || []).map((i) => ({
    menu_item_id: i.menu_item_id,
    name: i.item_name,
    quantity: i.quantity,
    price: parseFloat(i.unit_price),
  }));

  await guestService.updateSession(phone, 'food_cart', { cart, editingOrderRef: order.order_ref }, booking.id);

  return whatsapp.sendText(
    phone,
    `Edit mode\nPrevious order #${order.order_ref} was cancelled.\nItems are in your cart — change and place again.`,
    booking.id
  ).then(() => showCart(phone, booking, { cart }));
  */
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
      'Select quantity per item. Shirt / Pant / Suit press.',
      flowService.buildLaundryFlowScreenData()
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
    return whatsapp.sendText(phone, 'Facilities info is not available right now. Please contact reception.', booking.id);
  }

  if (flowService.isFlowConfigured('facilities')) {
    const faq_options = faqs.slice(0, 10).map((f) => ({
      id: String(f.id),
      title: String(f.question || 'Info').slice(0, 30),
      description: String(f.keywords || f.answer || '').slice(0, 72),
    }));
    const ok = await openHotelFlow(
      phone,
      booking,
      'facilities',
      'Select a topic for hotel facilities and info.',
      { faq_options }
    );
    if (ok) return;
  }

  return whatsapp.sendList(
    phone,
    'Hotel Facilities\n\nWhat would you like to know?',
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
        { id: 'svc_valet', title: '🧳 Valet', description: 'Luggage or car retrieve' },
        { id: 'svc_housekeeping', title: '🧹 Housekeeping', description: 'Cleaning, towels, water' },
        { id: 'svc_laundry', title: '👔 Laundry / Press', description: 'Clothes press' },
        { id: 'svc_transport', title: '🚕 Transport / Cab', description: 'Airport & local' },
        { id: 'svc_maintenance', title: '🔧 Maintenance', description: 'AC, TV, repairs' },
        { id: 'svc_checkout', title: '🧾 Checkout', description: 'Request checkout' },
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
