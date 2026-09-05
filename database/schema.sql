-- Hotel WhatsApp CRM — Complete Database Schema
-- Run: mysql -u root -p < database/schema.sql

CREATE DATABASE IF NOT EXISTS hotel_whatsapp_crm
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE hotel_whatsapp_crm;

-- ─── Core Hotel ───────────────────────────────────────────────────────────────

CREATE TABLE tbl_hotel (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name                VARCHAR(255)   NOT NULL,
  whatsapp_number     VARCHAR(20)    DEFAULT NULL,
  address             TEXT           DEFAULT NULL,
  check_in_time       TIME           NOT NULL DEFAULT '14:00:00',
  check_out_time      TIME           NOT NULL DEFAULT '11:00:00',
  late_checkout_policy TEXT          DEFAULT NULL,
  wifi_password       VARCHAR(100)   DEFAULT NULL,
  created_at          TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE tbl_room (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  hotel_id    INT UNSIGNED   NOT NULL,
  room_number VARCHAR(10)    NOT NULL,
  floor       TINYINT UNSIGNED DEFAULT NULL,
  room_type   VARCHAR(50)    DEFAULT 'standard',
  status      ENUM('available','occupied','maintenance') NOT NULL DEFAULT 'available',
  created_at  TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_room_hotel FOREIGN KEY (hotel_id) REFERENCES tbl_hotel(id) ON DELETE CASCADE,
  UNIQUE KEY uq_hotel_room (hotel_id, room_number)
) ENGINE=InnoDB;

CREATE TABLE tbl_booking (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  hotel_id       INT UNSIGNED   NOT NULL,
  room_id        INT UNSIGNED   NOT NULL,
  guest_name     VARCHAR(255)   NOT NULL,
  guest_phone    VARCHAR(20)    NOT NULL,
  booking_ref    VARCHAR(20)    NOT NULL,
  check_in_date  DATE           NOT NULL,
  check_out_date DATE           NOT NULL,
  status         ENUM('booked','checked_in','checked_out','cancelled') NOT NULL DEFAULT 'booked',
  created_at     TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_booking_hotel FOREIGN KEY (hotel_id) REFERENCES tbl_hotel(id) ON DELETE CASCADE,
  CONSTRAINT fk_booking_room  FOREIGN KEY (room_id)  REFERENCES tbl_room(id)  ON DELETE RESTRICT,
  UNIQUE KEY uq_booking_ref (booking_ref),
  INDEX idx_guest_phone (guest_phone),
  INDEX idx_status_dates (status, check_in_date, check_out_date)
) ENGINE=InnoDB;

-- ─── Food Menu ────────────────────────────────────────────────────────────────

CREATE TABLE tbl_menu_category (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  hotel_id   INT UNSIGNED   NOT NULL,
  name       VARCHAR(100)   NOT NULL,
  meal_type  ENUM('breakfast','lunch','dinner','snacks','drinks','desserts') NOT NULL,
  sort_order INT            NOT NULL DEFAULT 0,
  is_active  TINYINT(1)     NOT NULL DEFAULT 1,
  created_at TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_category_hotel FOREIGN KEY (hotel_id) REFERENCES tbl_hotel(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE tbl_menu_item (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  category_id  INT UNSIGNED   NOT NULL,
  name         VARCHAR(255)   NOT NULL,
  description  TEXT           DEFAULT NULL,
  image_url    VARCHAR(500)   DEFAULT NULL,
  price        DECIMAL(10,2)  NOT NULL,
  is_available TINYINT(1)     NOT NULL DEFAULT 1,
  sort_order   INT            NOT NULL DEFAULT 0,
  created_at   TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_item_category FOREIGN KEY (category_id) REFERENCES tbl_menu_category(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─── Orders ─────────────────────────────────────────────────────────────────

CREATE TABLE tbl_order (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_ref    VARCHAR(20)    NOT NULL,
  booking_id   INT UNSIGNED   NOT NULL,
  status       ENUM('pending','accepted','preparing','out_for_delivery','delivered','rejected','cancelled') NOT NULL DEFAULT 'pending',
  total_amount DECIMAL(10,2)  NOT NULL DEFAULT 0.00,
  notes        TEXT           DEFAULT NULL,
  created_at   TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_order_booking FOREIGN KEY (booking_id) REFERENCES tbl_booking(id) ON DELETE CASCADE,
  UNIQUE KEY uq_order_ref (order_ref),
  INDEX idx_order_status (status)
) ENGINE=InnoDB;

CREATE TABLE tbl_order_item (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id     INT UNSIGNED   NOT NULL,
  menu_item_id INT UNSIGNED   NOT NULL,
  item_name    VARCHAR(255)   NOT NULL,
  quantity     INT UNSIGNED   NOT NULL DEFAULT 1,
  unit_price   DECIMAL(10,2)  NOT NULL,
  subtotal     DECIMAL(10,2)  NOT NULL,
  CONSTRAINT fk_orderitem_order FOREIGN KEY (order_id)     REFERENCES tbl_order(id)     ON DELETE CASCADE,
  CONSTRAINT fk_orderitem_item  FOREIGN KEY (menu_item_id) REFERENCES tbl_menu_item(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ─── Service Requests ─────────────────────────────────────────────────────────

CREATE TABLE tbl_request (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_ref  VARCHAR(20)    NOT NULL,
  booking_id   INT UNSIGNED   NOT NULL,
  type         ENUM('valet','housekeeping','maintenance','checkout','late_checkout','other') NOT NULL,
  sub_type     VARCHAR(100)   DEFAULT NULL,
  description  TEXT           DEFAULT NULL,
  priority     ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
  status       ENUM('pending','accepted','in_progress','done','rejected') NOT NULL DEFAULT 'pending',
  admin_notes  TEXT           DEFAULT NULL,
  created_at   TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_request_booking FOREIGN KEY (booking_id) REFERENCES tbl_booking(id) ON DELETE CASCADE,
  UNIQUE KEY uq_request_ref (request_ref),
  INDEX idx_request_status (status),
  INDEX idx_request_type (type)
) ENGINE=InnoDB;

-- ─── Guest Session (WhatsApp conversation state) ─────────────────────────────

CREATE TABLE tbl_guest_session (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  guest_phone     VARCHAR(20)    NOT NULL,
  booking_id      INT UNSIGNED   DEFAULT NULL,
  current_state   VARCHAR(50)    NOT NULL DEFAULT 'idle',
  session_data    JSON           DEFAULT NULL,
  last_message_at TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at      TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_session_booking FOREIGN KEY (booking_id) REFERENCES tbl_booking(id) ON DELETE SET NULL,
  UNIQUE KEY uq_guest_phone (guest_phone)
) ENGINE=InnoDB;

-- ─── FAQ ──────────────────────────────────────────────────────────────────────

CREATE TABLE tbl_faq (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  hotel_id   INT UNSIGNED   NOT NULL,
  question   VARCHAR(500)   NOT NULL,
  answer     TEXT           NOT NULL,
  keywords   VARCHAR(500)   DEFAULT NULL,
  is_active  TINYINT(1)     NOT NULL DEFAULT 1,
  sort_order INT            NOT NULL DEFAULT 0,
  created_at TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_faq_hotel FOREIGN KEY (hotel_id) REFERENCES tbl_hotel(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─── Message Log ──────────────────────────────────────────────────────────────

CREATE TABLE tbl_message_log (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  guest_phone   VARCHAR(20)    NOT NULL,
  booking_id    INT UNSIGNED   DEFAULT NULL,
  direction     ENUM('inbound','outbound') NOT NULL,
  message_type  ENUM('text','interactive','button','list','system') NOT NULL DEFAULT 'text',
  content       TEXT           NOT NULL,
  wa_message_id VARCHAR(100)   DEFAULT NULL,
  metadata      JSON           DEFAULT NULL,
  created_at    TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_msglog_booking FOREIGN KEY (booking_id) REFERENCES tbl_booking(id) ON DELETE SET NULL,
  INDEX idx_msglog_phone (guest_phone),
  INDEX idx_msglog_created (created_at)
) ENGINE=InnoDB;

-- ─── Admin ────────────────────────────────────────────────────────────────────

CREATE TABLE tbl_admin (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  hotel_id      INT UNSIGNED   NOT NULL,
  email         VARCHAR(255)   NOT NULL,
  password_hash VARCHAR(255)   NOT NULL,
  name          VARCHAR(255)   NOT NULL,
  is_active     TINYINT(1)     NOT NULL DEFAULT 1,
  created_at    TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_admin_hotel FOREIGN KEY (hotel_id) REFERENCES tbl_hotel(id) ON DELETE CASCADE,
  UNIQUE KEY uq_admin_email (email)
) ENGINE=InnoDB;

-- ─── Counters (for generating ORD/M/HK/V/CO refs) ───────────────────────────

CREATE TABLE tbl_counter (
  name       VARCHAR(30)    NOT NULL PRIMARY KEY,
  value      INT UNSIGNED   NOT NULL DEFAULT 1000
) ENGINE=InnoDB;

INSERT INTO tbl_counter (name, value) VALUES
  ('order',   1024),
  ('request', 1024);

-- ═══════════════════════════════════════════════════════════════════════════════
-- SEED DATA — Demo hotel for local testing
-- Admin password: admin123  (bcrypt hash generated at runtime by seed script,
--                              or use the hash below)
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO tbl_hotel (id, name, whatsapp_number, address, check_in_time, check_out_time, late_checkout_policy, wifi_password)
VALUES (1, 'XYZ Hotel', '919876543210', '123 MG Road, Mumbai', '14:00:00', '11:00:00',
        'Late checkout until 2 PM subject to availability and ₹500 charge.', 'XYZGuest2026');

INSERT INTO tbl_room (hotel_id, room_number, floor, room_type, status) VALUES
  (1, '101', 1, 'standard',  'available'),
  (1, '105', 1, 'deluxe',    'occupied'),
  (1, '204', 2, 'deluxe',    'occupied'),
  (1, '210', 2, 'suite',     'occupied'),
  (1, '302', 3, 'suite',     'occupied');

INSERT INTO tbl_booking (hotel_id, room_id, guest_name, guest_phone, booking_ref, check_in_date, check_out_date, status) VALUES
  (1, 3, 'Rahul Sharma',  '919871234567', 'BK1024', '2026-09-02', '2026-09-04', 'checked_in'),
  (1, 2, 'Amit Patel',    '919876543210', 'BK1025', '2026-09-01', '2026-09-03', 'checked_in'),
  (1, 4, 'Neha Gupta',    '919765432109', 'BK1026', '2026-09-02', '2026-09-05', 'checked_in'),
  (1, 5, 'Priya Singh',   '919654321098', 'BK1027', '2026-09-03', '2026-09-06', 'booked');

-- Admin: admin@xyzhotel.com / admin123
-- bcrypt hash for 'admin123' (cost 10)
INSERT INTO tbl_admin (hotel_id, email, password_hash, name) VALUES
  (1, 'admin@xyzhotel.com', '$2b$10$0PHPEiGIKrO2et6EiHh6JufCMmobB93TK3sErd1D7a4UwADuxqjMi', 'Hotel Admin');

-- Menu categories
INSERT INTO tbl_menu_category (hotel_id, name, meal_type, sort_order) VALUES
  (1, 'Starters',    'dinner', 1),
  (1, 'Main Course', 'dinner', 2),
  (1, 'Drinks',      'dinner', 3),
  (1, 'Desserts',    'dinner', 4),
  (1, 'Breakfast',   'breakfast', 1),
  (1, 'Snacks',      'snacks', 1);

-- Menu items (dinner)
INSERT INTO tbl_menu_item (category_id, name, price, sort_order) VALUES
  (1, 'Paneer Tikka',    300.00, 1),
  (1, 'Chicken Wings',   350.00, 2),
  (1, 'Veg Spring Roll', 250.00, 3),
  (2, 'Chicken Biryani', 350.00, 1),
  (2, 'Butter Chicken',  420.00, 2),
  (2, 'Paneer Tikka',    300.00, 3),
  (2, 'Dal Makhani',     250.00, 4),
  (3, 'Fresh Lime Soda',  80.00, 1),
  (3, 'Masala Chai',      60.00, 2),
  (3, 'Cold Coffee',     120.00, 3),
  (3, 'Mineral Water Bottle', 40.00, 4),
  (4, 'Gulab Jamun',     150.00, 1),
  (4, 'Ice Cream',       180.00, 2);

-- Breakfast items
INSERT INTO tbl_menu_item (category_id, name, price, sort_order) VALUES
  (5, 'Continental Breakfast', 450.00, 1),
  (5, 'Indian Breakfast',      350.00, 2),
  (5, 'Fresh Fruit Platter',   200.00, 3);

-- Snacks
INSERT INTO tbl_menu_item (category_id, name, price, sort_order) VALUES
  (6, 'French Fries', 180.00, 1),
  (6, 'Sandwich',     220.00, 2);

-- FAQs
INSERT INTO tbl_faq (hotel_id, question, answer, keywords, sort_order) VALUES
  (1, 'What is the breakfast timing?', 'Breakfast is served from 7:00 AM to 10:30 AM at the restaurant on the ground floor.', 'breakfast timing time morning', 1),
  (1, 'What is the buffet timing?', 'Buffet breakfast: 7-10:30 AM | Lunch buffet: 12:30-3 PM | Dinner buffet: 7:30-10:30 PM.', 'buffet timing lunch dinner', 2),
  (1, 'When is the pool open?', 'The swimming pool is open from 6:00 AM to 8:00 PM daily.', 'pool swimming timing open', 3),
  (1, 'What is the WiFi password?', 'WiFi Network: XYZ-Guest | Password: XYZGuest2026', 'wifi password internet network', 4),
  (1, 'What are the spa timings?', 'Spa is open from 9:00 AM to 9:00 PM. Please book at the front desk or via WhatsApp.', 'spa timing massage wellness', 5),
  (1, 'What is the check-in time?', 'Standard check-in time is 2:00 PM. Early check-in subject to availability.', 'checkin check in time arrival', 6),
  (1, 'What is the check-out time?', 'Standard check-out time is 11:00 AM. Late checkout available on request.', 'checkout check out time departure', 7);
