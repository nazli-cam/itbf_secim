CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS elections (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft','active','closed','revealed')),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS questions (
  id SERIAL PRIMARY KEY,
  election_id INTEGER REFERENCES elections(id),
  question_text TEXT NOT NULL,
  question_order INTEGER NOT NULL,
  constraint_type VARCHAR(50)
);

CREATE TABLE IF NOT EXISTS options (
  id SERIAL PRIMARY KEY,
  question_id INTEGER REFERENCES questions(id),
  option_text VARCHAR(255) NOT NULL,
  option_order INTEGER NOT NULL,
  is_blank BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS voters (
  id SERIAL PRIMARY KEY,
  election_id INTEGER REFERENCES elections(id),
  email VARCHAR(255) NOT NULL,
  vote_token UUID DEFAULT gen_random_uuid() UNIQUE,
  has_voted BOOLEAN DEFAULT FALSE,
  token_sent_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS votes (
  id SERIAL PRIMARY KEY,
  election_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  option_id INTEGER NOT NULL,
  submitted_at TIMESTAMP DEFAULT NOW()
  -- NO voter_id — completely anonymous
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  action VARCHAR(255) NOT NULL,
  performed_by VARCHAR(255),
  timestamp TIMESTAMP DEFAULT NOW(),
  metadata JSONB
);
