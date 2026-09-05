const db = require('../config/db');

async function findById(id) {
  const [rows] = await db.query(
    `SELECT o.*, b.guest_name, b.guest_phone, r.room_number
     FROM tbl_order o
     JOIN tbl_booking b ON b.id = o.booking_id
     JOIN tbl_room r ON r.id = b.room_id
     WHERE o.id = ?`,
    [id]
  );
  if (!rows[0]) return null;
  const order = rows[0];
  order.items = await findItemsByOrderId(id);
  return order;
}

async function findByRef(orderRef) {
  const [rows] = await db.query('SELECT * FROM tbl_order WHERE order_ref = ?', [orderRef]);
  if (!rows[0]) return null;
  const order = rows[0];
  order.items = await findItemsByOrderId(order.id);
  return order;
}

async function findItemsByOrderId(orderId) {
  const [rows] = await db.query('SELECT * FROM tbl_order_item WHERE order_id = ?', [orderId]);
  return rows;
}

async function findAll(filters = {}) {
  let sql = `SELECT o.*, b.guest_name, b.guest_phone, r.room_number
             FROM tbl_order o
             JOIN tbl_booking b ON b.id = o.booking_id
             JOIN tbl_room r ON r.id = b.room_id
             WHERE 1=1`;
  const params = [];

  if (filters.status) {
    sql += ' AND o.status = ?';
    params.push(filters.status);
  }
  if (filters.booking_id) {
    sql += ' AND o.booking_id = ?';
    params.push(filters.booking_id);
  }

  sql += ' ORDER BY o.created_at DESC';
  const [rows] = await db.query(sql, params);

  for (const order of rows) {
    order.items = await findItemsByOrderId(order.id);
  }
  return rows;
}

async function create(orderRef, bookingId, items) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const total = items.reduce((sum, i) => sum + i.subtotal, 0);
    const [result] = await conn.query(
      'INSERT INTO tbl_order (order_ref, booking_id, total_amount, status) VALUES (?, ?, ?, ?)',
      [orderRef, bookingId, total, 'pending']
    );
    const orderId = result.insertId;
    for (const item of items) {
      await conn.query(
        'INSERT INTO tbl_order_item (order_id, menu_item_id, item_name, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?, ?)',
        [orderId, item.menu_item_id, item.item_name, item.quantity, item.unit_price, item.subtotal]
      );
    }
    await conn.commit();
    return findById(orderId);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function updateStatus(id, status) {
  await db.query('UPDATE tbl_order SET status = ? WHERE id = ?', [status, id]);
  return findById(id);
}

async function countToday(hotelId) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS count FROM tbl_order o
     JOIN tbl_booking b ON b.id = o.booking_id
     WHERE b.hotel_id = ? AND DATE(o.created_at) = CURDATE()`,
    [hotelId]
  );
  return rows[0].count;
}

module.exports = { findById, findByRef, findAll, create, updateStatus, countToday };
