const db = require('../config/db');

async function findById(id) {
  const [rows] = await db.query(
    `SELECT req.*, b.guest_name, b.guest_phone, r.room_number
     FROM tbl_request req
     JOIN tbl_booking b ON b.id = req.booking_id
     JOIN tbl_room r ON r.id = b.room_id
     WHERE req.id = ?`,
    [id]
  );
  return rows[0] || null;
}

async function findByRef(requestRef) {
  const [rows] = await db.query('SELECT * FROM tbl_request WHERE request_ref = ?', [requestRef]);
  return rows[0] || null;
}

async function findAll(filters = {}) {
  let sql = `SELECT req.*, b.guest_name, b.guest_phone, r.room_number
             FROM tbl_request req
             JOIN tbl_booking b ON b.id = req.booking_id
             JOIN tbl_room r ON r.id = b.room_id
             WHERE 1=1`;
  const params = [];

  if (filters.status) {
    sql += ' AND req.status = ?';
    params.push(filters.status);
  }
  if (filters.type) {
    sql += ' AND req.type = ?';
    params.push(filters.type);
  }
  if (filters.booking_id) {
    sql += ' AND req.booking_id = ?';
    params.push(filters.booking_id);
  }

  sql += ' ORDER BY req.created_at DESC';
  const [rows] = await db.query(sql, params);
  return rows;
}

async function create(data) {
  const [result] = await db.query(
    `INSERT INTO tbl_request (request_ref, booking_id, type, sub_type, description, priority, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [data.request_ref, data.booking_id, data.type, data.sub_type || null,
     data.description || null, data.priority || 'medium', 'pending']
  );
  return findById(result.insertId);
}

async function updateStatus(id, status, adminNotes) {
  const params = [status];
  let sql = 'UPDATE tbl_request SET status = ?';
  if (adminNotes !== undefined) {
    sql += ', admin_notes = ?';
    params.push(adminNotes);
  }
  sql += ' WHERE id = ?';
  params.push(id);
  await db.query(sql, params);
  return findById(id);
}

async function countByStatus(hotelId) {
  const [rows] = await db.query(
    `SELECT req.status, COUNT(*) AS count
     FROM tbl_request req
     JOIN tbl_booking b ON b.id = req.booking_id
     WHERE b.hotel_id = ?
     GROUP BY req.status`,
    [hotelId]
  );
  return rows;
}

async function countMaintenance(hotelId) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS count FROM tbl_request req
     JOIN tbl_booking b ON b.id = req.booking_id
     WHERE b.hotel_id = ? AND req.type = 'maintenance' AND req.status NOT IN ('done','rejected')`,
    [hotelId]
  );
  return rows[0].count;
}

module.exports = { findById, findByRef, findAll, create, updateStatus, countByStatus, countMaintenance };
