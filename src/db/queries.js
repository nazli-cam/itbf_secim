const pool = require('./pool');

// ── Elections ──────────────────────────────────────────────────────────────

async function getElection(id) {
  const { rows } = await pool.query(
    'SELECT * FROM elections WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}

async function getActiveElection() {
  // Returns the most recent election that is still in progress (draft or active).
  // Once an election is revealed it is considered complete and a new one can be created.
  const { rows } = await pool.query(
    `SELECT * FROM elections WHERE status IN ('draft','active') ORDER BY id DESC LIMIT 1`
  );
  return rows[0] || null;
}

async function getAllElections() {
  const { rows } = await pool.query(
    `SELECT * FROM elections ORDER BY id DESC`
  );
  return rows;
}

async function createElection(title, description) {
  const { rows } = await pool.query(
    'INSERT INTO elections (title, description, status) VALUES ($1, $2, $3) RETURNING *',
    [title, description, 'draft']
  );
  return rows[0];
}

async function updateElectionStatus(id, status) {
  const { rows } = await pool.query(
    'UPDATE elections SET status = $1 WHERE id = $2 RETURNING *',
    [status, id]
  );
  return rows[0];
}

// ── Questions ──────────────────────────────────────────────────────────────

async function createQuestion(election_id, question_text, question_order, constraint_type) {
  const { rows } = await pool.query(
    'INSERT INTO questions (election_id, question_text, question_order, constraint_type) VALUES ($1, $2, $3, $4) RETURNING *',
    [election_id, question_text, question_order, constraint_type || null]
  );
  return rows[0];
}

async function getQuestions(election_id) {
  const { rows } = await pool.query(
    'SELECT * FROM questions WHERE election_id = $1 ORDER BY question_order ASC',
    [election_id]
  );
  return rows;
}

// ── Options ────────────────────────────────────────────────────────────────

async function createOption(question_id, option_text, option_order, is_blank) {
  const { rows } = await pool.query(
    'INSERT INTO options (question_id, option_text, option_order, is_blank) VALUES ($1, $2, $3, $4) RETURNING *',
    [question_id, option_text, option_order, is_blank || false]
  );
  return rows[0];
}

async function getOptions(question_id) {
  const { rows } = await pool.query(
    'SELECT * FROM options WHERE question_id = $1 ORDER BY option_order ASC',
    [question_id]
  );
  return rows;
}

async function getOptionsByElection(election_id) {
  const { rows } = await pool.query(
    `SELECT o.* FROM options o
     JOIN questions q ON o.question_id = q.id
     WHERE q.election_id = $1
     ORDER BY q.question_order ASC, o.option_order ASC`,
    [election_id]
  );
  return rows;
}

// ── Voters ─────────────────────────────────────────────────────────────────

async function createVoter(election_id, email) {
  const { rows } = await pool.query(
    'INSERT INTO voters (election_id, email) VALUES ($1, $2) RETURNING *',
    [election_id, email]
  );
  return rows[0];
}

async function getVoterByToken(token) {
  const { rows } = await pool.query(
    'SELECT * FROM voters WHERE vote_token = $1',
    [token]
  );
  return rows[0] || null;
}

async function getVoterByEmail(election_id, email) {
  const { rows } = await pool.query(
    'SELECT * FROM voters WHERE election_id = $1 AND email = $2',
    [election_id, email.toLowerCase()]
  );
  return rows[0] || null;
}

async function getVotersByElection(election_id) {
  const { rows } = await pool.query(
    'SELECT * FROM voters WHERE election_id = $1 ORDER BY id ASC',
    [election_id]
  );
  return rows;
}

async function markVoterVoted(token) {
  const { rows } = await pool.query(
    'UPDATE voters SET has_voted = TRUE WHERE vote_token = $1 RETURNING *',
    [token]
  );
  return rows[0];
}

async function markTokenSent(voter_id) {
  await pool.query(
    'UPDATE voters SET token_sent_at = NOW() WHERE id = $1',
    [voter_id]
  );
}

async function getUnvotedVoters(election_id) {
  const { rows } = await pool.query(
    'SELECT * FROM voters WHERE election_id = $1 AND has_voted = FALSE ORDER BY id ASC',
    [election_id]
  );
  return rows;
}

async function getVoterStats(election_id) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE has_voted = TRUE) AS voted,
       COUNT(*) FILTER (WHERE has_voted = FALSE) AS not_voted
     FROM voters
     WHERE election_id = $1`,
    [election_id]
  );
  const row = rows[0];
  return {
    total: parseInt(row.total, 10),
    voted: parseInt(row.voted, 10),
    not_voted: parseInt(row.not_voted, 10)
  };
}

// ── Votes ──────────────────────────────────────────────────────────────────

async function insertVote(client, election_id, question_id, option_id) {
  const { rows } = await client.query(
    'INSERT INTO votes (election_id, question_id, option_id) VALUES ($1, $2, $3) RETURNING *',
    [election_id, question_id, option_id]
  );
  return rows[0];
}

async function getResults(election_id) {
  const { rows } = await pool.query(
    `SELECT
       q.id AS question_id,
       q.question_text,
       q.question_order,
       o.id AS option_id,
       o.option_text,
       o.option_order,
       o.is_blank,
       COUNT(v.id) AS vote_count
     FROM questions q
     JOIN options o ON o.question_id = q.id
     LEFT JOIN votes v ON v.question_id = q.id AND v.option_id = o.id AND v.election_id = $1
     WHERE q.election_id = $1
     GROUP BY q.id, q.question_text, q.question_order, o.id, o.option_text, o.option_order, o.is_blank
     ORDER BY q.question_order ASC, o.option_order ASC`,
    [election_id]
  );
  return rows;
}

async function getVoteCount(election_id) {
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT submitted_at) AS count FROM votes WHERE election_id = $1`,
    [election_id]
  );
  // Count by Q1 votes (one per voter)
  const { rows: rows2 } = await pool.query(
    `SELECT COUNT(*) AS count FROM votes v
     JOIN questions q ON v.question_id = q.id
     WHERE v.election_id = $1 AND q.question_order = 1`,
    [election_id]
  );
  return parseInt(rows2[0].count, 10);
}

// ── Advisory Locks ─────────────────────────────────────────────────────────

async function acquireAdvisoryLock(client, lockId) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [lockId]);
}

async function releaseAdvisoryLock(client, lockId) {
  // Advisory transaction locks are released automatically at transaction end.
  // This is a no-op placeholder for explicit session locks if needed.
}

// ── Audit Log ──────────────────────────────────────────────────────────────

async function logAudit(action, performed_by, metadata) {
  await pool.query(
    'INSERT INTO audit_log (action, performed_by, metadata) VALUES ($1, $2, $3)',
    [action, performed_by || 'system', metadata ? JSON.stringify(metadata) : null]
  );
}

async function getAuditLog() {
  const { rows } = await pool.query(
    'SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 200'
  );
  return rows;
}

module.exports = {
  getElection,
  getActiveElection,
  getAllElections,
  createElection,
  updateElectionStatus,
  createQuestion,
  getQuestions,
  createOption,
  getOptions,
  getOptionsByElection,
  createVoter,
  getVoterByToken,
  getVoterByEmail,
  getVotersByElection,
  markVoterVoted,
  markTokenSent,
  getUnvotedVoters,
  getVoterStats,
  insertVote,
  getResults,
  getVoteCount,
  acquireAdvisoryLock,
  releaseAdvisoryLock,
  logAudit,
  getAuditLog
};
