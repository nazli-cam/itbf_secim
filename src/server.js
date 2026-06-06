require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const pool = require('./db/pool');
const path = require('path');
const fs = require('fs');

const { generalLimiter } = require('./middleware/rateLimit');
const adminRoutes = require('./routes/admin');
const voteRoutes = require('./routes/vote');
const resultsRoutes = require('./routes/results');

const app = express();
const PORT = process.env.PORT || 3000;

// Railway terminates TLS at its proxy — trust it so req.ip and headers are correct
app.set('trust proxy', 1);

// ── Security ───────────────────────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      // Helmet adds script-src-attr separately; it must also allow unsafe-inline
      // or onclick="..." handlers will be blocked even if script-src allows them
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"]
    }
  }
}));

// ── Body Parsing (must be before CSRF) ────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Cookie & Session (must be before CSRF) ────────────────────────────────

app.use(cookieParser());
app.use(session({
  store: new pgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'fallback-dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    // Railway does SSL termination — the app itself receives plain HTTP.
    // secure: true would prevent the cookie from being sent and break sessions.
    secure: false,
    httpOnly: true,
    sameSite: 'lax',
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
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Session Expired</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f7fa;}
.card{background:white;padding:40px;border-radius:12px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.08);max-width:420px;}
h2{color:#e74c3c;margin-bottom:12px;}p{color:#7f8c8d;margin-bottom:20px;}
a{display:inline-block;padding:10px 24px;background:#3498db;color:white;border-radius:8px;text-decoration:none;font-weight:600;}</style>
</head><body><div class="card">
<h2>Session Expired</h2>
<p>Your form session has expired. Please go back and try again.</p>
<a href="javascript:history.back()">Go Back</a>
</div></body></html>`);
  }

  console.error('Unhandled error:', err);

  if (res.headersSent) return next(err);

  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred.'
      : (err.message || 'Internal Server Error')
  });
});

// ── DB Init + Start ────────────────────────────────────────────────────────

async function initDb() {
  const sqlPath = path.join(__dirname, '..', 'init.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log('Database schema initialised');
  } catch (err) {
    console.error('Database init error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Election server running on http://0.0.0.0:${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialise database, exiting:', err.message);
    process.exit(1);
  });

module.exports = app;
