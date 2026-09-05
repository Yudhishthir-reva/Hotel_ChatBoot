const db = require('../config/db');

async function findAll(hotelId) {
  const [rows] = await db.query(
    'SELECT * FROM tbl_faq WHERE hotel_id = ? ORDER BY sort_order',
    [hotelId]
  );
  return rows;
}

async function findActive(hotelId) {
  const [rows] = await db.query(
    'SELECT * FROM tbl_faq WHERE hotel_id = ? AND is_active = 1 ORDER BY sort_order',
    [hotelId]
  );
  return rows;
}

async function findById(id) {
  const [rows] = await db.query('SELECT * FROM tbl_faq WHERE id = ?', [id]);
  return rows[0] || null;
}

async function create(data) {
  const [result] = await db.query(
    'INSERT INTO tbl_faq (hotel_id, question, answer, keywords, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    [data.hotel_id, data.question, data.answer, data.keywords, data.is_active ?? 1, data.sort_order || 0]
  );
  return findById(result.insertId);
}

async function update(id, data) {
  const fields = [];
  const params = [];
  for (const key of ['question', 'answer', 'keywords', 'is_active', 'sort_order']) {
    if (data[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(data[key]);
    }
  }
  if (!fields.length) return findById(id);
  params.push(id);
  await db.query(`UPDATE tbl_faq SET ${fields.join(', ')} WHERE id = ?`, params);
  return findById(id);
}

async function remove(id) {
  await db.query('DELETE FROM tbl_faq WHERE id = ?', [id]);
}

module.exports = { findAll, findActive, findById, create, update, remove };
