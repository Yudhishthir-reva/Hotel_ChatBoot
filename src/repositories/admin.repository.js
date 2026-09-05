const db = require('../config/db');

async function findByEmail(email) {
  const [rows] = await db.query(
    'SELECT a.*, h.name AS hotel_name FROM tbl_admin a JOIN tbl_hotel h ON h.id = a.hotel_id WHERE a.email = ? AND a.is_active = 1',
    [email]
  );
  return rows[0] || null;
}

async function findById(id) {
  const [rows] = await db.query(
    'SELECT a.id, a.email, a.name, a.hotel_id, h.name AS hotel_name FROM tbl_admin a JOIN tbl_hotel h ON h.id = a.hotel_id WHERE a.id = ?',
    [id]
  );
  return rows[0] || null;
}

module.exports = { findByEmail, findById };
