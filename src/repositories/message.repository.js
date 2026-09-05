const db = require('../config/db');

async function log(data) {
  await db.query(
    `INSERT INTO tbl_message_log (guest_phone, booking_id, direction, message_type, content, wa_message_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      data.guest_phone,
      data.booking_id || null,
      data.direction,
      data.message_type || 'text',
      data.content,
      data.wa_message_id || null,
      data.metadata ? JSON.stringify(data.metadata) : null,
    ]
  );
}

async function findByPhone(phone, limit = 50) {
  const [rows] = await db.query(
    `SELECT * FROM tbl_message_log WHERE guest_phone = ? ORDER BY created_at DESC LIMIT ?`,
    [phone, limit]
  );
  return rows.reverse();
}

async function findAll(filters = {}) {
  let sql = `SELECT m.*, b.guest_name, r.room_number
             FROM tbl_message_log m
             LEFT JOIN tbl_booking b ON b.id = m.booking_id
             LEFT JOIN tbl_room r ON r.id = b.room_id
             WHERE 1=1`;
  const params = [];

  if (filters.guest_phone) {
    sql += ' AND m.guest_phone = ?';
    params.push(filters.guest_phone);
  }

  sql += ' ORDER BY m.created_at DESC LIMIT 200';
  const [rows] = await db.query(sql, params);
  return rows;
}

async function getConversations(hotelId) {
  const [rows] = await db.query(
    `SELECT m.guest_phone,
            MAX(m.created_at) AS last_message_at,
            b.guest_name,
            r.room_number,
            b.id AS booking_id,
            (SELECT content FROM tbl_message_log m2
             WHERE m2.guest_phone = m.guest_phone
             ORDER BY m2.created_at DESC LIMIT 1) AS last_message
     FROM tbl_message_log m
     LEFT JOIN tbl_booking b ON b.id = m.booking_id AND b.status = 'checked_in'
     LEFT JOIN tbl_room r ON r.id = b.room_id
     GROUP BY m.guest_phone, b.guest_name, r.room_number, b.id
     ORDER BY last_message_at DESC`,
    []
  );
  return rows;
}

module.exports = { log, findByPhone, findAll, getConversations };
