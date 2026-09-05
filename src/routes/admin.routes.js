const express = require('express');
const adminController = require('../controllers/admin.controller');
const auth = require('../middleware/auth.middleware');
const { asyncHandler } = require('../middleware/error.middleware');

const router = express.Router();

router.post('/login', asyncHandler(adminController.login));
router.get('/me', auth, asyncHandler(adminController.me));
router.get('/dashboard', auth, asyncHandler(adminController.dashboard));

router.get('/guests', auth, asyncHandler(adminController.getGuests));
router.get('/bookings', auth, asyncHandler(adminController.getBookings));
router.post('/bookings', auth, asyncHandler(adminController.createBooking));
router.patch('/bookings/:id', auth, asyncHandler(adminController.updateBooking));

router.get('/rooms', auth, asyncHandler(adminController.getRooms));
router.post('/rooms', auth, asyncHandler(adminController.createRoom));
router.patch('/rooms/:id', auth, asyncHandler(adminController.updateRoom));

router.get('/orders', auth, asyncHandler(adminController.getOrders));
router.patch('/orders/:id/status', auth, asyncHandler(adminController.updateOrderStatus));

router.get('/requests', auth, asyncHandler(adminController.getRequests));
router.patch('/requests/:id/status', auth, asyncHandler(adminController.updateRequestStatus));

router.get('/menu', auth, asyncHandler(adminController.getMenu));
router.post('/menu/categories', auth, asyncHandler(adminController.createMenuCategory));
router.patch('/menu/categories/:id', auth, asyncHandler(adminController.updateMenuCategory));
router.post('/menu/items', auth, asyncHandler(adminController.createMenuItem));
router.patch('/menu/items/:id', auth, asyncHandler(adminController.updateMenuItem));

router.get('/faqs', auth, asyncHandler(adminController.getFaqs));
router.post('/faqs', auth, asyncHandler(adminController.createFaq));
router.patch('/faqs/:id', auth, asyncHandler(adminController.updateFaq));
router.delete('/faqs/:id', auth, asyncHandler(adminController.deleteFaq));

router.get('/conversations', auth, asyncHandler(adminController.getConversations));
router.get('/conversations/:phone', auth, asyncHandler(adminController.getConversationMessages));
router.post('/conversations/send', auth, asyncHandler(adminController.sendAdminMessage));

module.exports = router;
