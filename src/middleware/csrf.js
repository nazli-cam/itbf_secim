const csurf = require('csurf');

const csrfProtection = csurf({ cookie: false });

function csrfToken(req, res, next) {
  res.locals.csrfToken = req.csrfToken();
  next();
}

module.exports = { csrfProtection, csrfToken };
