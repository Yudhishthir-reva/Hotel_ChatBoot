const db = require('../config/db');

async function nextRef(counterName, prefix) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      'SELECT value FROM tbl_counter WHERE name = ? FOR UPDATE',
      [counterName]
    );
    const next = (rows[0]?.value || 1000) + 1;
    await conn.query('UPDATE tbl_counter SET value = ? WHERE name = ?', [next, counterName]);
    await conn.commit();
    return `${prefix}${next}`;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { nextRef };
