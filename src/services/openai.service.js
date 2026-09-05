const OpenAI = require('openai');
const faqRepo = require('../repositories/faq.repository');

let client = null;

function getClient() {
  if (!client && process.env.OPENAI_API_KEY) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

const SYSTEM_PROMPT = `You are an intent classifier for a hotel WhatsApp guest assistant.
Analyze the guest message and return ONLY valid JSON:
{
  "intent": "food|laundry|transport|facilities|reception|valet|housekeeping|maintenance|checkout|late_checkout|faq|order_status|request_status|greeting|off_topic|unknown",
  "issue": "short issue description if maintenance/housekeeping, else null",
  "priority": "low|medium|high",
  "faq_keyword": "keyword to search FAQ if intent is faq/facilities, else null",
  "language": "en|hi|mixed"
}

Rules:
- Specific food/drink order in text ("2 cup chai bhej do", "ek biryani", "cold coffee 2", "paneer tikka bhej do") → food (guest may skip menu)
- Want to browse menu / "menu dikhao" / "khana order karna" without naming items → food
- Asking STATUS of an existing food order ("mera order", "order status", "khana kab aayega", "mene order kiya tha") → order_status
- Asking STATUS of laundry/valet/HK/maintenance/request ("mera request", "laundry status", "kab hoga") → request_status
- "laundry", "press", "iron", "kapde" (to place new) → laundry
- "cab", "taxi", "transport", "airport" → transport
- Hotel info: wifi, pool, spa, buffet, timing, facilities → facilities (set faq_keyword)
- Timing/password/facility questions → faq (set faq_keyword)
- "reception", "front desk", "manager" → reception
- "valet", "car retrieve", "luggage" → valet
- "cleaning", "towel", "toiletries" (request items) → housekeeping
- Room complaints: no water / pani nahi / AC / TV / leak / broken / light → maintenance (set issue + priority)
- "checkout" → checkout; "late checkout" → late_checkout
- "hi", "hello", "namaste" → greeting
- Completely unrelated to hotel stay (world history, coding, politics, homework, random trivia) → off_topic
- Never invent answers. Only classify intent.`;

async function detectIntent(message) {
  const openai = getClient();
  if (!openai) {
    return fallbackIntent(message);
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: message },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (err) {
    console.error('[OpenAI] Intent detection failed:', err.message);
    return fallbackIntent(message);
  }
}

function fallbackIntent(message) {
  const lower = message.toLowerCase();

  if (/^(hi|hello|hey|namaste)/i.test(lower)) return { intent: 'greeting', language: 'mixed' };

  if (/status|kab aayega|kab milega|track|kahan hai|update.*(order|request)|mera (order|request)|order.*(status|hua)|request.*(status|hua)/i.test(lower)) {
    if (/order|khana|food|dinner|lunch|breakfast/i.test(lower)) {
      return { intent: 'order_status', language: 'mixed' };
    }
    return { intent: 'request_status', language: 'mixed' };
  }

  if (/chai|tea|coffee|biryani|paneer|pizza|fries|sandwich|gulab|ice cream|bhej do|bhej dena|cup |plates?|order kar|khana |pani ki|paani ki|water bottle|bottel/i.test(lower)) {
    return { intent: 'food', language: 'mixed' };
  }
  if (/menu|food|dinner|lunch|breakfast|order|khana/i.test(lower)) return { intent: 'food', language: 'mixed' };
  if (/laundry|press|iron|kapde|clothes/i.test(lower)) return { intent: 'laundry', language: 'mixed' };
  if (/cab|taxi|transport|airport|station/i.test(lower)) return { intent: 'transport', language: 'mixed' };
  if (/reception|front desk|manager|callback/i.test(lower)) return { intent: 'reception', language: 'mixed' };
  if (/facility|facilities|wifi|pool|spa|buffet|timing|password|sham|evening/i.test(lower)) {
    return { intent: 'facilities', faq_keyword: lower, language: 'mixed' };
  }
  if (/valet|luggage|gaadi retrieve|car retrieve/i.test(lower)) return { intent: 'valet', language: 'mixed' };
  if (/pani nahi|no water|water not|tap|leak|plumbing|bathroom.*(nahi|band)/i.test(lower)) {
    return { intent: 'maintenance', issue: message, priority: 'high', language: 'mixed' };
  }
  if (/clean|towel|toiletries|bottled water|safai|paani ki bottle/i.test(lower)) {
    return { intent: 'housekeeping', issue: message, language: 'mixed' };
  }
  if (/ac|tv|broken|repair|maintenance|nahi chal|light nahi|fan nahi/i.test(lower)) {
    return { intent: 'maintenance', issue: message, priority: /ac|gas|fire|leak|pani/i.test(lower) ? 'high' : 'medium', language: 'mixed' };
  }
  if (/late checkout|2 baje|3 baje/i.test(lower)) return { intent: 'late_checkout', issue: message, language: 'mixed' };
  if (/checkout|check out|check-out/i.test(lower)) return { intent: 'checkout', language: 'mixed' };

  if (/world war|python|javascript|cricket score|bitcoin|politics|homework|exam|prime minister/i.test(lower)) {
    return { intent: 'off_topic', language: 'mixed' };
  }

  return { intent: 'unknown', language: 'mixed' };
}

async function matchFaq(hotelId, keyword) {
  const faqs = await faqRepo.findActive(hotelId);
  if (!faqs.length) return null;

  const search = (keyword || '').toLowerCase();
  const words = search.split(/\s+/).filter(Boolean);

  let best = null;
  let bestScore = 0;

  for (const faq of faqs) {
    let score = 0;
    const haystack = `${faq.question} ${faq.keywords || ''} ${faq.answer || ''}`.toLowerCase();
    for (const word of words) {
      if (word.length > 2 && haystack.includes(word)) score++;
    }
    // Hindi / common aliases
    if (/buffet|sham|evening|dinner|lunch|breakfast|khana/i.test(search) && /buffet|breakfast|lunch|dinner/i.test(haystack)) {
      score += 2;
    }
    if (/wifi|password|internet/i.test(search) && /wifi|password|internet/i.test(haystack)) score += 2;
    if (/pool|swimming|taran/i.test(search) && /pool|swimming/i.test(haystack)) score += 2;

    if (score > bestScore) {
      bestScore = score;
      best = faq;
    }
  }

  return bestScore > 0 ? best : null;
}

/**
 * Answer hotel questions using ONLY provided FAQ + hotel facts.
 * Refuses off-topic / unknown facts.
 */
async function answerHotelQuestion(message, context = {}) {
  const { hotel, faqs = [], language = 'mixed' } = context;
  const openai = getClient();

  const faqBlock = faqs
    .map((f, i) => `${i + 1}. Q: ${f.question}\n   A: ${f.answer}`)
    .join('\n');

  const hotelBlock = hotel
    ? [
        `Hotel: ${hotel.name || 'Hotel'}`,
        hotel.address ? `Address: ${hotel.address}` : null,
        hotel.check_in_time ? `Check-in: ${hotel.check_in_time}` : null,
        hotel.check_out_time ? `Check-out: ${hotel.check_out_time}` : null,
        hotel.wifi_password ? `WiFi password: ${hotel.wifi_password}` : null,
        hotel.late_checkout_policy ? `Late checkout: ${hotel.late_checkout_policy}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  if (!openai) {
    const faq = await matchFaqFallbackLocal(faqs, message);
    if (faq) return { ok: true, answer: faq.answer };
    return { ok: false, reason: 'unknown' };
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a helpful hotel WhatsApp concierge for in-stay guests.
Answer ONLY using the hotel facts and FAQ below. Be brief (1-3 short lines), friendly, WhatsApp style.
Reply in the guest's language (Hindi/English/Hinglish as appropriate). Language hint: ${language}.

If the question is unrelated to this hotel stay (history, coding, politics, general trivia, etc.), return JSON:
{"ok":false,"reason":"off_topic"}

If it is hotel-related but you do not have the fact, return:
{"ok":false,"reason":"unknown"}

If you can answer from the facts, return:
{"ok":true,"answer":"your short reply without inventing extra facts"}

HOTEL FACTS:
${hotelBlock || '(none)'}

FAQ:
${faqBlock || '(none)'}`,
        },
        { role: 'user', content: message },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    if (parsed.ok && parsed.answer) return { ok: true, answer: String(parsed.answer).trim() };
    return { ok: false, reason: parsed.reason || 'unknown' };
  } catch (err) {
    console.error('[OpenAI] Hotel answer failed:', err.message);
    const faq = matchFaqFallbackLocal(faqs, message);
    if (faq) return { ok: true, answer: faq.answer };
    return { ok: false, reason: 'unknown' };
  }
}

function matchFaqFallbackLocal(faqs, message) {
  if (!faqs?.length) return null;
  const search = (message || '').toLowerCase();
  const words = search.split(/\s+/).filter(Boolean);
  let best = null;
  let bestScore = 0;
  for (const faq of faqs) {
    let score = 0;
    const haystack = `${faq.question} ${faq.keywords || ''} ${faq.answer || ''}`.toLowerCase();
    for (const word of words) {
      if (word.length > 2 && haystack.includes(word)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = faq;
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * Phrase order/request status from DB rows. Does not invent statuses.
 */
async function phraseStatusUpdate(message, context = {}) {
  const { orders = [], requests = [], language = 'mixed', kind = 'order' } = context;
  const openai = getClient();

  const orderLines = orders.slice(0, 5).map((o) => {
    const items = (o.items || []).map((i) => `${i.item_name} x${i.quantity}`).join(', ');
    return `- ${o.order_ref}: status=${o.status}, amount=₹${o.total_amount}, items=[${items}], created=${o.created_at}`;
  });

  const requestLines = requests.slice(0, 5).map((r) => {
    return `- ${r.request_ref}: type=${r.type}${r.sub_type ? '/' + r.sub_type : ''}, status=${r.status}, desc=${r.description || '-'}, created=${r.created_at}`;
  });

  if (!orders.length && !requests.length) {
    if (kind === 'order') {
      return {
        ok: true,
        answer: 'Aapke naam pe koi recent food order nahi mila. Naya order ke liye menu se Food Order choose karein. 🙂',
      };
    }
    return {
      ok: true,
      answer: 'Aapke naam pe koi active service request nahi mili. Nayi request ke liye main menu use karein. 🙂',
    };
  }

  if (!openai) {
    return {
      ok: true,
      answer: formatStatusFallback(orders, requests, kind),
    };
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a hotel WhatsApp assistant. Tell the guest their real order/request status using ONLY the data below.
Be brief, friendly, WhatsApp style. Use guest language (hint: ${language}). Do not invent new statuses or ETAs.
Status meanings: pending=received/waiting, confirmed=accepted, preparing=being prepared, out_for_delivery/in_progress=in progress, delivered/done=completed, cancelled/rejected=cancelled.
Return JSON: {"ok":true,"answer":"..."}

ORDERS:
${orderLines.join('\n') || '(none)'}

REQUESTS:
${requestLines.join('\n') || '(none)'}`,
        },
        { role: 'user', content: message },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    if (parsed.answer) return { ok: true, answer: String(parsed.answer).trim() };
    return { ok: true, answer: formatStatusFallback(orders, requests, kind) };
  } catch (err) {
    console.error('[OpenAI] Status phrase failed:', err.message);
    return { ok: true, answer: formatStatusFallback(orders, requests, kind) };
  }
}

function formatStatusFallback(orders, requests, kind) {
  const lines = [];
  if (kind === 'order' || orders.length) {
    for (const o of orders.slice(0, 3)) {
      const items = (o.items || []).map((i) => i.item_name).join(', ');
      lines.push(`🍽 ${o.order_ref}: *${o.status}*${items ? ` (${items})` : ''} — ₹${o.total_amount}`);
    }
  }
  if (kind === 'request' || (!orders.length && requests.length)) {
    for (const r of requests.slice(0, 3)) {
      lines.push(`🛎 ${r.request_ref}: ${r.type}${r.sub_type ? ' / ' + r.sub_type : ''} — *${r.status}*`);
    }
  }
  return lines.length ? lines.join('\n') : 'Koi recent update nahi mili.';
}

const OFF_TOPIC_REPLY =
  'Main sirf aapke hotel stay se related help kar sakta hoon — food, laundry, facilities, WiFi, requests, order status, etc. 🙂\nKuch hotel related poochhein ya main menu dekhein.';

/**
 * Parse free-text food order against real menu items from DB.
 * Only returns menu_item_ids that exist in the provided list.
 */
async function parseFoodOrder(message, menuItems = []) {
  const available = (menuItems || []).filter((i) => i.is_available !== 0 && i.is_available !== false);
  if (!available.length) {
    return { ok: false, items: [], unmatched: [], reason: 'empty_menu' };
  }

  const openai = getClient();
  const menuBlock = available
    .map((i) => `- id:${i.id} | ${i.name} | ₹${parseFloat(i.price).toFixed(0)} | ${i.category_name || ''}`)
    .join('\n');

  if (!openai) {
    return parseFoodOrderFallback(message, available);
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You match a hotel guest's WhatsApp food/drink request to MENU items.
Return ONLY JSON:
{
  "ok": true|false,
  "items": [{"menu_item_id": number, "quantity": number}],
  "unmatched": ["guest phrase that could not be matched"],
  "browse_menu": true|false
}

Rules:
- Map ONLY clear aliases: chai/tea → Masala Chai; coffee → Cold Coffee if that is the only coffee; pani/bottle/water → Mineral Water Bottle; etc.
- Support multiple items in one message: "2 cup chai aur ek pani ki bottle" → both items.
- quantity default 1; "2 cup", "do cup", "2x", "ek" → correct quantity per item
- ONLY use menu_item_id values from the MENU list below. Never invent ids or items.
- Do NOT fuzzy-guess: chicken burger / chick burger / pizza / pasta are NOT Chicken Wings or Sandwich unless the guest said those exact menu names.
- If an item is not clearly on the MENU, put it in unmatched and do not invent a substitute.
- If guest only asks to see menu (no item names), set browse_menu:true and items:[].
- If nothing matches, ok:false and list unmatched phrases (use guest's words, e.g. "chick burger").
- Partial OK: match what you can, list the rest in unmatched.
- Merge duplicate ids by summing quantities.

MENU:
${menuBlock}`,
        },
        { role: 'user', content: message },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    const idSet = new Set(available.map((i) => Number(i.id)));
    const byId = new Map();

    for (const row of parsed.items || []) {
      const id = Number(row.menu_item_id);
      const qty = Math.max(1, Math.min(20, parseInt(row.quantity, 10) || 1));
      if (!idSet.has(id)) continue;
      byId.set(id, (byId.get(id) || 0) + qty);
    }

    const items = [...byId.entries()].map(([menu_item_id, quantity]) => {
      const m = available.find((i) => Number(i.id) === menu_item_id);
      return {
        menu_item_id,
        quantity,
        name: m.name,
        price: parseFloat(m.price),
      };
    });

    return {
      ok: items.length > 0,
      items,
      unmatched: Array.isArray(parsed.unmatched) ? parsed.unmatched.filter(Boolean) : [],
      browse_menu: Boolean(parsed.browse_menu) && items.length === 0,
    };
  } catch (err) {
    console.error('[OpenAI] parseFoodOrder failed:', err.message);
    return parseFoodOrderFallback(message, available);
  }
}

function parseFoodOrderFallback(message, available) {
  const lower = (message || '').toLowerCase();

  // Explicit not-on-menu phrases (before alias match)
  const notOnMenuHints = [];
  if (/chick\s*burger|chicken\s*burger|burger/i.test(lower)) notOnMenuHints.push('chicken burger');
  if (/\bpizza\b/i.test(lower)) notOnMenuHints.push('pizza');
  if (/\bpasta\b/i.test(lower)) notOnMenuHints.push('pasta');
  if (/\bmomo/i.test(lower)) notOnMenuHints.push('momos');
  if (/\bnoodles?\b/i.test(lower)) notOnMenuHints.push('noodles');

  const aliases = [
    { re: /(?:(\d+|do|teen|ek|one|two|three)\s*(?:cup|cups|x)?\s*)?(?:masala\s*)?(?:chai|tea)/i, keys: ['chai', 'tea'] },
    { re: /(?:(\d+|do|teen|ek|one|two|three)\s*(?:cup|cups|x)?\s*)?(?:cold\s*)?coffee/i, keys: ['cold coffee', 'coffee'] },
    { re: /(?:(\d+|do|teen|ek|one|two|three)\s*(?:bottle|bottel|bottles|x)?\s*)?(?:pani|paani|water)(?:\s*ki)?(?:\s*bottle|\s*bottel)?/i, keys: ['water', 'mineral'] },
    { re: /(?:(\d+|do|teen|ek|one|two|three)\s*)?biryani/i, keys: ['biryani'] },
    { re: /(?:(\d+|do|teen|ek|one|two|three)\s*)?butter\s*chicken/i, keys: ['butter chicken'] },
    { re: /(?:(\d+|do|teen|ek|one|two|three)\s*)?paneer/i, keys: ['paneer'] },
    { re: /(?:(\d+|do|teen|ek|one|two|three)\s*)?dal/i, keys: ['dal'] },
    { re: /(?:(\d+|do|teen|ek|one|two|three)\s*)?(?:lime|soda)/i, keys: ['lime', 'soda'] },
    { re: /(?:(\d+|do|teen|ek|one|two|three)\s*)?fries/i, keys: ['fries'] },
    { re: /(?:(\d+|do|teen|ek|one|two|three)\s*)?sandwich/i, keys: ['sandwich'] },
    { re: /(?:(\d+|do|teen|ek|one|two|three)\s*)?gulab/i, keys: ['gulab'] },
    { re: /(?:(\d+|do|teen|ek|one|two|three)\s*)?ice\s*cream/i, keys: ['ice cream'] },
  ];

  const qtyWord = { ek: 1, one: 1, do: 2, two: 2, teen: 3, three: 3 };
  const byId = new Map();

  for (const alias of aliases) {
    const m = lower.match(alias.re);
    if (!m) continue;
    let quantity = 1;
    if (m[1]) {
      const q = m[1].toLowerCase();
      quantity = qtyWord[q] || parseInt(q, 10) || 1;
    }
    const match = available.find((i) => {
      const n = i.name.toLowerCase();
      return alias.keys.some((k) => n.includes(k));
    });
    if (!match) continue;
    const id = Number(match.id);
    byId.set(id, (byId.get(id) || 0) + quantity);
  }

  const items = [...byId.entries()].map(([menu_item_id, quantity]) => {
    const menu = available.find((i) => Number(i.id) === menu_item_id);
    return {
      menu_item_id,
      quantity,
      name: menu.name,
      price: parseFloat(menu.price),
    };
  });

  if (items.length || notOnMenuHints.length) {
    return {
      ok: items.length > 0,
      items,
      unmatched: notOnMenuHints,
      browse_menu: false,
    };
  }

  if (/menu|khana|food|order/i.test(lower)) {
    return { ok: false, items: [], unmatched: [], browse_menu: true };
  }

  // Generic food-like request with no alias → treat whole message as unmatched
  if (/bhej|order|chahiye|do\b|please|cup|plate/i.test(lower)) {
    return { ok: false, items: [], unmatched: [message.trim()], browse_menu: false };
  }

  return { ok: false, items: [], unmatched: [message], browse_menu: false };
}

module.exports = {
  detectIntent,
  matchFaq,
  fallbackIntent,
  answerHotelQuestion,
  phraseStatusUpdate,
  parseFoodOrder,
  OFF_TOPIC_REPLY,
};
