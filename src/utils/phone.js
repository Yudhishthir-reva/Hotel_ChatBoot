/**
 * Normalize Indian mobile numbers for WhatsApp Cloud API.
 * WhatsApp expects digits only with country code, e.g. 919660888489
 */
function normalizeWhatsAppPhone(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (!digits) return null;

  // Strip leading 0
  if (digits.startsWith('0')) digits = digits.slice(1);

  // 10-digit Indian mobile → add 91
  if (digits.length === 10) digits = `91${digits}`;

  // Already 12 digits starting with 91
  if (digits.length === 12 && digits.startsWith('91')) return digits;

  // 11+ with other country codes — return as-is if looks valid
  if (digits.length >= 11 && digits.length <= 15) return digits;

  return digits;
}

module.exports = { normalizeWhatsAppPhone };
