const express = require('express');
const router = express.Router();
const queries = require('../db/queries');
const voteService = require('../services/voteService');
const { csrfProtection, csrfToken } = require('../middleware/csrf');
const { tokenLimiter } = require('../middleware/rateLimit');

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Email Entry Form ────────────────────────────────────────────────────────

router.get('/', csrfProtection, csrfToken, async (req, res) => {
  try {
    const election = await queries.getActiveElection();
    if (!election || election.status === 'draft') {
      return res.send(renderError('The election has not started yet. Please check back later.'));
    }
    if (election.status === 'closed' || election.status === 'revealed') {
      return res.send(renderError('This election has closed. Voting is no longer available.'));
    }
    res.send(renderEmailForm(election, res.locals.csrfToken, ''));
  } catch (err) {
    console.error('Vote index error:', err);
    res.status(500).send(renderError('An unexpected error occurred. Please try again.'));
  }
});

// ── Email Check + Session Auth ──────────────────────────────────────────────

router.post('/check', tokenLimiter, csrfProtection, async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const election = await queries.getActiveElection();
      return res.send(renderEmailForm(election, req.body._csrf || '', 'Please enter a valid email address.'));
    }

    const election = await queries.getActiveElection();
    if (!election || election.status !== 'active') {
      return res.send(renderError('The election is not currently accepting votes.'));
    }

    const voter = await queries.getVoterByEmail(election.id, email);

    if (!voter) {
      return res.send(renderEmailForm(election, req.body._csrf || '', 'Your email address is not registered for this election.'));
    }

    if (voter.has_voted) {
      return res.send(renderAlreadyVoted(election));
    }

    // Store email in session temporarily for ballot auth — cleared after vote
    req.session.votingEmail = voter.email;
    req.session.votingElectionId = election.id;
    req.session.save(() => res.redirect('/vote/ballot'));
  } catch (err) {
    console.error('Vote check error:', err);
    res.status(500).send(renderError('An unexpected error occurred. Please try again.'));
  }
});

// ── Ballot Page ─────────────────────────────────────────────────────────────

router.get('/ballot', csrfProtection, csrfToken, async (req, res) => {
  try {
    if (!req.session.votingEmail || !req.session.votingElectionId) {
      return res.redirect('/vote');
    }

    const election = await queries.getElection(req.session.votingElectionId);
    if (!election || election.status !== 'active') {
      return res.send(renderError('The election is not currently accepting votes.'));
    }

    // Re-check voter hasn't voted since session was created
    const voter = await queries.getVoterByEmail(election.id, req.session.votingEmail);
    if (!voter || voter.has_voted) {
      req.session.votingEmail = null;
      req.session.votingElectionId = null;
      return voter && voter.has_voted
        ? res.send(renderAlreadyVoted(election))
        : res.redirect('/vote');
    }

    const questions = await queries.getQuestions(election.id);
    const allOptions = await queries.getOptionsByElection(election.id);

    const questionsWithOptions = questions.map(q => ({
      ...q,
      options: allOptions.filter(o => o.question_id === q.id)
    }));

    const pageData = {
      election: { id: election.id, title: election.title, description: election.description },
      questions: questionsWithOptions,
      csrfToken: res.locals.csrfToken
    };

    res.send(renderVotePage(pageData));
  } catch (err) {
    console.error('Ballot page error:', err);
    res.status(500).send(renderError('An unexpected error occurred. Please try again.'));
  }
});

// ── Vote Submission ──────────────────────────────────────────────────────────

router.post('/ballot', tokenLimiter, csrfProtection, async (req, res) => {
  try {
    if (!req.session.votingEmail || !req.session.votingElectionId) {
      return res.status(403).json({ error: 'Session expired. Please go back and enter your email again.' });
    }

    const { q1_option_id, q2_option_id } = req.body;

    if (!q1_option_id || !q2_option_id) {
      return res.status(400).json({ error: 'Please select an option for both questions.' });
    }

    const q1Id = parseInt(q1_option_id, 10);
    const q2Id = parseInt(q2_option_id, 10);

    if (isNaN(q1Id) || isNaN(q2Id)) {
      return res.status(400).json({ error: 'Invalid option selection.' });
    }

    const electionId = req.session.votingElectionId;
    const voterEmail = req.session.votingEmail;

    const election = await queries.getElection(electionId);
    if (!election || election.status !== 'active') {
      return res.status(403).json({ error: 'This election is not accepting votes.' });
    }

    const voter = await queries.getVoterByEmail(electionId, voterEmail);
    if (!voter) {
      return res.status(403).json({ error: 'Voter not found.' });
    }
    if (voter.has_voted) {
      return res.status(409).json({ error: 'You have already voted.' });
    }

    // Validate options belong to this election and correct questions
    const allOptions = await queries.getOptionsByElection(electionId);
    const questions = await queries.getQuestions(electionId);
    const q1Question = questions.find(q => q.question_order === 1);
    const q2Question = questions.find(q => q.question_order === 2);

    if (!q1Question || !q2Question) {
      return res.status(500).json({ error: 'Election configuration error.' });
    }

    const q1OptionIds = allOptions.filter(o => o.question_id === q1Question.id).map(o => o.id);
    const q2OptionIds = allOptions.filter(o => o.question_id === q2Question.id).map(o => o.id);

    if (!q1OptionIds.includes(q1Id)) {
      return res.status(400).json({ error: 'Invalid selection for Question 1.' });
    }
    if (!q2OptionIds.includes(q2Id)) {
      return res.status(400).json({ error: 'Invalid selection for Question 2.' });
    }

    if (q2Question.constraint_type === 'exclude_q1_selection' && q1Id === q2Id) {
      return res.status(400).json({ error: 'You cannot select the same option for both questions.' });
    }

    const result = await voteService.submitVote(electionId, q1Id, q2Id, voterEmail);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    // Clear voting session — vote is cast, email no longer needed
    req.session.votingEmail = null;
    req.session.votingElectionId = null;

    return res.json({
      success: true,
      isLastVoter: result.isLastVoter,
      electionId
    });
  } catch (err) {
    console.error('Vote submission error:', err);
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
});

// ── HTML Renderers ──────────────────────────────────────────────────────────

const baseStyles = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f7fa; color: #2c3e50; min-height: 100vh; }
  .container { max-width: 640px; margin: 0 auto; padding: 24px 20px; }
  .card { background: white; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); overflow: hidden; }
  .card-header { background: #2c3e50; color: white; padding: 24px 28px; text-align: center; }
  .card-header h1 { font-size: 22px; margin-bottom: 4px; }
  .card-header p { opacity: 0.75; font-size: 14px; }
  .card-body { padding: 32px 28px; }
  .card-footer { padding: 20px 28px; border-top: 1px solid #ecf0f1; }
  .btn { padding: 12px 28px; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; transition: all 0.15s; width: 100%; }
  .btn-primary { background: #3498db; color: white; }
  .btn-primary:hover { background: #2980b9; }
  .btn-success { background: #27ae60; color: white; }
  .btn-success:hover { background: #219a52; }
  .btn-secondary { background: #ecf0f1; color: #2c3e50; }
  .btn-secondary:hover { background: #d5dbdb; }
  .btn-inline { width: auto; padding: 12px 24px; }
  label { display: block; font-size: 13px; font-weight: 600; color: #5d6d7e; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
  input[type=email], input[type=text] { width: 100%; padding: 12px 16px; border: 2px solid #ecf0f1; border-radius: 8px; font-size: 15px; outline: none; transition: border-color 0.15s; }
  input[type=email]:focus, input[type=text]:focus { border-color: #3498db; }
  .error-box { background: #fdf2f2; border: 1px solid #f5c6cb; color: #c0392b; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; font-size: 14px; }
  .option-list { list-style: none; }
  .option-item { margin-bottom: 10px; }
  .option-label { display: flex; align-items: flex-start; gap: 14px; padding: 14px 16px; border: 2px solid #ecf0f1; border-radius: 8px; cursor: pointer; transition: all 0.15s; font-size: 15px; }
  .option-label:hover { border-color: #3498db; background: #eaf4fd; }
  .option-label.selected { border-color: #3498db; background: #eaf4fd; }
  .option-label.disabled { opacity: 0.45; cursor: not-allowed; background: #f8f9fa; }
  .option-label input[type=radio] { margin-top: 2px; flex-shrink: 0; accent-color: #3498db; width: 18px; height: 18px; }
  .option-text { flex: 1; }
  .excluded-note { font-size: 12px; color: #e67e22; display: block; margin-top: 2px; }
  .progress-bar { display: flex; gap: 6px; margin-bottom: 24px; }
  .progress-step { flex: 1; height: 4px; border-radius: 2px; background: #ecf0f1; transition: background 0.3s; }
  .progress-step.active { background: #3498db; }
  .progress-step.done { background: #27ae60; }
  .step-label { font-size: 12px; opacity: 0.7; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
  .confirmation-item { padding: 16px; border: 1px solid #ecf0f1; border-radius: 8px; margin-bottom: 10px; }
  .confirmation-item .q-label { font-size: 12px; color: #7f8c8d; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .confirmation-item .q-text { font-size: 14px; color: #7f8c8d; margin-bottom: 8px; }
  .confirmation-item .selected-answer { font-size: 16px; font-weight: 600; color: #2c3e50; }
  .spinner { display: inline-block; width: 36px; height: 36px; border: 4px solid #ecf0f1; border-top-color: #3498db; border-radius: 50%; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .thank-you { text-align: center; padding: 48px 28px; }
  .thank-you .big-icon { font-size: 72px; margin-bottom: 16px; }
  .thank-you h2 { font-size: 26px; color: #27ae60; margin-bottom: 12px; }
  .thank-you p { color: #7f8c8d; font-size: 15px; line-height: 1.6; margin-top: 8px; }
  @media (max-width: 480px) {
    .card-body { padding: 20px; }
    .card-footer { padding: 16px 20px; }
  }
`;

function renderError(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Election</title>
  <style>${baseStyles}</style>
</head>
<body>
  <div class="container" style="display:flex;align-items:center;min-height:100vh;">
    <div class="card" style="width:100%;text-align:center;padding:48px 28px;">
      <div style="font-size:56px;margin-bottom:16px;">⚠️</div>
      <h2 style="color:#e74c3c;margin-bottom:12px;">Unable to Load Ballot</h2>
      <p style="color:#7f8c8d;line-height:1.6;">${escHtml(message)}</p>
    </div>
  </div>
</body>
</html>`;
}

function renderAlreadyVoted(election) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Already Voted</title>
  <style>${baseStyles}</style>
</head>
<body>
  <div class="container" style="display:flex;align-items:center;min-height:100vh;">
    <div class="card" style="width:100%;text-align:center;padding:48px 28px;">
      <div style="font-size:56px;margin-bottom:16px;">✅</div>
      <h2 style="color:#27ae60;margin-bottom:12px;">Your Vote Has Been Recorded</h2>
      <p style="color:#7f8c8d;line-height:1.6;">You have already voted in <strong>${escHtml(election.title)}</strong>. Each voter may only vote once. Your ballot was submitted anonymously.</p>
    </div>
  </div>
</body>
</html>`;
}

function renderEmailForm(election, csrf, errorMsg) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(election ? election.title : 'Vote')}</title>
  <style>${baseStyles}</style>
</head>
<body>
  <div class="container" style="display:flex;align-items:center;min-height:100vh;">
    <div class="card" style="width:100%;">
      <div class="card-header">
        <div style="font-size:40px;margin-bottom:12px;">🗳️</div>
        <h1>${escHtml(election ? election.title : 'Election')}</h1>
        ${election && election.description ? `<p>${escHtml(election.description)}</p>` : ''}
      </div>
      <div class="card-body">
        <p style="color:#7f8c8d;font-size:14px;margin-bottom:24px;">Enter the email address you were registered with to access your secret ballot.</p>
        ${errorMsg ? `<div class="error-box">${escHtml(errorMsg)}</div>` : ''}
        <form method="POST" action="/vote/check">
          <input type="hidden" name="_csrf" value="${escHtml(csrf)}">
          <div style="margin-bottom:20px;">
            <label for="email">Email Address</label>
            <input type="email" id="email" name="email" placeholder="you@example.com" autofocus required autocomplete="email">
          </div>
          <button type="submit" class="btn btn-primary">Access My Ballot →</button>
        </form>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function renderVotePage(data) {
  const dataJson = JSON.stringify({
    election: data.election,
    questions: data.questions
  }).replace(/<\/script>/gi, '<\\/script>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vote – ${escHtml(data.election.title)}</title>
  <style>${baseStyles}
    .ballot-header { text-align: center; margin-bottom: 28px; }
    .ballot-header h1 { font-size: 24px; color: #2c3e50; margin-bottom: 4px; }
    .ballot-header p { color: #7f8c8d; font-size: 14px; }
    .card-step-header { background: #2c3e50; color: white; padding: 20px 28px; }
    .footer-btns { display: flex; gap: 12px; justify-content: flex-end; }
    .footer-btns .btn { width: auto; padding: 12px 24px; }
    .err-msg { background: #fdf2f2; border: 1px solid #f5c6cb; color: #c0392b; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; display: none; }
    .loading-overlay { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px; gap: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="ballot-header">
      <h1>${escHtml(data.election.title)}</h1>
      ${data.election.description ? `<p>${escHtml(data.election.description)}</p>` : ''}
    </div>

    <div class="progress-bar" id="progress-bar">
      <div class="progress-step active" id="step-ind-1"></div>
      <div class="progress-step" id="step-ind-2"></div>
      <div class="progress-step" id="step-ind-3"></div>
    </div>

    <div class="card" id="main-card"></div>
  </div>

  <script>
    const CSRF_TOKEN = ${JSON.stringify(data.csrfToken)};
    const VOTE_DATA = ${dataJson};
    const QUESTIONS = VOTE_DATA.questions;

    let currentStep = 1;
    const selections = {};

    function escHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function updateProgress() {
      for (let i = 1; i <= 3; i++) {
        const el = document.getElementById('step-ind-' + i);
        if (i < currentStep) el.className = 'progress-step done';
        else if (i === currentStep) el.className = 'progress-step active';
        else el.className = 'progress-step';
      }
    }

    function renderStep1() {
      const q = QUESTIONS.find(q => q.question_order === 1);
      if (!q) return;
      let optHtml = '';
      for (const opt of q.options) {
        const checked = selections.q1 === opt.id ? 'checked' : '';
        const sel = selections.q1 === opt.id ? ' selected' : '';
        optHtml += \`<li class="option-item">
          <label class="option-label\${sel}">
            <input type="radio" name="q1_option" value="\${opt.id}" \${checked}>
            <span class="option-text">\${escHtml(opt.option_text)}\${opt.is_blank ? ' <em style="color:#7f8c8d;">(Blank vote)</em>' : ''}</span>
          </label>
        </li>\`;
      }
      document.getElementById('main-card').innerHTML = \`
        <div class="card-step-header">
          <div class="step-label">Question 1 of \${QUESTIONS.length}</div>
          <h2 style="font-size:19px;">\${escHtml(q.question_text)}</h2>
        </div>
        <div class="card-body">
          <div class="err-msg" id="err-msg"></div>
          <ul class="option-list">\${optHtml}</ul>
        </div>
        <div class="card-footer">
          <div class="footer-btns">
            <button class="btn btn-primary btn-inline" id="btn-next1">Next →</button>
          </div>
        </div>
      \`;
      document.querySelectorAll('input[name=q1_option]').forEach(r => {
        r.addEventListener('change', () => {
          selections.q1 = parseInt(r.value, 10);
          document.querySelectorAll('.option-label').forEach(l => l.classList.remove('selected'));
          r.closest('.option-label').classList.add('selected');
        });
      });
      document.getElementById('btn-next1').addEventListener('click', () => {
        if (!selections.q1) { showErr('Please select an option before continuing.'); return; }
        currentStep = 2; updateProgress(); renderStep2();
      });
    }

    function renderStep2() {
      const q2 = QUESTIONS.find(q => q.question_order === 2);
      if (!q2) return;
      const excludeQ1 = q2.constraint_type === 'exclude_q1_selection';
      let optHtml = '';
      for (const opt of q2.options) {
        const isExcluded = excludeQ1 && opt.id === selections.q1;
        const checked = selections.q2 === opt.id ? 'checked' : '';
        const cls = (isExcluded ? ' disabled' : '') + (selections.q2 === opt.id ? ' selected' : '');
        optHtml += \`<li class="option-item">
          <label class="option-label\${cls}"\${isExcluded ? ' style="cursor:not-allowed"' : ''}>
            <input type="radio" name="q2_option" value="\${opt.id}" \${checked} \${isExcluded ? 'disabled' : ''}>
            <span class="option-text">
              \${escHtml(opt.option_text)}\${opt.is_blank ? ' <em style="color:#7f8c8d;">(Blank vote)</em>' : ''}
              \${isExcluded ? '<span class="excluded-note">⚠️ You selected this in Question 1</span>' : ''}
            </span>
          </label>
        </li>\`;
      }
      document.getElementById('main-card').innerHTML = \`
        <div class="card-step-header">
          <div class="step-label">Question 2 of \${QUESTIONS.length}</div>
          <h2 style="font-size:19px;">\${escHtml(q2.question_text)}</h2>
        </div>
        <div class="card-body">
          <div class="err-msg" id="err-msg"></div>
          <ul class="option-list">\${optHtml}</ul>
        </div>
        <div class="card-footer">
          <div class="footer-btns">
            <button class="btn btn-secondary btn-inline" id="btn-back2">← Back</button>
            <button class="btn btn-primary btn-inline" id="btn-next2">Next →</button>
          </div>
        </div>
      \`;
      document.querySelectorAll('input[name=q2_option]').forEach(r => {
        r.addEventListener('change', () => {
          selections.q2 = parseInt(r.value, 10);
          document.querySelectorAll('.option-label:not(.disabled)').forEach(l => l.classList.remove('selected'));
          r.closest('.option-label').classList.add('selected');
        });
      });
      document.getElementById('btn-back2').addEventListener('click', () => { currentStep = 1; updateProgress(); renderStep1(); });
      document.getElementById('btn-next2').addEventListener('click', () => {
        if (!selections.q2) { showErr('Please select an option before continuing.'); return; }
        currentStep = 3; updateProgress(); renderStep3();
      });
    }

    function renderStep3() {
      const q1 = QUESTIONS.find(q => q.question_order === 1);
      const q2 = QUESTIONS.find(q => q.question_order === 2);
      const opt1 = q1.options.find(o => o.id === selections.q1);
      const opt2 = q2.options.find(o => o.id === selections.q2);
      document.getElementById('main-card').innerHTML = \`
        <div class="card-step-header">
          <div class="step-label">Step 3 of 3 – Confirm</div>
          <h2 style="font-size:19px;">Review Your Ballot</h2>
        </div>
        <div class="card-body">
          <p style="color:#7f8c8d;margin-bottom:20px;font-size:14px;">Please review your selections. Your vote is <strong>secret and anonymous</strong>.</p>
          <div class="err-msg" id="err-msg"></div>
          <div class="confirmation-item">
            <div class="q-label">Question 1</div>
            <div class="q-text">\${escHtml(q1.question_text)}</div>
            <div class="selected-answer">→ \${escHtml(opt1 ? opt1.option_text : '—')}</div>
          </div>
          <div class="confirmation-item">
            <div class="q-label">Question 2</div>
            <div class="q-text">\${escHtml(q2.question_text)}</div>
            <div class="selected-answer">→ \${escHtml(opt2 ? opt2.option_text : '—')}</div>
          </div>
        </div>
        <div class="card-footer">
          <div class="footer-btns">
            <button class="btn btn-secondary btn-inline" id="btn-back3">← Edit</button>
            <button class="btn btn-success btn-inline" id="btn-submit">✓ Submit Vote</button>
          </div>
        </div>
      \`;
      document.getElementById('btn-back3').addEventListener('click', () => { currentStep = 2; updateProgress(); renderStep2(); });
      document.getElementById('btn-submit').addEventListener('click', submitVote);
    }

    function showErr(msg) {
      const el = document.getElementById('err-msg');
      if (el) { el.textContent = msg; el.style.display = 'block'; }
    }

    async function submitVote() {
      document.getElementById('main-card').innerHTML = \`
        <div class="loading-overlay">
          <div class="spinner"></div>
          <p style="color:#7f8c8d;">Submitting your secret ballot…</p>
        </div>
      \`;
      document.getElementById('progress-bar').style.display = 'none';

      try {
        const resp = await fetch('/vote/ballot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CSRF-Token': CSRF_TOKEN },
          body: JSON.stringify({ q1_option_id: selections.q1, q2_option_id: selections.q2 })
        });
        const data = await resp.json();

        if (data.success) {
          document.getElementById('main-card').innerHTML = \`
            <div class="thank-you">
              <div class="big-icon">🗳️</div>
              <h2>Your Vote Has Been Cast</h2>
              <p>Thank you for participating in <strong>\${escHtml(VOTE_DATA.election.title)}</strong>.</p>
              <p>Your ballot has been recorded anonymously.</p>
              \${data.isLastVoter ? '<p style="color:#27ae60;font-weight:600;margin-top:16px;">All votes are now in! Results will be shared shortly.</p>' : ''}
            </div>
          \`;
        } else {
          currentStep = 3; updateProgress(); renderStep3();
          setTimeout(() => showErr(data.error || 'An error occurred. Please try again.'), 50);
        }
      } catch (err) {
        currentStep = 3; updateProgress(); renderStep3();
        setTimeout(() => showErr('Network error. Please check your connection and try again.'), 50);
      }
    }

    updateProgress();
    renderStep1();
  </script>
</body>
</html>`;
}

module.exports = router;
