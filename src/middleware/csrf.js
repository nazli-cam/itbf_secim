const csurf = require('csurf');

const csrfProtection = csurf({
  cookie: false,
  value: (req) =>
    req.headers['csrf-token'] ||      // ← frontend sends 'CSRF-Token'
    req.headers['x-csrf-token'] ||
    req.headers['xsrf-token'] ||
    req.headers['x-xsrf-token'] ||
    (req.body && req.body._csrf) ||   // ← HTML form hidden input
    (req.query && req.query._csrf) ||
    ''
});

function csrfToken(req, res, next) {
  res.locals.csrfToken = req.csrfToken();
  next();
}

module.exports = { csrfProtection, csrfToken };
