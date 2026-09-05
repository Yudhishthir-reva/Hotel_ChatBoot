const { error } = require('../utils/response');

function errorHandler(err, req, res, _next) {
  console.error('[Error]', err.message);

  const status = err.status || 500;
  const message = status === 500
    ? (process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message)
    : err.message;

  if (req.path.startsWith('/api/') || req.path.startsWith('/webhook')) {
    return error(res, message, status);
  }

  res.status(status).send(`<pre>${message}</pre>`);
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { errorHandler, asyncHandler };
