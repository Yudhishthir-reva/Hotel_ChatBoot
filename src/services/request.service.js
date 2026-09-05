const { nextRef } = require('../utils/ref');
const requestRepo = require('../repositories/request.repository');

const REF_PREFIX = {
  valet: 'V',
  housekeeping: 'HK',
  maintenance: 'M',
  checkout: 'CO',
  late_checkout: 'CO',
  other: 'R',
};

async function createRequest(bookingId, type, data = {}) {
  const prefix = REF_PREFIX[type] || 'R';
  const requestRef = await nextRef('request', `${prefix}-`);
  return requestRepo.create({
    request_ref: requestRef,
    booking_id: bookingId,
    type,
    sub_type: data.sub_type,
    description: data.description,
    priority: data.priority || 'medium',
  });
}

async function updateStatus(requestId, status, adminNotes) {
  return requestRepo.updateStatus(requestId, status, adminNotes);
}

const STATUS_MESSAGES = {
  accepted: 'Your request has been accepted.',
  in_progress: 'Your request is being processed.',
  done: 'Your request has been completed. Is there anything else I can help with?',
  rejected: 'Sorry, your request could not be fulfilled. Please contact the front desk.',
};

const TYPE_DONE_MESSAGES = {
  maintenance: 'Your maintenance request has been completed. Is there anything else I can help with?',
  housekeeping: 'Your housekeeping request has been completed.',
  valet: 'Your valet request has been completed.',
  checkout: 'Checkout has been processed. Thank you for staying with us!',
};

function getStatusMessage(type, status) {
  if (status === 'done' && TYPE_DONE_MESSAGES[type]) {
    return TYPE_DONE_MESSAGES[type];
  }
  return STATUS_MESSAGES[status] || null;
}

module.exports = { createRequest, updateStatus, getStatusMessage };
