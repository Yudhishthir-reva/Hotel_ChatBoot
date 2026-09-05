const db = require('../config/db');

async function findActiveByPhone(phone) {
  const normalized = phone.replace(/\D/g, '').slice(-10);
  const [rows] = await db.query(
    `SELECT b.*, r.room_number, h.name AS hotel_name
     FROM tbl_booking b
     JOIN tbl_room r ON r.id = b.room_id
     JOIN tbl_hotel h ON h.id = b.hotel_id
     WHERE b.status = 'checked_in'
       AND (b.guest_phone LIKE ? OR b.guest_phone LIKE ? OR b.guest_phone LIKE ?)
     ORDER BY b.check_in_date DESC
     LIMIT 1`,
    [`%${normalized}`, `%91${normalized}`, phone]
  );
  return rows[0] || null;
}

async function findById(id) {
  const [rows] = await db.query(
    `SELECT b.*, r.room_number, h.name AS hotel_name
     FROM tbl_booking b
     JOIN tbl_room r ON r.id = b.room_id
     JOIN tbl_hotel h ON h.id = b.hotel_id
     WHERE b.id = ?`,
    [id]
  );
  return rows[0] || null;
}

async function findAll(filters = {}) {
  let sql = `SELECT b.*, r.room_number
             FROM tbl_booking b
             JOIN tbl_room r ON r.id = b.room_id
             WHERE 1=1`;
  const params = [];

  if (filters.status) {
    sql += ' AND b.status = ?';
    params.push(filters.status);
  }
  if (filters.hotel_id) {
    sql += ' AND b.hotel_id = ?';
    params.push(filters.hotel_id);
  }

  sql += ' ORDER BY b.created_at DESC';
  const [rows] = await db.query(sql, params);
  return rows;
}

async function create(data) {
  const [result] = await db.query(
    `INSERT INTO tbl_booking (hotel_id, room_id, guest_name, guest_phone, booking_ref, check_in_date, check_out_date, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.hotel_id, data.room_id, data.guest_name, data.guest_phone, data.booking_ref,
     data.check_in_date, data.check_out_date, data.status || 'booked']
  );
  return findById(result.insertId);
}

async function update(id, data) {
  const fields = [];
  const params = [];
  for (const key of ['guest_name', 'guest_phone', 'room_id', 'check_in_date', 'check_out_date', 'status']) {
    if (data[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(data[key]);
    }
  }
  if (!fields.length) return findById(id);
  params.push(id);
  await db.query(`UPDATE tbl_booking SET ${fields.join(', ')} WHERE id = ?`, params);
  return findById(id);
}

async function countActive(hotelId) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS count FROM tbl_booking WHERE status = 'checked_in' AND hotel_id = ?`,
    [hotelId]
  );
  return rows[0].count;
}

module.exports = { findActiveByPhone, findById, findAll, create, update, countActive };
