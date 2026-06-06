# Secret Ballot Election System

A production-ready, completely anonymous secret ballot election web application built with Node.js (Express), PostgreSQL, and plain HTML/CSS/JS.

## Features

- **Complete anonymity**: Votes are stored with no voter ID — it is impossible to trace a vote back to a voter
- **Advisory locks**: PostgreSQL advisory locks prevent double-voting race conditions
- **Random delay**: 0–5s random delay before vote insertion prevents timing correlation attacks
- **Auto-reveal**: When the last vote is cast, results are automatically revealed and emailed to all participants
- **CSRF protection**: All forms protected with CSRF tokens
- **Rate limiting**: Per-route rate limiting on all endpoints
- **Security headers**: Helmet.js for security headers
- **Audit log**: Full audit trail of all admin actions (no vote content)

## Quick Start (Docker)

```bash
cp .env.example .env
# Edit .env with your settings
docker-compose up --build
```

Open http://localhost:3000

## Quick Start (Local)

```bash
npm install
createdb election
psql election < init.sql
cp .env.example .env
# Edit .env
npm run dev
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `ADMIN_PASSWORD` | Admin dashboard password |
| `SESSION_SECRET` | Express session secret (64+ random chars) |
| `SMTP_HOST` | SMTP server hostname |
| `SMTP_PORT` | SMTP port (587 for TLS) |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password / app password |
| `FROM_EMAIL` | Sender email address |
| `ADMIN_EMAIL` | Admin notification email |
| `BASE_URL` | Public base URL (for vote links) |
| `NODE_ENV` | `production` or `development` |
| `PORT` | HTTP port (default: 3000) |

## Workflow

1. **Admin logs in** at `/admin`
2. **Create election** with title and description
3. **Add 2 questions** with options (including optional "blank vote" options)
4. **Import voters** by pasting email addresses
5. **Activate election** — status changes from `draft` → `active`
6. **Send voting tokens** — each voter receives a unique link
7. Voters visit their link and **cast secret ballots** in a 3-step UI
8. When the **last voter votes**, status auto-changes to `revealed`
9. **Results emailed** to all voters and admin automatically

## Architecture

```
src/
├── server.js           # Express app entry point
├── routes/
│   ├── admin.js        # Admin dashboard (auth + API)
│   ├── vote.js         # Voter-facing ballot UI
│   └── results.js      # Public results page
├── middleware/
│   ├── auth.js         # Session-based admin auth
│   ├── rateLimit.js    # express-rate-limit configs
│   └── csrf.js         # csurf middleware
├── services/
│   ├── voteService.js  # Transaction + advisory lock vote logic
│   ├── emailService.js # Nodemailer email sending
│   └── tokenService.js # UUID token generation
└── db/
    ├── pool.js         # PostgreSQL connection pool
    └── queries.js      # All parameterized SQL queries
```

## Deploy to Railway

1. Create a new Railway project
2. Add a PostgreSQL service
3. Set environment variables
4. Deploy — Railway detects the Dockerfile automatically

## Security Notes

- Votes table has **no voter_id column** — anonymity is structural, not policy
- Advisory lock key: `election_id * 1000 + 1` (prevents concurrent vote submissions)
- Session cookies are `httpOnly` and `secure` in production
- Admin password is compared directly from env var (no database storage)
