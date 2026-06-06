require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const path = require('path');

const { generalLimiter } = require('./middleware/rateLimit');
const adminRoutes = require('./routes/admin');
const voteRoutes = require('./routes/vote');
const resultsRoutes = require('./routes/results');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security ───────────────────────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"]
    }
  }
}));

// ── Body Parsing ───────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Cookie & Session ───────────────────────────────────────────────────────

app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000 // 8 hours
  }
}));

// ── Rate Limiting ──────────────────────────────────────────────────────────

app.use(generalLimiter);

// ── Static Files ───────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

// ── Health Check ───────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Routes ─────────────────────────────────────────────────────────────────

app.use('/admin', adminRoutes);
app.use('/vote', voteRoutes);
app.use('/results', resultsRoutes);

// Root redirect
app.get('/', (req, res) => {
  res.redirect('/admin');
});

// ── 404 Handler ────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>404 – Not Found</title>
  <style>
    body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #f5f7fa; }
    .card { background: white; padding: 48px; border-radius: 12px; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
    h1 { font-size: 64px; color: #ecf0f1; margin-bottom: 8px; }
    p { color: #7f8c8d; margin-bottom: 20px; }
    a { color: #3498db; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>404</h1>
    <p>The page you are looking for does not exist.</p>
    <a href="/">Go home</a>
  </div>
</body>
</html>`);
});

// ── Error Handler ──────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  // CSRF token errors
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({ error: 'Invalid or expired form token. Please refresh the page and try again.' });
  }

  console.error('Unhandled error:', err);

  if (res.headersSent) return next(err);

  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred.'
      : (err.message || 'Internal Server Error')
  });
});

// ── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Election server running on http://0.0.0.0:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
