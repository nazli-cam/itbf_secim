const express = require('express');
const router = express.Router();
const queries = require('../db/queries');
const voteService = require('../services/voteService');
const { tokenLimiter } = require('../middleware/rateLimit');

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// GET /vote/:token - serve voting page
router.get('/:token', tokenLimiter, async (req, res) => {
  try {
    const { token } = req.params;

    const voter = await queries.getVoterByToken(token);
    if (!voter) {
      return res.status(404).send(renderError('Invalid voting link. Please check your email for the correct link.'));
    }

    const election = await queries.getElection(voter.election_id);
    if (!election) {
      return res.status(404).send(renderError('Election not found.'));
    }

    if (election.status === 'draft') {
      return res.status(403).send(renderError('This election has not started yet. Please check back later.'));
    }

    if (voter.has_voted) {
      return res.send(renderAlreadyVoted(election));
    }

    if (election.status === 'closed' || election.status === 'revealed') {
      return res.status(403).send(renderError('This election has closed. Voting is no longer available.'));
    }

    const questions = await queries.getQuestions(voter.election_id);
    const allOptions = await queries.getOptionsByElection(voter.election_id);

    const questionsWithOptions = questions.map(q => ({
      ...q,
      options: allOptions.filter(o => o.question_id === q.id)
    }));

    const pageData = {
      token,
      election: { id: election.id, title: election.title, description: election.description },
      questions: questionsWithOptions
    };

    res.send(renderVotePage(pageData));
  } catch (err) {
    console.error('Vote page error:', err);
    res.status(500).send(renderError('An unexpected error occurred. Please try again.'));
  }
});

// POST /vote/:token - submit vote
router.post('/:token', tokenLimiter, async (req, res) => {
  try {
    const { token } = req.params;
    const { q1_option_id, q2_option_id } = req.body;

    if (!q1_option_id || !q2_option_id) {
      return res.status(400).json({ error: 'Please select an option for both questions.' });
    }

    const q1Id = parseInt(q1_option_id, 10);
    const q2Id = parseInt(q2_option_id, 10);

    if (isNaN(q1Id) || isNaN(q2Id)) {
      return res.status(400).json({ error: 'Invalid option selection.' });
    }

    const voter = await queries.getVoterByToken(token);
    if (!voter) {
      return res.status(403).json({ error: 'Invalid voting token.' });
    }

    if (voter.has_voted) {
      return res.status(409).json({ error: 'You have already voted.' });
    }

    const election = await queries.getElection(voter.election_id);
    if (!election || election.status !== 'active') {
      return res.status(403).json({ error: 'This election is not accepting votes.' });
    }

    // Validate options belong to this election
    const allOptions = await queries.getOptionsByElection(voter.election_id);
    const optionIds = allOptions.map(o => o.id);

    if (!optionIds.includes(q1Id) || !optionIds.includes(q2Id)) {
      return res.status(400).json({ error: 'Invalid option selection.' });
    }

    // Validate options belong to correct questions
    const questions = await queries.getQuestions(voter.election_id);
    const q1Question = questions.find(q => q.question_order === 1);
    const q2Question = questions.find(q => q.question_order === 2);

    if (!q1Question || !q2Question) {
      return res.status(500).json({ error: 'Election configuration error.' });
    }

    const q1Options = allOptions.filter(o => o.question_id === q1Question.id).map(o => o.id);
    const q2Options = allOptions.filter(o => o.question_id === q2Question.id).map(o => o.id);

    if (!q1Options.includes(q1Id)) {
      return res.status(400).json({ error: 'Invalid selection for Question 1.' });
    }
    if (!q2Options.includes(q2Id)) {
      return res.status(400).json({ error: 'Invalid selection for Question 2.' });
    }

    // Check Q2 constraint
    if (q2Question.constraint_type === 'exclude_q1_selection' && q1Id === q2Id) {
      return res.status(400).json({ error: 'You cannot select the same option for both questions.' });
    }

    const result = await voteService.submitVote(voter.election_id, q1Id, q2Id, token);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    return res.json({
      success: true,
      isLastVoter: result.isLastVoter,
      electionId: voter.election_id
    });
  } catch (err) {
    console.error('Vote submission error:', err);
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
});

function renderError(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error – Election</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f7fa; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: white; padding: 48px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); text-align: center; max-width: 480px; }
    .icon { font-size: 56px; margin-bottom: 16px; }
    h1 { font-size: 22px; color: #e74c3c; margin-bottom: 12px; }
    p { color: #7f8c8d; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⚠️</div>
    <h1>Unable to Load Ballot</h1>
    <p>${escHtml(message)}</p>
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
  <title>Already Voted – ${escHtml(election.title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f7fa; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: white; padding: 48px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); text-align: center; max-width: 480px; }
    .icon { font-size: 56px; margin-bottom: 16px; }
    h1 { font-size: 22px; color: #27ae60; margin-bottom: 12px; }
    p { color: #7f8c8d; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>Your Vote Has Been Recorded</h1>
    <p>You have already voted in <strong>${escHtml(election.title)}</strong>. Each voter may only vote once. Your ballot was submitted anonymously.</p>
  </div>
</body>
</html>`;
}

function renderVotePage(data) {
  const dataJson = JSON.stringify(data).replace(/<\/script>/gi, '<\\/script>');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vote – ${escHtml(data.election.title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f7fa; color: #2c3e50; min-height: 100vh; }
    .container { max-width: 640px; margin: 0 auto; padding: 24px 20px; }
    .header { text-align: center; margin-bottom: 32px; }
    .header h1 { font-size: 26px; color: #2c3e50; margin-bottom: 6px; }
    .header p { color: #7f8c8d; font-size: 15px; }
    .card { background: white; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); overflow: hidden; }
    .card-header { background: #2c3e50; color: white; padding: 20px 28px; }
    .card-header .step-indicator { font-size: 12px; opacity: 0.7; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
    .card-header h2 { font-size: 20px; }
    .card-body { padding: 28px; }
    .option-list { list-style: none; }
    .option-item { margin-bottom: 10px; }
    .option-label { display: flex; align-items: flex-start; gap: 14px; padding: 14px 16px; border: 2px solid #ecf0f1; border-radius: 8px; cursor: pointer; transition: all 0.15s; font-size: 15px; }
    .option-label:hover { border-color: #3498db; background: #eaf4fd; }
    .option-label.selected { border-color: #3498db; background: #eaf4fd; }
    .option-label.disabled { opacity: 0.45; cursor: not-allowed; background: #f8f9fa; }
    .option-label input[type=radio] { margin-top: 2px; flex-shrink: 0; accent-color: #3498db; width: 18px; height: 18px; }
    .option-text { flex: 1; }
    .excluded-note { font-size: 12px; color: #e67e22; display: block; margin-top: 2px; }
    .card-footer { padding: 20px 28px; border-top: 1px solid #ecf0f1; display: flex; gap: 12px; justify-content: flex-end; }
    .btn { padding: 12px 28px; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; transition: all 0.15s; }
    .btn-primary { background: #3498db; color: white; }
    .btn-primary:hover { background: #2980b9; }
    .btn-primary:disabled { background: #bdc3c7; cursor: not-allowed; }
    .btn-secondary { background: #ecf0f1; color: #2c3e50; }
    .btn-secondary:hover { background: #d5dbdb; }
    .btn-success { background: #27ae60; color: white; }
    .btn-success:hover { background: #219a52; }
    .confirmation-list { list-style: none; }
    .confirmation-item { padding: 16px; border: 1px solid #ecf0f1; border-radius: 8px; margin-bottom: 10px; }
    .confirmation-item .q-label { font-size: 12px; color: #7f8c8d; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
    .confirmation-item .q-text { font-size: 14px; color: #7f8c8d; margin-bottom: 8px; }
    .confirmation-item .selected-answer { font-size: 16px; font-weight: 600; color: #2c3e50; }
    .progress-bar { display: flex; gap: 6px; margin-bottom: 24px; }
    .progress-step { flex: 1; height: 4px; border-radius: 2px; background: #ecf0f1; transition: background 0.3s; }
    .progress-step.active { background: #3498db; }
    .progress-step.done { background: #27ae60; }
    .thank-you { text-align: center; padding: 48px 28px; }
    .thank-you .big-icon { font-size: 72px; margin-bottom: 16px; }
    .thank-you h2 { font-size: 26px; color: #27ae60; margin-bottom: 12px; }
    .thank-you p { color: #7f8c8d; font-size: 16px; line-height: 1.6; }
    .loading-overlay { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px; }
    .spinner { display: inline-block; width: 40px; height: 40px; border: 4px solid #ecf0f1; border-top-color: #3498db; border-radius: 50%; animation: spin 1s linear infinite; margin-bottom: 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error-msg { background: #fdf2f2; border: 1px solid #f5c6cb; color: #c0392b; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; display: none; }
    @media (max-width: 480px) {
      .card-header { padding: 16px 20px; }
      .card-body { padding: 20px; }
      .card-footer { padding: 16px 20px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${escHtml(data.election.title)}</h1>
      ${data.election.description ? `<p>${escHtml(data.election.description)}</p>` : ''}
    </div>

    <div class="progress-bar">
      <div class="progress-step active" id="step-ind-1"></div>
      <div class="progress-step" id="step-ind-2"></div>
      <div class="progress-step" id="step-ind-3"></div>
    </div>

    <div class="card" id="main-card">
      <!-- Steps rendered by JS -->
    </div>
  </div>

  <script>
    const VOTE_DATA = ${dataJson};
    const TOKEN = VOTE_DATA.token;
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
      const card = document.getElementById('main-card');
      let optHtml = '';
      for (const opt of q.options) {
        const checked = selections.q1 === opt.id ? 'checked' : '';
        optHtml += \`<li class="option-item">
          <label class="option-label\${selections.q1 === opt.id ? ' selected' : ''}">
            <input type="radio" name="q1_option" value="\${opt.id}" \${checked}>
            <span class="option-text">\${escHtml(opt.option_text)}\${opt.is_blank ? ' <em style="color:#7f8c8d;">(Blank vote)</em>' : ''}</span>
          </label>
        </li>\`;
      }
      card.innerHTML = \`
        <div class="card-header">
          <div class="step-indicator">Question 1 of \${QUESTIONS.length}</div>
          <h2>\${escHtml(q.question_text)}</h2>
        </div>
        <div class="card-body">
          <div class="error-msg" id="err-msg"></div>
          <ul class="option-list">\${optHtml}</ul>
        </div>
        <div class="card-footer">
          <button class="btn btn-primary" id="btn-next1">Next →</button>
        </div>
      \`;
      document.querySelectorAll('input[name=q1_option]').forEach(radio => {
        radio.addEventListener('change', () => {
          selections.q1 = parseInt(radio.value, 10);
          document.querySelectorAll('.option-label').forEach(l => l.classList.remove('selected'));
          radio.closest('.option-label').classList.add('selected');
        });
      });
      document.getElementById('btn-next1').addEventListener('click', () => {
        if (!selections.q1) {
          const err = document.getElementById('err-msg');
          err.textContent = 'Please select an option before continuing.';
          err.style.display = 'block';
          return;
        }
        currentStep = 2;
        updateProgress();
        renderStep2();
      });
    }

    function renderStep2() {
      const q1 = QUESTIONS.find(q => q.question_order === 1);
      const q2 = QUESTIONS.find(q => q.question_order === 2);
      if (!q2) return;
      const excludeQ1 = q2.constraint_type === 'exclude_q1_selection';
      const card = document.getElementById('main-card');
      let optHtml = '';
      for (const opt of q2.options) {
        const isExcluded = excludeQ1 && opt.id === selections.q1;
        const checked = selections.q2 === opt.id ? 'checked' : '';
        const disabledAttr = isExcluded ? 'disabled' : '';
        const disabledClass = isExcluded ? ' disabled' : '';
        const selectedClass = selections.q2 === opt.id ? ' selected' : '';
        optHtml += \`<li class="option-item">
          <label class="option-label\${disabledClass}\${selectedClass}" \${isExcluded ? 'style="cursor:not-allowed"' : ''}>
            <input type="radio" name="q2_option" value="\${opt.id}" \${checked} \${disabledAttr}>
            <span class="option-text">
              \${escHtml(opt.option_text)}\${opt.is_blank ? ' <em style="color:#7f8c8d;">(Blank vote)</em>' : ''}
              \${isExcluded ? '<span class="excluded-note">⚠️ You selected this in Question 1</span>' : ''}
            </span>
          </label>
        </li>\`;
      }
      card.innerHTML = \`
        <div class="card-header">
          <div class="step-indicator">Question 2 of \${QUESTIONS.length}</div>
          <h2>\${escHtml(q2.question_text)}</h2>
        </div>
        <div class="card-body">
          <div class="error-msg" id="err-msg"></div>
          <ul class="option-list">\${optHtml}</ul>
        </div>
        <div class="card-footer">
          <button class="btn btn-secondary" id="btn-back2">← Back</button>
          <button class="btn btn-primary" id="btn-next2">Next →</button>
        </div>
      \`;
      document.querySelectorAll('input[name=q2_option]').forEach(radio => {
        radio.addEventListener('change', () => {
          selections.q2 = parseInt(radio.value, 10);
          document.querySelectorAll('.option-label:not(.disabled)').forEach(l => l.classList.remove('selected'));
          radio.closest('.option-label').classList.add('selected');
        });
      });
      document.getElementById('btn-back2').addEventListener('click', () => {
        currentStep = 1;
        updateProgress();
        renderStep1();
      });
      document.getElementById('btn-next2').addEventListener('click', () => {
        if (!selections.q2) {
          const err = document.getElementById('err-msg');
          err.textContent = 'Please select an option before continuing.';
          err.style.display = 'block';
          return;
        }
        currentStep = 3;
        updateProgress();
        renderStep3();
      });
    }

    function renderStep3() {
      const q1 = QUESTIONS.find(q => q.question_order === 1);
      const q2 = QUESTIONS.find(q => q.question_order === 2);
      const opt1 = q1.options.find(o => o.id === selections.q1);
      const opt2 = q2.options.find(o => o.id === selections.q2);
      const card = document.getElementById('main-card');
      card.innerHTML = \`
        <div class="card-header">
          <div class="step-indicator">Step 3 of 3 – Confirm</div>
          <h2>Review Your Ballot</h2>
        </div>
        <div class="card-body">
          <p style="color:#7f8c8d;margin-bottom:20px;font-size:14px;">Please review your selections before submitting. Your vote is <strong>secret and anonymous</strong>.</p>
          <div class="error-msg" id="err-msg"></div>
          <ul class="confirmation-list">
            <li class="confirmation-item">
              <div class="q-label">Question 1</div>
              <div class="q-text">\${escHtml(q1.question_text)}</div>
              <div class="selected-answer">→ \${escHtml(opt1 ? opt1.option_text : 'Unknown')}</div>
            </li>
            <li class="confirmation-item">
              <div class="q-label">Question 2</div>
              <div class="q-text">\${escHtml(q2.question_text)}</div>
              <div class="selected-answer">→ \${escHtml(opt2 ? opt2.option_text : 'Unknown')}</div>
            </li>
          </ul>
        </div>
        <div class="card-footer">
          <button class="btn btn-secondary" id="btn-back3">← Edit</button>
          <button class="btn btn-success" id="btn-submit">✓ Submit Vote</button>
        </div>
      \`;
      document.getElementById('btn-back3').addEventListener('click', () => {
        currentStep = 2;
        updateProgress();
        renderStep2();
      });
      document.getElementById('btn-submit').addEventListener('click', submitVote);
    }

    async function submitVote() {
      const card = document.getElementById('main-card');
      card.innerHTML = \`
        <div class="loading-overlay">
          <div class="spinner"></div>
          <p style="color:#7f8c8d;">Submitting your secret ballot…</p>
        </div>
      \`;

      try {
        const resp = await fetch('/vote/' + TOKEN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q1_option_id: selections.q1, q2_option_id: selections.q2 })
        });
        const data = await resp.json();

        if (data.success) {
          document.querySelector('.progress-bar').style.display = 'none';
          card.innerHTML = \`
            <div class="thank-you">
              <div class="big-icon">🗳️</div>
              <h2>Your Vote Has Been Cast</h2>
              <p>Thank you for participating in <strong>\${escHtml(VOTE_DATA.election.title)}</strong>.</p>
              <p style="margin-top:12px;">Your ballot has been recorded anonymously. You will receive an email with the results once all votes are in.</p>
              \${data.isLastVoter ? '<p style="margin-top:16px;color:#27ae60;font-weight:600;">All votes are now in! Results will be sent to all participants shortly.</p>' : ''}
            </div>
          \`;
        } else {
          renderStep3();
          const err = document.getElementById('err-msg');
          if (err) {
            err.textContent = data.error || 'An error occurred. Please try again.';
            err.style.display = 'block';
          }
        }
      } catch (err) {
        renderStep3();
        const errEl = document.getElementById('err-msg');
        if (errEl) {
          errEl.textContent = 'Network error. Please check your connection and try again.';
          errEl.style.display = 'block';
        }
      }
    }

    updateProgress();
    renderStep1();
  </script>
</body>
</html>`;
}

module.exports = router;
