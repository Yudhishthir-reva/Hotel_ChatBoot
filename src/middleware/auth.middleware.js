const jwt = require('jsonwebtoken');
const adminRepo = require('../repositories/admin.repository');
const { error } = require('../utils/response');

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return error(res, 'Unauthorized', 401);
  }

  try {
    const token = header.slice(7);
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
    const admin = await adminRepo.findById(payload.id);
    if (!admin) return error(res, 'Unauthorized', 401);
    req.admin = admin;
    next();
  } catch {
    return error(res, 'Invalid token', 401);
  }
}

module.exports = authMiddleware;
