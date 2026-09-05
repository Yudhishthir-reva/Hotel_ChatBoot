const db = require('../config/db');

async function getCategoriesByMealType(hotelId, mealType) {
  const [rows] = await db.query(
    `SELECT * FROM tbl_menu_category
     WHERE hotel_id = ? AND meal_type = ? AND is_active = 1
     ORDER BY sort_order`,
    [hotelId, mealType]
  );
  return rows;
}

async function getItemsByCategory(categoryId) {
  const [rows] = await db.query(
    `SELECT * FROM tbl_menu_item
     WHERE category_id = ? AND is_available = 1
     ORDER BY sort_order`,
    [categoryId]
  );
  return rows;
}

async function getItemById(id) {
  const [rows] = await db.query('SELECT * FROM tbl_menu_item WHERE id = ?', [id]);
  return rows[0] || null;
}

async function findAllCategories(hotelId) {
  const [rows] = await db.query(
    `SELECT c.*, COUNT(i.id) AS item_count
     FROM tbl_menu_category c
     LEFT JOIN tbl_menu_item i ON i.category_id = c.id
     WHERE c.hotel_id = ?
     GROUP BY c.id
     ORDER BY c.meal_type, c.sort_order`,
    [hotelId]
  );
  return rows;
}

async function findAllItems(hotelId) {
  const [rows] = await db.query(
    `SELECT i.*, c.name AS category_name, c.meal_type
     FROM tbl_menu_item i
     JOIN tbl_menu_category c ON c.id = i.category_id
     WHERE c.hotel_id = ?
     ORDER BY c.sort_order, i.sort_order`,
    [hotelId]
  );
  return rows;
}

async function createCategory(data) {
  const [result] = await db.query(
    'INSERT INTO tbl_menu_category (hotel_id, name, meal_type, sort_order, is_active) VALUES (?, ?, ?, ?, ?)',
    [data.hotel_id, data.name, data.meal_type, data.sort_order || 0, data.is_active ?? 1]
  );
  const [rows] = await db.query('SELECT * FROM tbl_menu_category WHERE id = ?', [result.insertId]);
  return rows[0];
}

async function createItem(data) {
  const [result] = await db.query(
    'INSERT INTO tbl_menu_item (category_id, name, description, image_url, price, is_available, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [data.category_id, data.name, data.description, data.image_url || null, data.price, data.is_available ?? 1, data.sort_order || 0]
  );
  return getItemById(result.insertId);
}

async function updateItem(id, data) {
  const fields = [];
  const params = [];
  for (const key of ['name', 'description', 'image_url', 'price', 'is_available', 'sort_order', 'category_id']) {
    if (data[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(data[key]);
    }
  }
  if (!fields.length) return getItemById(id);
  params.push(id);
  await db.query(`UPDATE tbl_menu_item SET ${fields.join(', ')} WHERE id = ?`, params);
  return getItemById(id);
}

async function updateCategory(id, data) {
  const fields = [];
  const params = [];
  for (const key of ['name', 'meal_type', 'sort_order', 'is_active']) {
    if (data[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(data[key]);
    }
  }
  if (!fields.length) return null;
  params.push(id);
  await db.query(`UPDATE tbl_menu_category SET ${fields.join(', ')} WHERE id = ?`, params);
  const [rows] = await db.query('SELECT * FROM tbl_menu_category WHERE id = ?', [id]);
  return rows[0];
}

module.exports = {
  getCategoriesByMealType, getItemsByCategory, getItemById,
  findAllCategories, findAllItems, createCategory, createItem, updateItem, updateCategory,
};
