const db = require('../config/db');

async function getSession(phone) {
  const [rows] = await db.query('SELECT * FROM tbl_guest_session WHERE guest_phone = ?', [phone]);
  return rows[0] || null;
}

async function upsertSession(phone, data) {
  const existing = await getSession(phone);
  const sessionData = data.session_data !== undefined
    ? JSON.stringify(data.session_data)
    : undefined;

  if (existing) {
    const fields = [];
    const params = [];
    if (data.booking_id !== undefined) { fields.push('booking_id = ?'); params.push(data.booking_id); }
    if (data.current_state !== undefined) { fields.push('current_state = ?'); params.push(data.current_state); }
    if (sessionData !== undefined) { fields.push('session_data = ?'); params.push(sessionData); }
    fields.push('last_message_at = NOW()');
    params.push(phone);
    await db.query(`UPDATE tbl_guest_session SET ${fields.join(', ')} WHERE guest_phone = ?`, params);
  } else {
    await db.query(
      'INSERT INTO tbl_guest_session (guest_phone, booking_id, current_state, session_data) VALUES (?, ?, ?, ?)',
      [phone, data.booking_id || null, data.current_state || 'idle', sessionData || null]
    );
  }
  return getSession(phone);
}

async function clearSession(phone) {
  await db.query(
    `UPDATE tbl_guest_session SET current_state = 'idle', session_data = NULL, last_message_at = NOW()
     WHERE guest_phone = ?`,
    [phone]
  );
}

module.exports = { getSession, upsertSession, clearSession };
