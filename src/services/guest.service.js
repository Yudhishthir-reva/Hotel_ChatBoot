const bookingRepo = require('../repositories/booking.repository');
const sessionRepo = require('../repositories/session.repository');

async function authenticateGuest(phone) {
  const booking = await bookingRepo.findActiveByPhone(phone);
  return booking;
}

async function getOrCreateSession(phone) {
  let session = await sessionRepo.getSession(phone);
  if (!session) {
    session = await sessionRepo.upsertSession(phone, { current_state: 'idle' });
  }
  return session;
}

function parseSessionData(session) {
  if (!session?.session_data) return {};
  if (typeof session.session_data === 'object') return session.session_data;
  try {
    return JSON.parse(session.session_data);
  } catch {
    return {};
  }
}

async function updateSession(phone, state, data = {}, bookingId) {
  const update = { current_state: state, session_data: data };
  if (bookingId !== undefined) update.booking_id = bookingId;
  return sessionRepo.upsertSession(phone, update);
}

async function resetSession(phone) {
  return sessionRepo.clearSession(phone);
}

module.exports = {
  authenticateGuest,
  getOrCreateSession,
  parseSessionData,
  updateSession,
  resetSession,
};
