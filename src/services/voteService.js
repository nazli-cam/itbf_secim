const pool = require('../db/pool');
const queries = require('../db/queries');
const emailService = require('./emailService');
require('dotenv').config();

function randomDelay() {
  const ms = Math.floor(Math.random() * 5000);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function submitVote(electionId, q1OptionId, q2OptionId, voterEmail) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Acquire advisory lock (transaction-scoped)
    const lockId = electionId * 1000 + 1;
    await client.query('SELECT pg_advisory_xact_lock($1)', [lockId]);

    // Verify voter
    const voterResult = await client.query(
      'SELECT * FROM voters WHERE election_id = $1 AND email = $2',
      [parseInt(electionId, 10), voterEmail.toLowerCase()]
    );

    const voterRow = voterResult.rows[0];

    if (!voterRow) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Email not found in voter list' };
    }

    if (voterRow.has_voted) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Already voted' };
    }

    // Mark voter as voted
    await client.query(
      'UPDATE voters SET has_voted = TRUE WHERE id = $1',
      [voterRow.id]
    );

    // Random delay to prevent timing correlation
    await randomDelay();

    // Get questions for this election
    const questionsResult = await client.query(
      'SELECT * FROM questions WHERE election_id = $1 ORDER BY question_order ASC',
      [electionId]
    );
    const questions = questionsResult.rows;

    if (questions.length < 2) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Election configuration error' };
    }

    const q1 = questions.find((q) => q.question_order === 1);
    const q2 = questions.find((q) => q.question_order === 2);

    if (!q1 || !q2) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Election configuration error' };
    }

    // Insert vote for Q1
    await client.query(
      'INSERT INTO votes (election_id, question_id, option_id) VALUES ($1, $2, $3)',
      [electionId, q1.id, q1OptionId]
    );

    // Insert vote for Q2
    await client.query(
      'INSERT INTO votes (election_id, question_id, option_id) VALUES ($1, $2, $3)',
      [electionId, q2.id, q2OptionId]
    );

    // Check if all voters have voted
    const statsResult = await client.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE has_voted = TRUE) AS voted
       FROM voters WHERE election_id = $1`,
      [electionId]
    );

    const total = parseInt(statsResult.rows[0].total, 10);
    const voted = parseInt(statsResult.rows[0].voted, 10);
    const isLastVoter = voted >= total;

    if (isLastVoter) {
      await client.query(
        "UPDATE elections SET status = 'revealed' WHERE id = $1",
        [electionId]
      );
    }

    await client.query('COMMIT');

    // Log the vote (no voter identity)
    await queries.logAudit('vote_submitted', 'anonymous', {
      election_id: electionId,
      all_voted: isLastVoter
    });

    if (isLastVoter) {
      // Trigger auto-reveal asynchronously
      setImmediate(() => triggerAutoReveal(electionId));
    }

    return { success: true, isLastVoter };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Vote submission error:', err);
    throw err;
  } finally {
    client.release();
  }
}

async function triggerAutoReveal(electionId) {
  try {
    const election = await queries.getElection(electionId);
    if (!election) return;

    const rawResults = await queries.getResults(electionId);
    const questionsMap = {};

    for (const row of rawResults) {
      if (!questionsMap[row.question_id]) {
        questionsMap[row.question_id] = {
          question_id: row.question_id,
          question_text: row.question_text,
          question_order: row.question_order,
          options: []
        };
      }
      questionsMap[row.question_id].options.push({
        option_id: row.option_id,
        option_text: row.option_text,
        option_order: row.option_order,
        is_blank: row.is_blank,
        vote_count: row.vote_count
      });
    }

    const questionsWithResults = Object.values(questionsMap).sort(
      (a, b) => a.question_order - b.question_order
    );

    const voters = await queries.getVotersByElection(electionId);
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

    // Send results to all voters
    await emailService.batchSend(voters, async (voter) => {
      await emailService.sendResults(voter.email, questionsWithResults, election);
    });

    // Send admin completion
    await emailService.sendAdminCompletion(election, questionsWithResults);

    await queries.logAudit('election_revealed', 'system', {
      election_id: electionId,
      voter_count: voters.length
    });

    console.log(`Auto-reveal complete for election ${electionId}`);
  } catch (err) {
    console.error('Auto-reveal error:', err);
  }
}

module.exports = { submitVote, triggerAutoReveal };
