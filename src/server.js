require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const pool = require('./db/pool');
const path = require('path');

const { generalLimiter } = require('./middleware/rateLimit');
const adminRoutes = require('./routes/admin');
const voteRoutes = require('./routes/vote');
const resultsRoutes = require('./routes/results');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

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

// Body parsing BEFORE csrf
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session BEFORE csrf
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
    secure: false,      // Railway terminates SSL at proxy; app sees plain HTTP
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.use(generalLimiter);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/admin', adminRoutes);
app.use('/vote', voteRoutes);
app.use('/results', resultsRoutes);

app.get('/', (req, res) => res.redirect('/admin'));

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({ error: 'Session expired. Please refresh and try again.' });
  }
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred.'
      : (err.message || 'Internal Server Error')
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Election server running on http://0.0.0.0:${PORT}`);
});

module.exports = app;
