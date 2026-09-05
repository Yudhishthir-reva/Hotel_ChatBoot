const { nextRef } = require('../utils/ref');
const orderRepo = require('../repositories/order.repository');
const menuRepo = require('../repositories/menu.repository');

async function createOrder(bookingId, cartItems) {
  const orderRef = await nextRef('order', 'ORD');
  const items = [];

  for (const cartItem of cartItems) {
    const menuItem = await menuRepo.getItemById(cartItem.menu_item_id);
    if (!menuItem || !menuItem.is_available) {
      throw new Error(`Item ${cartItem.menu_item_id} is not available`);
    }
    items.push({
      menu_item_id: menuItem.id,
      item_name: menuItem.name,
      quantity: cartItem.quantity,
      unit_price: parseFloat(menuItem.price),
      subtotal: parseFloat(menuItem.price) * cartItem.quantity,
    });
  }

  return orderRepo.create(orderRef, bookingId, items);
}

async function updateStatus(orderId, status) {
  return orderRepo.updateStatus(orderId, status);
}

const STATUS_MESSAGES = {
  accepted: '✅ Order received by kitchen.\nWe have started processing your order.',
  preparing: '👨‍🍳 Order is being prepared.\nYour food will be ready soon.',
  out_for_delivery: '🚪 Your order is on the way!\nStaff is coming to your room.',
  delivered: '🍽️ Enjoy your meal!\nThank you for ordering with us.',
  rejected: '❌ Sorry, your order could not be fulfilled.\nPlease contact the front desk.',
};

function getStatusMessage(status) {
  return STATUS_MESSAGES[status] || null;
}

module.exports = { createOrder, updateStatus, getStatusMessage };
