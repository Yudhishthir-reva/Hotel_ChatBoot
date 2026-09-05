/**
 * WhatsApp Flows — config, parse, and helpers.
 * JSON files live in /flows — create each in Meta (Without Endpoint), publish, paste IDs in .env
 */

const LAUNDRY_CATALOG = {
  shirt: { name: 'Shirt Press', price: 50 },
  pant: { name: 'Pant Press', price: 70 },
  suit: { name: 'Suit Press', price: 150 },
};

/** Maps food flow checkbox ids → menu item name (DB match) */
const FOOD_FLOW_ITEMS = {
  chicken_biryani: 'Chicken Biryani',
  butter_chicken: 'Butter Chicken',
  dal_makhani: 'Dal Makhani',
  paneer_tikka: 'Paneer Tikka',
  masala_chai: 'Masala Chai',
  cold_coffee: 'Cold Coffee',
  gulab_jamun: 'Gulab Jamun',
  french_fries: 'French Fries',
};

const HOUSEKEEPING_LABELS = {
  room_cleaning: 'Room Cleaning',
  extra_towel: 'Extra Towel',
  toiletries: 'Toiletries',
  water: 'Drinking Water',
  bed_make: 'Make Bed',
  other: 'Other',
};

const FLOW_CONFIG = {
  laundry: {
    env: 'WHATSAPP_LAUNDRY_FLOW_ID',
    screen: 'LAUNDRY',
    cta: 'Select Items',
    header: 'Laundry / Press',
    file: 'flows/laundry-press.json',
  },
  housekeeping: {
    env: 'WHATSAPP_HOUSEKEEPING_FLOW_ID',
    screen: 'HOUSEKEEPING',
    cta: 'Select Items',
    header: 'Housekeeping',
    file: 'flows/housekeeping.json',
  },
  valet: {
    env: 'WHATSAPP_VALET_FLOW_ID',
    screen: 'VALET',
    cta: 'Choose Option',
    header: 'Valet',
    file: 'flows/valet.json',
  },
  transport: {
    env: 'WHATSAPP_TRANSPORT_FLOW_ID',
    screen: 'TRANSPORT',
    cta: 'Book Cab',
    header: 'Transport / Cab',
    file: 'flows/transport.json',
  },
  maintenance: {
    env: 'WHATSAPP_MAINTENANCE_FLOW_ID',
    screen: 'MAINTENANCE',
    cta: 'Report Issue',
    header: 'Maintenance',
    file: 'flows/maintenance.json',
  },
  checkout: {
    env: 'WHATSAPP_CHECKOUT_FLOW_ID',
    screen: 'CHECKOUT',
    cta: 'Checkout',
    header: 'Checkout',
    file: 'flows/checkout.json',
  },
  food: {
    env: 'WHATSAPP_FOOD_FLOW_ID',
    screen: 'FOOD',
    cta: 'Quick Order',
    header: 'Food / Dining',
    file: 'flows/food-quick.json',
  },
};

function getFlowId(key) {
  const cfg = FLOW_CONFIG[key];
  if (!cfg) return null;
  return process.env[cfg.env] || null;
}

function isFlowConfigured(key) {
  return Boolean(getFlowId(key));
}

function getFlowMeta(key) {
  return FLOW_CONFIG[key] || null;
}

function parseFlowResponse(responseJson) {
  if (!responseJson) return null;
  try {
    const data = typeof responseJson === 'string' ? JSON.parse(responseJson) : responseJson;
    const items = Array.isArray(data.items) ? data.items.map(String) : [];
    return {
      flow_name: data.flow_name || null,
      items,
      raw: data,
    };
  } catch (err) {
    console.error('[Flow] Failed to parse response_json:', err.message);
    return null;
  }
}

function buildLaundryCartFromFlowItems(itemIds) {
  const cart = [];
  for (const id of itemIds) {
    const key = String(id).toLowerCase();
    const item = LAUNDRY_CATALOG[key];
    if (!item) continue;
    const existing = cart.find((c) => c.key === key);
    if (existing) existing.quantity += 1;
    else cart.push({ key, name: item.name, quantity: 1, price: item.price });
  }
  return cart;
}

function labelHousekeepingItems(itemIds) {
  return itemIds.map((id) => HOUSEKEEPING_LABELS[id] || id).join(', ');
}

function labelValet(type) {
  if (type === 'luggage_down') return 'Luggage Down';
  if (type === 'car_retrieve') return 'Car Retrieve';
  return type || 'Valet';
}

function labelDestination(dest) {
  const map = {
    airport: 'Airport Transfer',
    station: 'Railway Station',
    local: 'Local Cab',
    other: 'Other Location',
  };
  return map[dest] || dest || 'Cab';
}

module.exports = {
  LAUNDRY_CATALOG,
  FOOD_FLOW_ITEMS,
  HOUSEKEEPING_LABELS,
  FLOW_CONFIG,
  getFlowId,
  isFlowConfigured,
  getFlowMeta,
  parseFlowResponse,
  buildLaundryCartFromFlowItems,
  labelHousekeepingItems,
  labelValet,
  labelDestination,
};
