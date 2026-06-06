const express = require('express');
const router = express.Router();
const queries = require('../db/queries');

// GET /results/:election_id - serve results page
router.get('/:election_id', (req, res) => {
  const { election_id } = req.params;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Election Results</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f7fa; color: #2c3e50; }
    .container { max-width: 800px; margin: 40px auto; padding: 0 20px; }
    .header { background: #2c3e50; color: white; padding: 32px; border-radius: 12px 12px 0 0; text-align: center; }
    .header h1 { font-size: 28px; margin-bottom: 8px; }
    .header p { opacity: 0.8; font-size: 15px; }
    .body { background: white; padding: 32px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
    .pending { text-align: center; padding: 60px 20px; }
    .pending .icon { font-size: 64px; margin-bottom: 16px; }
    .pending h2 { font-size: 22px; margin-bottom: 12px; color: #7f8c8d; }
    .pending p { color: #95a5a6; margin-bottom: 20px; }
    .spinner { display: inline-block; width: 32px; height: 32px; border: 3px solid #ecf0f1; border-top-color: #3498db; border-radius: 50%; animation: spin 1s linear infinite; margin-bottom: 12px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .question-block { margin-bottom: 40px; }
    .question-block h2 { font-size: 18px; font-weight: 600; color: #2c3e50; margin-bottom: 16px; padding-bottom: 10px; border-bottom: 2px solid #ecf0f1; }
    .option-row { margin-bottom: 14px; }
    .option-label { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; font-size: 14px; }
    .option-name { font-weight: 500; }
    .option-name.blank { color: #7f8c8d; font-style: italic; }
    .option-stats { color: #7f8c8d; font-size: 13px; }
    .bar-track { background: #ecf0f1; border-radius: 6px; height: 20px; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 6px; transition: width 0.8s ease; }
    .bar-fill.winner { background: linear-gradient(90deg, #27ae60, #2ecc71); }
    .bar-fill.normal { background: linear-gradient(90deg, #3498db, #5dade2); }
    .bar-fill.blank { background: linear-gradient(90deg, #bdc3c7, #d5dbdb); }
    .total-note { font-size: 12px; color: #95a5a6; margin-top: 8px; }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    .badge-revealed { background: #d5f5e3; color: #1e8449; }
    .election-meta { display: flex; align-items: center; gap: 12px; justify-content: center; flex-wrap: wrap; margin-top: 8px; }
    .countdown { font-size: 13px; color: #aaa; }
    .error-state { text-align: center; padding: 40px; color: #e74c3c; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 id="election-title">Loading Results…</h1>
      <div class="election-meta">
        <span id="election-status-badge"></span>
        <span id="description-text" style="opacity:0.8;font-size:14px;"></span>
      </div>
    </div>
    <div class="body" id="results-body">
      <div class="pending">
        <div class="spinner"></div>
        <p>Loading results…</p>
      </div>
    </div>
  </div>

  <script>
    const ELECTION_ID = ${parseInt(election_id, 10)};
    let refreshTimer = null;

    function formatPct(count, total) {
      if (total === 0) return '0%';
      return Math.round((count / total) * 100) + '%';
    }

    function renderResults(data) {
      document.title = data.election.title + ' – Results';
      document.getElementById('election-title').textContent = data.election.title;
      if (data.election.description) {
        document.getElementById('description-text').textContent = data.election.description;
      }
      const badge = document.getElementById('election-status-badge');
      badge.className = 'badge badge-revealed';
      badge.textContent = 'Results Published';

      const body = document.getElementById('results-body');
      let html = '';

      for (const q of data.questions) {
        const opts = data.results.filter(r => r.question_id === q.id);
        const total = opts.reduce((s, o) => s + parseInt(o.vote_count, 10), 0);
        const maxVotes = Math.max(...opts.map(o => parseInt(o.vote_count, 10)));

        html += '<div class="question-block">';
        html += '<h2>' + escHtml(q.question_text) + '</h2>';

        for (const opt of opts) {
          const count = parseInt(opt.vote_count, 10);
          const pct = total > 0 ? Math.round((count / total) * 100) : 0;
          const isWinner = count > 0 && count === maxVotes && !opt.is_blank;
          const fillClass = opt.is_blank ? 'blank' : (isWinner ? 'winner' : 'normal');
          const nameClass = opt.is_blank ? 'blank' : '';

          html += '<div class="option-row">';
          html += '<div class="option-label">';
          html += '<span class="option-name ' + nameClass + '">' + escHtml(opt.option_text) + (opt.is_blank ? ' (Blank)' : '') + (isWinner ? ' ★' : '') + '</span>';
          html += '<span class="option-stats">' + count + ' votes – ' + pct + '%</span>';
          html += '</div>';
          html += '<div class="bar-track"><div class="bar-fill ' + fillClass + '" style="width:' + pct + '%"></div></div>';
          html += '</div>';
        }

        html += '<p class="total-note">Total votes cast: ' + total + '</p>';
        html += '</div>';
      }

      body.innerHTML = html;
    }

    function renderPending(message) {
      document.getElementById('election-title').textContent = 'Election Results';
      const body = document.getElementById('results-body');
      body.innerHTML = \`
        <div class="pending">
          <div class="icon">🗳️</div>
          <h2>\${escHtml(message || 'Results not yet available')}</h2>
          <p>Voting is still in progress. Results will appear automatically when all votes are counted.</p>
          <div class="spinner"></div>
          <p class="countdown" id="refresh-countdown">Refreshing in <span id="countdown-val">30</span>s…</p>
        </div>
      \`;
      startCountdown();
    }

    function startCountdown() {
      let secs = 30;
      const el = document.getElementById('countdown-val');
      const tick = setInterval(() => {
        secs--;
        if (el) el.textContent = secs;
        if (secs <= 0) {
          clearInterval(tick);
          loadResults();
        }
      }, 1000);
    }

    function escHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    async function loadResults() {
      try {
        const res = await fetch('/results/api/' + ELECTION_ID);
        const data = await res.json();

        if (data.status === 'pending') {
          renderPending(data.message);
        } else if (data.election) {
          renderResults(data);
        } else {
          document.getElementById('results-body').innerHTML = '<div class="error-state"><p>Unable to load results.</p></div>';
        }
      } catch (err) {
        document.getElementById('results-body').innerHTML = '<div class="error-state"><p>Network error. Please refresh.</p></div>';
      }
    }

    loadResults();
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// GET /results/api/:election_id - return JSON results
router.get('/api/:election_id', async (req, res) => {
  try {
    const electionId = parseInt(req.params.election_id, 10);
    if (isNaN(electionId)) {
      return res.status(400).json({ error: 'Invalid election ID' });
    }

    const election = await queries.getElection(electionId);
    if (!election) {
      return res.status(404).json({ error: 'Election not found' });
    }

    if (election.status !== 'revealed') {
      return res.json({
        status: 'pending',
        message: 'Results not yet available',
        electionStatus: election.status
      });
    }

    const questions = await queries.getQuestions(electionId);
    const rawResults = await queries.getResults(electionId);
    const stats = await queries.getVoterStats(electionId);

    return res.json({
      election,
      questions,
      results: rawResults,
      stats
    });
  } catch (err) {
    console.error('Results API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
