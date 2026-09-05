const db = require('../config/db');

async function findById(id) {
  const [rows] = await db.query('SELECT * FROM tbl_hotel WHERE id = ?', [id]);
  return rows[0] || null;
}

module.exports = { findById };
