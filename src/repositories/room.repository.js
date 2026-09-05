const db = require('../config/db');

async function findAll(hotelId) {
  const [rows] = await db.query(
    `SELECT r.*, b.guest_name, b.guest_phone, b.status AS booking_status
     FROM tbl_room r
     LEFT JOIN tbl_booking b ON b.room_id = r.id AND b.status = 'checked_in'
     WHERE r.hotel_id = ?
     ORDER BY r.room_number`,
    [hotelId]
  );
  return rows;
}

async function findById(id) {
  const [rows] = await db.query('SELECT * FROM tbl_room WHERE id = ?', [id]);
  return rows[0] || null;
}

async function create(data) {
  const [result] = await db.query(
    'INSERT INTO tbl_room (hotel_id, room_number, floor, room_type, status) VALUES (?, ?, ?, ?, ?)',
    [data.hotel_id, data.room_number, data.floor, data.room_type || 'standard', data.status || 'available']
  );
  return findById(result.insertId);
}

async function update(id, data) {
  const fields = [];
  const params = [];
  for (const key of ['room_number', 'floor', 'room_type', 'status']) {
    if (data[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(data[key]);
    }
  }
  if (!fields.length) return findById(id);
  params.push(id);
  await db.query(`UPDATE tbl_room SET ${fields.join(', ')} WHERE id = ?`, params);
  return findById(id);
}

module.exports = { findAll, findById, create, update };
