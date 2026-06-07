const express = require('express');
const router = express.Router();
const queries = require('../db/queries');
const emailService = require('../services/emailService');
const { requireAdmin } = require('../middleware/auth');
const { csrfProtection, csrfToken } = require('../middleware/csrf');
const { adminLimiter } = require('../middleware/rateLimit');

router.use(adminLimiter);

// ── Auth ───────────────────────────────────────────────────────────────────

router.get('/login', csrfProtection, csrfToken, (req, res) => {
  if (req.session && req.session.isAdmin) {
    return res.redirect('/admin');
  }
  const error = req.query.error ? 'Invalid password. Please try again.' : '';
  res.send(renderLoginPage(res.locals.csrfToken, error));
});

router.post('/login', csrfProtection, (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword || password !== adminPassword) {
    return res.redirect('/admin/login?error=1');
  }

  req.session.isAdmin = true;
  req.session.save(() => res.redirect('/admin'));
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// ── Dashboard ──────────────────────────────────────────────────────────────

router.get('/', requireAdmin, csrfProtection, csrfToken, (req, res) => {
  res.send(renderDashboard(res.locals.csrfToken));
});

// ── API: CSRF Token ────────────────────────────────────────────────────────

router.get('/api/csrf-token', requireAdmin, csrfProtection, csrfToken, (req, res) => {
  res.json({ csrfToken: res.locals.csrfToken });
});

// ── API: Election ──────────────────────────────────────────────────────────

router.get('/api/election', requireAdmin, async (req, res) => {
  try {
    const election = await queries.getActiveElection();
    if (!election) return res.json({ election: null });

    const [questions, stats] = await Promise.all([
      queries.getQuestions(election.id),
      queries.getVoterStats(election.id)
    ]);

    const questionsWithOptions = await Promise.all(
      questions.map(async (q) => ({
        ...q,
        options: await queries.getOptions(q.id)
      }))
    );

    res.json({ election, questions: questionsWithOptions, stats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/api/election', requireAdmin, csrfProtection, async (req, res) => {
  try {
    const { title, description } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }
    const election = await queries.createElection(title.trim(), (description || '').trim());
    await queries.logAudit('election_created', 'admin', { election_id: election.id, title: election.title });
    res.json({ success: true, election });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── API: Questions ─────────────────────────────────────────────────────────

router.post('/api/questions', requireAdmin, csrfProtection, async (req, res) => {
  try {
    const { election_id, question_text, question_order, constraint_type } = req.body;
    if (!election_id || !question_text || !question_order) {
      return res.status(400).json({ error: 'election_id, question_text, and question_order are required' });
    }
    const question = await queries.createQuestion(
      parseInt(election_id, 10),
      question_text.trim(),
      parseInt(question_order, 10),
      constraint_type || null
    );
    await queries.logAudit('question_created', 'admin', { question_id: question.id });
    res.json({ success: true, question });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── API: Options ───────────────────────────────────────────────────────────

router.post('/api/options', requireAdmin, csrfProtection, async (req, res) => {
  try {
    const { question_id, option_text, option_order, is_blank } = req.body;
    if (!question_id || !option_text || option_order === undefined) {
      return res.status(400).json({ error: 'question_id, option_text, and option_order are required' });
    }
    const option = await queries.createOption(
      parseInt(question_id, 10),
      option_text.trim(),
      parseInt(option_order, 10),
      is_blank === true || is_blank === 'true'
    );
    await queries.logAudit('option_created', 'admin', { option_id: option.id });
    res.json({ success: true, option });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── API: Voters ────────────────────────────────────────────────────────────

router.post('/api/voters', requireAdmin, csrfProtection, async (req, res) => {
  try {
    const { election_id, emails_raw } = req.body;
    if (!election_id || !emails_raw) {
      return res.status(400).json({ error: 'election_id and emails_raw are required' });
    }

    const electionId = parseInt(election_id, 10);
    const lines = emails_raw.split(/[\n,;]+/);
    const emails = lines
      .map(e => e.trim().toLowerCase())
      .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

    if (emails.length === 0) {
      return res.status(400).json({ error: 'No valid email addresses found' });
    }

    // Check for duplicates against existing voters
    const existing = await queries.getVotersByElection(electionId);
    const existingEmails = new Set(existing.map(v => v.email.toLowerCase()));
    const newEmails = emails.filter(e => !existingEmails.has(e));

    const created = [];
    for (const email of newEmails) {
      const voter = await queries.createVoter(electionId, email);
      created.push(voter);
    }

    await queries.logAudit('voters_imported', 'admin', {
      election_id: electionId,
      count: created.length,
      skipped: emails.length - created.length
    });

    res.json({ success: true, created: created.length, skipped: emails.length - created.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── API: Activate ──────────────────────────────────────────────────────────

router.post('/api/activate', requireAdmin, csrfProtection, async (req, res) => {
  try {
    const election = await queries.getActiveElection();
    if (!election) return res.status(404).json({ error: 'No election found' });
    if (election.status !== 'draft') {
      return res.status(400).json({ error: `Election is already ${election.status}` });
    }

    const questions = await queries.getQuestions(election.id);
    if (questions.length < 2) {
      return res.status(400).json({ error: 'Election must have at least 2 questions' });
    }

    for (const q of questions) {
      const options = await queries.getOptions(q.id);
      if (options.length < 2) {
        return res.status(400).json({ error: `Question "${q.question_text}" must have at least 2 options` });
      }
    }

    const voters = await queries.getVotersByElection(election.id);
    if (voters.length === 0) {
      return res.status(400).json({ error: 'Election must have at least one voter' });
    }

    await queries.updateElectionStatus(election.id, 'active');
    await queries.logAudit('election_activated', 'admin', { election_id: election.id });

    res.json({ success: true, message: 'Election is now active' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── API: All Elections ─────────────────────────────────────────────────────

router.get('/api/elections', requireAdmin, async (req, res) => {
  try {
    const elections = await queries.getAllElections();
    const electionsWithStats = await Promise.all(
      elections.map(async (e) => {
        const stats = await queries.getVoterStats(e.id);
        return { ...e, stats };
      })
    );
    res.json({ elections: electionsWithStats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── API: Audit Log ─────────────────────────────────────────────────────────

router.get('/api/audit-log', requireAdmin, async (req, res) => {
  try {
    const log = await queries.getAuditLog();
    res.json({ log });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── HTML Renderers ─────────────────────────────────────────────────────────

function renderLoginPage(csrfToken, error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Login – Election System</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a252f; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: white; padding: 48px 40px; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); width: 100%; max-width: 400px; }
    .logo { text-align: center; margin-bottom: 32px; }
    .logo h1 { font-size: 22px; color: #2c3e50; margin-top: 12px; }
    .logo p { color: #7f8c8d; font-size: 14px; margin-top: 4px; }
    .icon { font-size: 48px; }
    label { display: block; font-size: 13px; font-weight: 600; color: #5d6d7e; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
    input[type=password] { width: 100%; padding: 12px 16px; border: 2px solid #ecf0f1; border-radius: 8px; font-size: 16px; transition: border-color 0.15s; outline: none; }
    input[type=password]:focus { border-color: #3498db; }
    .btn { width: 100%; padding: 13px; background: #2c3e50; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 20px; transition: background 0.15s; }
    .btn:hover { background: #1a252f; }
    .error { background: #fdf2f2; border: 1px solid #f5c6cb; color: #c0392b; padding: 10px 14px; border-radius: 6px; font-size: 14px; margin-bottom: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="icon">🗳️</div>
      <h1>Election Admin</h1>
      <p>Secret Ballot System</p>
    </div>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="POST" action="/admin/login">
      <input type="hidden" name="_csrf" value="${csrfToken}">
      <div style="margin-bottom:20px;">
        <label for="password">Admin Password</label>
        <input type="password" id="password" name="password" autofocus autocomplete="current-password" required>
      </div>
      <button type="submit" class="btn">Sign In →</button>
    </form>
  </div>
</body>
</html>`;
}

function renderDashboard(csrfToken) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Dashboard – Election System</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f2f5; color: #2c3e50; }
    .topbar { background: #2c3e50; color: white; padding: 0 24px; display: flex; align-items: center; justify-content: space-between; height: 56px; position: sticky; top: 0; z-index: 100; }
    .topbar h1 { font-size: 18px; display: flex; align-items: center; gap: 10px; }
    .topbar a { color: rgba(255,255,255,0.7); text-decoration: none; font-size: 14px; }
    .topbar a:hover { color: white; }
    .tabs { display: flex; gap: 0; border-bottom: 2px solid #dde1e7; background: white; padding: 0 24px; position: sticky; top: 56px; z-index: 99; }
    .tab-btn { padding: 14px 20px; font-size: 14px; font-weight: 600; border: none; background: none; cursor: pointer; color: #7f8c8d; border-bottom: 3px solid transparent; margin-bottom: -2px; transition: all 0.15s; }
    .tab-btn.active { color: #2c3e50; border-bottom-color: #3498db; }
    .tab-btn:hover { color: #2c3e50; }
    .tab-content { display: none; padding: 28px 24px; max-width: 900px; margin: 0 auto; }
    .tab-content.active { display: block; }
    .section { background: white; border-radius: 10px; padding: 24px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
    .section h2 { font-size: 16px; font-weight: 700; color: #2c3e50; margin-bottom: 18px; padding-bottom: 10px; border-bottom: 1px solid #ecf0f1; display: flex; align-items: center; gap: 8px; }
    .form-row { margin-bottom: 14px; }
    label { display: block; font-size: 13px; font-weight: 600; color: #5d6d7e; margin-bottom: 5px; }
    input[type=text], input[type=email], textarea, select { width: 100%; padding: 10px 14px; border: 2px solid #ecf0f1; border-radius: 8px; font-size: 14px; outline: none; transition: border-color 0.15s; font-family: inherit; }
    input[type=text]:focus, input[type=email]:focus, textarea:focus { border-color: #3498db; }
    textarea { min-height: 100px; resize: vertical; }
    .btn { padding: 10px 20px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.15s; display: inline-flex; align-items: center; gap: 6px; }
    .btn-primary { background: #3498db; color: white; }
    .btn-primary:hover { background: #2980b9; }
    .btn-success { background: #27ae60; color: white; }
    .btn-success:hover { background: #219a52; }
    .btn-warning { background: #e67e22; color: white; }
    .btn-warning:hover { background: #ca6f1e; }
    .btn-danger { background: #e74c3c; color: white; }
    .btn-danger:hover { background: #c0392b; }
    .btn-secondary { background: #ecf0f1; color: #2c3e50; }
    .btn-secondary:hover { background: #d5dbdb; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; }
    .badge-draft { background: #fef9e7; color: #d68910; }
    .badge-active { background: #e9f7ef; color: #1e8449; }
    .badge-closed { background: #fdf2f2; color: #c0392b; }
    .badge-revealed { background: #eaf4fd; color: #1a5276; }
    .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 20px; }
    .stat-card { background: #f8f9fa; border-radius: 8px; padding: 16px; text-align: center; }
    .stat-card .value { font-size: 32px; font-weight: 700; color: #2c3e50; }
    .stat-card .label { font-size: 12px; color: #7f8c8d; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
    .progress-container { margin-bottom: 20px; }
    .progress-label { display: flex; justify-content: space-between; font-size: 13px; color: #7f8c8d; margin-bottom: 6px; }
    .progress-track { background: #ecf0f1; border-radius: 6px; height: 14px; overflow: hidden; }
    .progress-fill { height: 100%; background: linear-gradient(90deg, #27ae60, #2ecc71); border-radius: 6px; transition: width 0.5s ease; }
    .option-list { list-style: none; margin-top: 10px; }
    .option-list li { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: #f8f9fa; border-radius: 6px; margin-bottom: 6px; font-size: 14px; }
    .option-list li .remove-btn { color: #e74c3c; cursor: pointer; font-size: 18px; line-height: 1; background: none; border: none; padding: 0 4px; }
    .add-option-row { display: flex; gap: 8px; margin-top: 8px; }
    .add-option-row input { flex: 1; }
    .voters-list { max-height: 200px; overflow-y: auto; margin-top: 10px; }
    .voters-list .voter-row { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; border-bottom: 1px solid #ecf0f1; font-size: 13px; }
    .voter-row .voted { color: #27ae60; font-weight: 600; }
    .voter-row .not-voted { color: #e67e22; }
    .results-question { margin-bottom: 32px; }
    .results-question h3 { font-size: 16px; margin-bottom: 14px; padding-bottom: 8px; border-bottom: 1px solid #ecf0f1; }
    .result-option { margin-bottom: 12px; }
    .result-option .row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; font-size: 14px; }
    .result-option .bar-track { background: #ecf0f1; border-radius: 6px; height: 18px; overflow: hidden; }
    .result-option .bar-fill { height: 100%; border-radius: 6px; background: linear-gradient(90deg, #3498db, #5dade2); }
    .result-option .bar-fill.winner { background: linear-gradient(90deg, #27ae60, #2ecc71); }
    .result-option .bar-fill.blank-opt { background: linear-gradient(90deg, #bdc3c7, #d5dbdb); }
    .audit-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .audit-table th { text-align: left; padding: 8px 12px; background: #f8f9fa; border-bottom: 2px solid #ecf0f1; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #5d6d7e; }
    .audit-table td { padding: 8px 12px; border-bottom: 1px solid #ecf0f1; }
    .audit-table tr:last-child td { border-bottom: none; }
    .msg { padding: 10px 14px; border-radius: 6px; font-size: 14px; margin-top: 10px; display: none; }
    .msg-success { background: #e9f7ef; color: #1e8449; border: 1px solid #a9dfbf; }
    .msg-error { background: #fdf2f2; color: #c0392b; border: 1px solid #f5c6cb; }
    .checkbox-row { display: flex; align-items: center; gap: 8px; }
    .checkbox-row input[type=checkbox] { width: 16px; height: 16px; accent-color: #3498db; }
    @media (max-width: 600px) {
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
      .topbar h1 span { display: none; }
      .tab-btn { padding: 12px 12px; font-size: 13px; }
    }
  </style>
</head>
<body>

<div class="topbar">
  <h1>🗳️ <span>Election Admin Dashboard</span></h1>
  <a href="/admin/logout">Sign out</a>
</div>

<div class="tabs">
  <button class="tab-btn active" onclick="showTab('setup')">⚙️ Setup</button>
  <button class="tab-btn" onclick="showTab('dashboard')">📊 Dashboard</button>
  <button class="tab-btn" onclick="showTab('results')">📈 Results</button>
  <button class="tab-btn" onclick="showTab('history')">🗂️ History</button>
  <button class="tab-btn" onclick="showTab('audit')">🔍 Audit Log</button>
</div>

<!-- SETUP TAB -->
<div id="tab-setup" class="tab-content active">

  <div class="section">
    <h2>🗳️ Create Election</h2>
    <div id="msg-election" class="msg"></div>
    <div id="election-info" style="display:none;margin-bottom:16px;"></div>
    <div id="create-election-form">
      <div class="form-row">
        <label>Election Title</label>
        <input type="text" id="election-title" placeholder="e.g. Board Member Election 2025">
      </div>
      <div class="form-row">
        <label>Description (optional)</label>
        <textarea id="election-desc" placeholder="Briefly describe this election…"></textarea>
      </div>
      <button class="btn btn-primary" onclick="createElection()">Create Election</button>
    </div>
  </div>

  <div class="section" id="questions-section" style="display:none;">
    <h2>❓ Questions</h2>
    <div id="msg-questions" class="msg"></div>

    <div id="q1-block" style="margin-bottom:24px;">
      <h3 style="font-size:14px;color:#5d6d7e;margin-bottom:10px;">QUESTION 1</h3>
      <div class="form-row">
        <label>Question Text</label>
        <input type="text" id="q1-text" placeholder="e.g. Who should be elected as President?">
      </div>
      <div id="q1-options-list" class="option-list"></div>
      <div class="add-option-row">
        <input type="text" id="q1-option-input" placeholder="Option text…" onkeydown="if(event.key==='Enter')addOption(1)">
        <button class="btn btn-secondary" onclick="addOption(1)">+ Add Option</button>
        <button class="btn btn-secondary" onclick="addBlankOption(1)">+ Blank Vote</button>
      </div>
    </div>

    <div id="q2-block">
      <h3 style="font-size:14px;color:#5d6d7e;margin-bottom:10px;">QUESTION 2</h3>
      <div class="form-row">
        <label>Question Text</label>
        <input type="text" id="q2-text" placeholder="e.g. Who should be elected as Vice President?">
      </div>
      <div class="form-row">
        <div class="checkbox-row">
          <input type="checkbox" id="q2-constraint">
          <label for="q2-constraint" style="margin-bottom:0;">Constraint: voter cannot select same option as Question 1</label>
        </div>
      </div>
      <div id="q2-options-list" class="option-list"></div>
      <div class="add-option-row">
        <input type="text" id="q2-option-input" placeholder="Option text…" onkeydown="if(event.key==='Enter')addOption(2)">
        <button class="btn btn-secondary" onclick="addOption(2)">+ Add Option</button>
        <button class="btn btn-secondary" onclick="addBlankOption(2)">+ Blank Vote</button>
      </div>
    </div>

    <div style="margin-top:20px;">
      <button class="btn btn-primary" onclick="saveQuestions()">💾 Save Questions & Options</button>
    </div>
  </div>

  <div class="section" id="voters-section" style="display:none;">
    <h2>👥 Import Voters</h2>
    <div id="msg-voters" class="msg"></div>
    <div class="form-row">
      <label>Email Addresses (one per line, or comma/semicolon separated)</label>
      <textarea id="voters-raw" placeholder="alice@example.com&#10;bob@example.com&#10;carol@example.com"></textarea>
    </div>
    <button class="btn btn-primary" onclick="importVoters()">Import Voters</button>

    <div id="voters-list-container" style="margin-top:16px;display:none;">
      <div style="font-size:13px;color:#7f8c8d;margin-bottom:6px;" id="voters-count-label"></div>
      <div class="voters-list" id="voters-list"></div>
    </div>
  </div>

  <div class="section" id="activate-section" style="display:none;">
    <h2>🚀 Launch Election</h2>
    <p style="color:#7f8c8d;font-size:14px;margin-bottom:16px;">Once activated, voters will be able to cast their ballots. Make sure everything is set up correctly before activating.</p>
    <button class="btn btn-success" id="btn-activate" onclick="activateElection()" style="font-size:16px;padding:14px 32px;">
      ▶ Activate Election
    </button>
  </div>

</div>

<!-- DASHBOARD TAB -->
<div id="tab-dashboard" class="tab-content">
  <div class="section">
    <h2>📊 Election Status</h2>
    <div id="election-status-display">Loading…</div>
  </div>

  <div class="section">
    <h2>👥 Voter Progress</h2>
    <div class="stats-grid">
      <div class="stat-card"><div class="value" id="stat-total">–</div><div class="label">Total Voters</div></div>
      <div class="stat-card"><div class="value" id="stat-voted" style="color:#27ae60;">–</div><div class="label">Voted</div></div>
      <div class="stat-card"><div class="value" id="stat-remaining" style="color:#e67e22;">–</div><div class="label">Remaining</div></div>
    </div>
    <div class="progress-container">
      <div class="progress-label"><span>Voting Progress</span><span id="progress-pct">0%</span></div>
      <div class="progress-track"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>
    </div>
    <div style="background:#eaf4fd;border-radius:8px;padding:14px 18px;margin-top:8px;">
      <div style="font-size:13px;font-weight:600;color:#1a5276;margin-bottom:4px;">🗳️ Voting URL</div>
      <div style="font-size:15px;font-family:monospace;color:#2c3e50;">
        <a href="/vote" target="_blank" style="color:#2980b9;">/vote</a>
      </div>
      <div style="font-size:12px;color:#7f8c8d;margin-top:4px;">Share this link with voters. They will enter their email address to access the ballot.</div>
    </div>
  </div>
</div>

<!-- HISTORY TAB -->
<div id="tab-history" class="tab-content">
  <div class="section">
    <h2>🗂️ Election History</h2>
    <div id="history-container">Loading…</div>
  </div>
</div>

<!-- RESULTS TAB -->
<div id="tab-results" class="tab-content">
  <div class="section">
    <h2>📈 Election Results</h2>
    <div id="results-container">Loading results…</div>
  </div>
</div>

<!-- AUDIT LOG TAB -->
<div id="tab-audit" class="tab-content">
  <div class="section">
    <h2>🔍 Audit Log</h2>
    <div id="audit-container">Loading…</div>
  </div>
</div>

<script>
const CSRF_TOKEN_VAL = '${csrfToken}';

let electionData = null;
let q1Options = [];
let q2Options = [];

function showTab(name) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  event.target.classList.add('active');

  if (name === 'dashboard') loadDashboard();
  if (name === 'results') loadResults();
  if (name === 'history') loadHistory();
  if (name === 'audit') loadAuditLog();
}

function showMsg(id, text, isError) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = 'msg ' + (isError ? 'msg-error' : 'msg-success');
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 5000);
}

async function apiPost(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CSRF-Token': CSRF_TOKEN_VAL },
    body: JSON.stringify(body)
  });
  return resp.json();
}

async function apiGet(url) {
  const resp = await fetch(url);
  return resp.json();
}

// ── Setup ──────────────────────────────────────────────────────────────────

async function loadSetupState() {
  const data = await apiGet('/admin/api/election');
  if (data.election) {
    electionData = data;
    document.getElementById('create-election-form').style.display = 'none';
    const info = document.getElementById('election-info');
    info.style.display = 'block';

    const isRevealed = data.election.status === 'revealed';
    const newElectionBtn = isRevealed
      ? \`<div style="margin-top:10px;"><p style="color:#1e8449;font-size:13px;margin-bottom:10px;">✅ This election is complete. You can start a new election below.</p><button class="btn btn-primary" onclick="showNewElectionForm()" style="font-size:14px;padding:10px 20px;">+ Start New Election</button></div>\`
      : '';
    info.innerHTML = \`<div style="padding:12px 16px;background:\${isRevealed ? '#e9f7ef' : '#eaf4fd'};border-radius:8px;font-size:14px;">
      <strong>\${escHtml(data.election.title)}</strong>
      <span class="badge badge-\${data.election.status}" style="margin-left:8px;">\${data.election.status}</span>
      \${data.election.description ? \`<p style="color:#5d6d7e;margin-top:4px;">\${escHtml(data.election.description)}</p>\` : ''}
      \${newElectionBtn}
    </div>\`;

    if (!isRevealed) {
      document.getElementById('questions-section').style.display = 'block';
      document.getElementById('voters-section').style.display = 'block';

      if (data.questions && data.questions.length >= 1) {
        const q1 = data.questions.find(q => q.question_order === 1);
        if (q1) {
          document.getElementById('q1-text').value = q1.question_text;
          q1Options = q1.options.map(o => ({ text: o.option_text, is_blank: o.is_blank, saved: true, id: o.id }));
          renderOptionList(1);
        }
        const q2 = data.questions.find(q => q.question_order === 2);
        if (q2) {
          document.getElementById('q2-text').value = q2.question_text;
          if (q2.constraint_type === 'exclude_q1_selection') {
            document.getElementById('q2-constraint').checked = true;
          }
          q2Options = q2.options.map(o => ({ text: o.option_text, is_blank: o.is_blank, saved: true, id: o.id }));
          renderOptionList(2);
        }
      }

      if (data.stats && data.stats.total > 0) {
        renderVoterList(data);
      }

      if (data.election.status === 'draft') {
        document.getElementById('activate-section').style.display = 'block';
      }
    }
  }
}

function showNewElectionForm() {
  electionData = null;
  q1Options = [];
  q2Options = [];
  document.getElementById('election-info').style.display = 'none';
  document.getElementById('create-election-form').style.display = 'block';
  document.getElementById('questions-section').style.display = 'none';
  document.getElementById('voters-section').style.display = 'none';
  document.getElementById('activate-section').style.display = 'none';
  document.getElementById('election-title').value = '';
  document.getElementById('election-desc').value = '';
  document.getElementById('q1-text').value = '';
  document.getElementById('q2-text').value = '';
  document.getElementById('q1-options-list').innerHTML = '';
  document.getElementById('q2-options-list').innerHTML = '';
  document.getElementById('q2-constraint').checked = false;
  document.getElementById('msg-election').style.display = 'none';
}

async function createElection() {
  const title = document.getElementById('election-title').value.trim();
  const desc = document.getElementById('election-desc').value.trim();
  if (!title) return showMsg('msg-election', 'Please enter an election title.', true);

  const data = await apiPost('/admin/api/election', { title, description: desc });
  if (data.success) {
    showMsg('msg-election', 'Election created!', false);
    setTimeout(() => location.reload(), 800);
  } else {
    showMsg('msg-election', data.error || 'Error creating election.', true);
  }
}

function addOption(qNum) {
  const input = document.getElementById('q' + qNum + '-option-input');
  const text = input.value.trim();
  if (!text) return;
  const list = qNum === 1 ? q1Options : q2Options;
  list.push({ text, is_blank: false, saved: false });
  input.value = '';
  renderOptionList(qNum);
}

function addBlankOption(qNum) {
  const list = qNum === 1 ? q1Options : q2Options;
  list.push({ text: 'Blank Vote', is_blank: true, saved: false });
  renderOptionList(qNum);
}

function removeOption(qNum, idx) {
  const list = qNum === 1 ? q1Options : q2Options;
  if (list[idx] && list[idx].saved) {
    alert('Cannot remove saved options. Please reload the page to see current state.');
    return;
  }
  list.splice(idx, 1);
  renderOptionList(qNum);
}

function renderOptionList(qNum) {
  const list = qNum === 1 ? q1Options : q2Options;
  const container = document.getElementById('q' + qNum + '-options-list');
  container.innerHTML = list.map((o, i) => \`
    <li>
      <span>\${escHtml(o.text)}\${o.is_blank ? ' <em style="color:#7f8c8d;">(Blank)</em>' : ''}\${o.saved ? ' <span style="color:#27ae60;font-size:11px;">✓ saved</span>' : ''}</span>
      \${o.saved ? '' : \`<button class="remove-btn" onclick="removeOption(\${qNum},\${i})">×</button>\`}
    </li>
  \`).join('');
}

async function saveQuestions() {
  if (!electionData) return showMsg('msg-questions', 'Create an election first.', true);

  const q1Text = document.getElementById('q1-text').value.trim();
  const q2Text = document.getElementById('q2-text').value.trim();

  if (!q1Text || !q2Text) return showMsg('msg-questions', 'Please fill in both question texts.', true);
  if (q1Options.length < 2) return showMsg('msg-questions', 'Question 1 needs at least 2 options.', true);
  if (q2Options.length < 2) return showMsg('msg-questions', 'Question 2 needs at least 2 options.', true);

  const electionId = electionData.election.id;
  const q2Constraint = document.getElementById('q2-constraint').checked ? 'exclude_q1_selection' : null;

  // Save Q1
  const r1 = await apiPost('/admin/api/questions', {
    election_id: electionId,
    question_text: q1Text,
    question_order: 1,
    constraint_type: null
  });
  if (!r1.success) return showMsg('msg-questions', r1.error || 'Error saving Q1', true);

  // Save Q1 options (unsaved only)
  for (let i = 0; i < q1Options.length; i++) {
    const o = q1Options[i];
    if (!o.saved) {
      await apiPost('/admin/api/options', {
        question_id: r1.question.id,
        option_text: o.text,
        option_order: i + 1,
        is_blank: o.is_blank
      });
    }
  }

  // Save Q2
  const r2 = await apiPost('/admin/api/questions', {
    election_id: electionId,
    question_text: q2Text,
    question_order: 2,
    constraint_type: q2Constraint
  });
  if (!r2.success) return showMsg('msg-questions', r2.error || 'Error saving Q2', true);

  // Save Q2 options (unsaved only)
  for (let i = 0; i < q2Options.length; i++) {
    const o = q2Options[i];
    if (!o.saved) {
      await apiPost('/admin/api/options', {
        question_id: r2.question.id,
        option_text: o.text,
        option_order: i + 1,
        is_blank: o.is_blank
      });
    }
  }

  showMsg('msg-questions', 'Questions and options saved!', false);
  setTimeout(() => location.reload(), 800);
}

async function importVoters() {
  if (!electionData) return showMsg('msg-voters', 'Create an election first.', true);
  const raw = document.getElementById('voters-raw').value.trim();
  if (!raw) return showMsg('msg-voters', 'Please enter at least one email address.', true);

  const data = await apiPost('/admin/api/voters', {
    election_id: electionData.election.id,
    emails_raw: raw
  });

  if (data.success) {
    showMsg('msg-voters', \`Imported \${data.created} voter(s). Skipped \${data.skipped} duplicate(s).\`, false);
    document.getElementById('voters-raw').value = '';
    setTimeout(() => location.reload(), 1000);
  } else {
    showMsg('msg-voters', data.error || 'Error importing voters.', true);
  }
}

function renderVoterList(data) {
  // Get actual voter list from /admin/api/election which doesn't include individual voters
  // We use stats display instead
  const container = document.getElementById('voters-list-container');
  const stats = data.stats;
  if (stats && stats.total > 0) {
    container.style.display = 'block';
    document.getElementById('voters-count-label').textContent =
      \`\${stats.total} voter(s) — \${stats.voted} voted, \${stats.not_voted} remaining\`;
  }
}

async function activateElection() {
  if (!confirm('Are you sure you want to activate this election? Voters will be able to cast their ballots.')) return;
  const data = await apiPost('/admin/api/activate', {});
  if (data.success) {
    alert('Election activated! Share the voting URL /vote with your voters.');
    location.reload();
  } else {
    alert('Error: ' + (data.error || 'Could not activate election.'));
  }
}

// ── Dashboard ──────────────────────────────────────────────────────────────

async function loadDashboard() {
  const data = await apiGet('/admin/api/election');
  if (!data.election) {
    document.getElementById('election-status-display').innerHTML = '<p style="color:#7f8c8d;">No election found. Go to Setup tab to create one.</p>';
    return;
  }

  document.getElementById('election-status-display').innerHTML = \`
    <div style="font-size:18px;font-weight:600;">\${escHtml(data.election.title)}</div>
    <div style="margin-top:6px;"><span class="badge badge-\${data.election.status}">\${data.election.status.toUpperCase()}</span></div>
    \${data.election.description ? \`<p style="color:#7f8c8d;margin-top:8px;font-size:14px;">\${escHtml(data.election.description)}</p>\` : ''}
    <p style="color:#95a5a6;font-size:13px;margin-top:6px;">Results at: <a href="/results/\${data.election.id}" target="_blank">/results/\${data.election.id}</a></p>
  \`;

  const stats = data.stats;
  document.getElementById('stat-total').textContent = stats.total;
  document.getElementById('stat-voted').textContent = stats.voted;
  document.getElementById('stat-remaining').textContent = stats.not_voted;

  const pct = stats.total > 0 ? Math.round((stats.voted / stats.total) * 100) : 0;
  document.getElementById('progress-pct').textContent = pct + '%';
  document.getElementById('progress-fill').style.width = pct + '%';

}

// ── History ────────────────────────────────────────────────────────────────

async function loadHistory() {
  const container = document.getElementById('history-container');
  const data = await apiGet('/admin/api/elections');
  if (!data.elections || data.elections.length === 0) {
    container.innerHTML = '<p style="color:#7f8c8d;">No elections yet.</p>';
    return;
  }

  const rows = data.elections.map(e => {
    const pct = e.stats.total > 0 ? Math.round((e.stats.voted / e.stats.total) * 100) : 0;
    const created = new Date(e.created_at).toLocaleDateString();
    const resultsLink = e.status === 'revealed'
      ? \`<a href="/results/\${e.id}" target="_blank" style="color:#2980b9;font-size:13px;">View Results →</a>\`
      : \`<span style="color:#95a5a6;font-size:13px;">\${e.status}</span>\`;
    return \`<tr>
      <td style="font-weight:600;">\${escHtml(e.title)}</td>
      <td><span class="badge badge-\${e.status}">\${e.status}</span></td>
      <td style="font-size:13px;color:#7f8c8d;">\${created}</td>
      <td style="font-size:13px;">\${e.stats.voted} / \${e.stats.total} (\${pct}%)</td>
      <td>\${resultsLink}</td>
    </tr>\`;
  }).join('');

  container.innerHTML = \`<table class="audit-table">
    <thead><tr><th>Election</th><th>Status</th><th>Created</th><th>Turnout</th><th>Results</th></tr></thead>
    <tbody>\${rows}</tbody>
  </table>\`;
}

// ── Results ────────────────────────────────────────────────────────────────

async function loadResults() {
  const elData = await apiGet('/admin/api/election');
  const container = document.getElementById('results-container');

  if (!elData.election) {
    container.innerHTML = '<p style="color:#7f8c8d;">No election found.</p>';
    return;
  }

  if (elData.election.status !== 'revealed') {
    container.innerHTML = \`<div style="text-align:center;padding:40px;color:#7f8c8d;">
      <div style="font-size:48px;margin-bottom:12px;">⏳</div>
      <p>Election status: <strong>\${elData.election.status}</strong></p>
      <p style="margin-top:8px;">Results will appear here once the election is complete and all votes are tallied.</p>
    </div>\`;
    return;
  }

  const resp = await apiGet('/results/api/' + elData.election.id);
  if (!resp.election) {
    container.innerHTML = '<p style="color:#e74c3c;">Could not load results.</p>';
    return;
  }

  let html = '';
  for (const q of resp.questions) {
    const opts = resp.results.filter(r => r.question_id === q.id);
    const total = opts.reduce((s, o) => s + parseInt(o.vote_count, 10), 0);
    const maxVotes = Math.max(...opts.map(o => parseInt(o.vote_count, 10)));

    html += \`<div class="results-question"><h3>\${escHtml(q.question_text)}</h3>\`;

    for (const opt of opts) {
      const count = parseInt(opt.vote_count, 10);
      const pct = total > 0 ? Math.round((count / total) * 100) : 0;
      const isWinner = count > 0 && count === maxVotes && !opt.is_blank;
      const cls = opt.is_blank ? 'blank-opt' : (isWinner ? 'winner' : '');

      html += \`<div class="result-option">
        <div class="row">
          <span style="font-weight:\${isWinner ? '700' : '400'}">\${escHtml(opt.option_text)}\${opt.is_blank ? ' (Blank)' : ''}\${isWinner ? ' ★' : ''}</span>
          <span style="color:#7f8c8d;">\${count} votes (\${pct}%)</span>
        </div>
        <div class="bar-track"><div class="bar-fill \${cls}" style="width:\${pct}%"></div></div>
      </div>\`;
    }

    html += \`<p style="font-size:12px;color:#95a5a6;margin-top:6px;">Total: \${total} votes</p></div>\`;
  }

  container.innerHTML = html || '<p>No results available.</p>';
}

// ── Audit Log ──────────────────────────────────────────────────────────────

async function loadAuditLog() {
  const data = await apiGet('/admin/api/audit-log');
  const container = document.getElementById('audit-container');

  if (!data.log || data.log.length === 0) {
    container.innerHTML = '<p style="color:#7f8c8d;">No audit entries yet.</p>';
    return;
  }

  let rows = data.log.map(entry => {
    const meta = entry.metadata ? JSON.stringify(entry.metadata) : '–';
    const ts = new Date(entry.timestamp).toLocaleString();
    return \`<tr>
      <td>\${escHtml(ts)}</td>
      <td>\${escHtml(entry.action)}</td>
      <td>\${escHtml(entry.performed_by || '–')}</td>
      <td style="font-family:monospace;font-size:12px;color:#5d6d7e;">\${escHtml(meta)}</td>
    </tr>\`;
  }).join('');

  container.innerHTML = \`<table class="audit-table">
    <thead><tr><th>Time</th><th>Action</th><th>By</th><th>Metadata</th></tr></thead>
    <tbody>\${rows}</tbody>
  </table>\`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Init
loadSetupState();
</script>
</body>
</html>`;
}

module.exports = router;
