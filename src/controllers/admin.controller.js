const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const adminRepo = require('../repositories/admin.repository');
const bookingRepo = require('../repositories/booking.repository');
const roomRepo = require('../repositories/room.repository');
const orderRepo = require('../repositories/order.repository');
const requestRepo = require('../repositories/request.repository');
const menuRepo = require('../repositories/menu.repository');
const faqRepo = require('../repositories/faq.repository');
const messageRepo = require('../repositories/message.repository');
const orderService = require('../services/order.service');
const requestService = require('../services/request.service');
const whatsapp = require('../services/whatsapp.service');
const templates = require('../services/template.service');
const { success, error } = require('../utils/response');
const { normalizeWhatsAppPhone } = require('../utils/phone');

const HOTEL_ID = parseInt(process.env.DEFAULT_HOTEL_ID || '1', 10);

async function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) return error(res, 'Email and password required');

  const admin = await adminRepo.findByEmail(email);
  if (!admin) return error(res, 'Invalid credentials', 401);

  const valid = await bcrypt.compare(password, admin.password_hash);
  if (!valid) return error(res, 'Invalid credentials', 401);

  const token = jwt.sign(
    { id: admin.id, email: admin.email, hotel_id: admin.hotel_id },
    process.env.JWT_SECRET || 'dev_secret',
    { expiresIn: '24h' }
  );

  return success(res, {
    token,
    admin: { id: admin.id, email: admin.email, name: admin.name, hotel_id: admin.hotel_id, hotel_name: admin.hotel_name },
  });
}

async function me(req, res) {
  const admin = await adminRepo.findById(req.admin.id);
  return success(res, admin);
}

async function dashboard(req, res) {
  const [activeGuests, todayOrders, requestCounts, maintenance] = await Promise.all([
    bookingRepo.countActive(HOTEL_ID),
    orderRepo.countToday(HOTEL_ID),
    requestRepo.countByStatus(HOTEL_ID),
    requestRepo.countMaintenance(HOTEL_ID),
  ]);

  const statusMap = Object.fromEntries(requestCounts.map((r) => [r.status, r.count]));
  return success(res, {
    active_guests: activeGuests,
    today_orders: todayOrders,
    pending_requests: statusMap.pending || 0,
    completed_requests: statusMap.done || 0,
    maintenance_open: maintenance,
  });
}

async function getGuests(req, res) {
  const bookings = await bookingRepo.findAll({ hotel_id: HOTEL_ID, status: 'checked_in' });
  return success(res, bookings);
}

async function getBookings(req, res) {
  const bookings = await bookingRepo.findAll({ hotel_id: HOTEL_ID, status: req.query.status });
  return success(res, bookings);
}

async function createBooking(req, res) {
  const data = { ...req.body, hotel_id: HOTEL_ID };
  if (!data.booking_ref) data.booking_ref = `BK${Date.now().toString().slice(-6)}`;
  if (!data.guest_phone) return error(res, 'Guest phone is required');
  data.guest_phone = normalizeWhatsAppPhone(data.guest_phone);
  if (!data.guest_phone) return error(res, 'Invalid guest phone');
  const booking = await bookingRepo.create(data);
  return success(res, booking, 201);
}

async function updateBooking(req, res) {
  const data = { ...req.body };
  if (data.guest_phone !== undefined) {
    data.guest_phone = normalizeWhatsAppPhone(data.guest_phone);
    if (!data.guest_phone) return error(res, 'Invalid guest phone');
  }
  const booking = await bookingRepo.update(req.params.id, data);
  return success(res, booking);
}

async function getRooms(req, res) {
  const rooms = await roomRepo.findAll(HOTEL_ID);
  return success(res, rooms);
}

async function createRoom(req, res) {
  const room = await roomRepo.create({ ...req.body, hotel_id: HOTEL_ID });
  return success(res, room, 201);
}

async function updateRoom(req, res) {
  const room = await roomRepo.update(req.params.id, req.body);
  return success(res, room);
}

async function getOrders(req, res) {
  const orders = await orderRepo.findAll({ status: req.query.status });
  return success(res, orders);
}

async function updateOrderStatus(req, res) {
  const { status } = req.body;
  const valid = ['accepted', 'preparing', 'out_for_delivery', 'delivered', 'rejected'];
  if (!valid.includes(status)) return error(res, 'Invalid status');

  const order = await orderService.updateStatus(req.params.id, status);
  const msg = orderService.getStatusMessage(status);

  if (msg && order.guest_phone) {
    try {
      await whatsapp.sendTextOrTemplate(
        order.guest_phone,
        `Order #${order.order_ref} | Room ${order.room_number || ''}\n\n${msg}`,
        order.booking_id,
        {
          name: templates.NAMES.orderStatus,
          params: [order.order_ref, order.room_number || '-', msg],
        }
      );
    } catch (e) {
      console.error('[Admin] WhatsApp notify failed:', e.message);
    }
  }

  return success(res, order);
}

async function getRequests(req, res) {
  const requests = await requestRepo.findAll({ status: req.query.status, type: req.query.type });
  return success(res, requests);
}

async function updateRequestStatus(req, res) {
  const { status, admin_notes } = req.body;
  const valid = ['accepted', 'in_progress', 'done', 'rejected'];
  if (!valid.includes(status)) return error(res, 'Invalid status');

  const request = await requestService.updateStatus(req.params.id, status, admin_notes);
  const msg = requestService.getStatusMessage(request.type, status);

  if (msg && request.guest_phone) {
    try {
      await whatsapp.sendTextOrTemplate(
        request.guest_phone,
        `Request ${request.request_ref}: ${msg}`,
        request.booking_id,
        {
          name: templates.NAMES.requestStatus,
          params: [request.request_ref, msg],
        }
      );
    } catch (e) {
      console.error('[Admin] WhatsApp notify failed:', e.message);
    }
  }

  return success(res, request);
}

async function getMenu(req, res) {
  const [categories, items] = await Promise.all([
    menuRepo.findAllCategories(HOTEL_ID),
    menuRepo.findAllItems(HOTEL_ID),
  ]);
  return success(res, { categories, items });
}

async function createMenuCategory(req, res) {
  const cat = await menuRepo.createCategory({ ...req.body, hotel_id: HOTEL_ID });
  return success(res, cat, 201);
}

async function createMenuItem(req, res) {
  const item = await menuRepo.createItem(req.body);
  return success(res, item, 201);
}

async function updateMenuItem(req, res) {
  const item = await menuRepo.updateItem(req.params.id, req.body);
  return success(res, item);
}

async function updateMenuCategory(req, res) {
  const cat = await menuRepo.updateCategory(req.params.id, req.body);
  return success(res, cat);
}

async function getFaqs(req, res) {
  const faqs = await faqRepo.findAll(HOTEL_ID);
  return success(res, faqs);
}

async function createFaq(req, res) {
  const faq = await faqRepo.create({ ...req.body, hotel_id: HOTEL_ID });
  return success(res, faq, 201);
}

async function updateFaq(req, res) {
  const faq = await faqRepo.update(req.params.id, req.body);
  return success(res, faq);
}

async function deleteFaq(req, res) {
  await faqRepo.remove(req.params.id);
  return success(res, { deleted: true });
}

async function getConversations(req, res) {
  const conversations = await messageRepo.getConversations(HOTEL_ID);
  return success(res, conversations);
}

async function getConversationMessages(req, res) {
  const messages = await messageRepo.findByPhone(req.params.phone);
  return success(res, messages);
}

async function sendAdminMessage(req, res) {
  const { phone, message } = req.body;
  if (!phone || !message) return error(res, 'Phone and message required');

  const booking = await bookingRepo.findActiveByPhone(phone);
  await whatsapp.sendText(phone, message, booking?.id);
  return success(res, { sent: true });
}

module.exports = {
  login, me, dashboard,
  getGuests, getBookings, createBooking, updateBooking,
  getRooms, createRoom, updateRoom,
  getOrders, updateOrderStatus,
  getRequests, updateRequestStatus,
  getMenu, createMenuCategory, createMenuItem, updateMenuItem, updateMenuCategory,
  getFaqs, createFaq, updateFaq, deleteFaq,
  getConversations, getConversationMessages, sendAdminMessage,
};
