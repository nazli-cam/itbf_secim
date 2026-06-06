require('dotenv').config();

async function sendEmail(to, subject, html) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SMTP_PASS}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL,
      to,
      subject,
      html
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function sendVoteToken(email, token, electionTitle, baseUrl) {
  const voteUrl = `${baseUrl}/vote/${token}`;
  await sendEmail(email, `Your Voting Link – ${electionTitle}`, `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #2c3e50;">You have been invited to vote</h2>
      <p>You have been invited to participate in: <strong>${electionTitle}</strong></p>
      <p style="text-align: center; margin: 30px 0;">
        <a href="${voteUrl}" style="background-color: #3498db; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-size: 16px;">Cast Your Vote</a>
      </p>
      <p style="color: #7f8c8d; font-size: 13px;">This link is unique to you. Do not share it.<br><a href="${voteUrl}">${voteUrl}</a></p>
    </div>
  `);
}

async function sendReminder(email, token, electionTitle, baseUrl) {
  const voteUrl = `${baseUrl}/vote/${token}`;
  await sendEmail(email, `Reminder: You haven't voted yet – ${electionTitle}`, `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #e67e22;">Voting Reminder</h2>
      <p>You have not yet voted in: <strong>${electionTitle}</strong></p>
      <p style="text-align: center; margin: 30px 0;">
        <a href="${voteUrl}" style="background-color: #e67e22; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-size: 16px;">Vote Now</a>
      </p>
      <p style="color: #7f8c8d; font-size: 13px;">This link is unique to you.<br><a href="${voteUrl}">${voteUrl}</a></p>
    </div>
  `);
}

function buildResultsHtml(election, questionsWithResults) {
  let questionBlocks = '';
  for (const q of questionsWithResults) {
    const totalVotes = q.options.reduce((sum, o) => sum + parseInt(o.vote_count, 10), 0);
    let optionRows = '';
    for (const o of q.options) {
      const count = parseInt(o.vote_count, 10);
      const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
      const label = o.is_blank ? `<em>${o.option_text} (Blank)</em>` : o.option_text;
      optionRows += `<tr>
        <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${label}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #eee; text-align: right;">${count}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #eee; text-align: right;">${pct}%</td>
      </tr>`;
    }
    questionBlocks += `<h3 style="color: #2c3e50; margin-top: 24px;">${q.question_text}</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <thead><tr style="background: #f8f9fa;">
          <th style="padding: 8px 12px; text-align: left;">Option</th>
          <th style="padding: 8px 12px; text-align: right;">Votes</th>
          <th style="padding: 8px 12px; text-align: right;">%</th>
        </tr></thead>
        <tbody>${optionRows}</tbody>
      </table>
      <p style="color: #7f8c8d; font-size: 12px;">Total votes: ${totalVotes}</p>`;
  }
  return `<div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
    <h2 style="color: #2c3e50;">Election Results: ${election.title}</h2>
    ${election.description ? `<p>${election.description}</p>` : ''}
    ${questionBlocks}
    <p style="color: #bdc3c7; font-size: 12px;">Automated message from the election system.</p>
  </div>`;
}

async function sendResults(email, questionsWithResults, election) {
  const html = buildResultsHtml(election, questionsWithResults);
  await sendEmail(email, `Election Results – ${election.title}`, html);
}

async function sendAdminCompletion(election, questionsWithResults) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return;
  const html = buildResultsHtml(election, questionsWithResults);
  await sendEmail(adminEmail, `[ADMIN] Election Complete – ${election.title}`,
    `<p><strong>All votes have been received.</strong></p>${html}`);
}

async function batchSend(items, sendFn) {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const results = [];
  for (const item of items) {
    try {
      await sendFn(item);
      results.push({ item, success: true });
    } catch (err) {
      console.error('Email send error:', err.message);
      results.push({ item, success: false, error: err.message });
    }
    await delay(500);
  }
  return results;
}

module.exports = {
  sendVoteToken,
  sendReminder,
  sendResults,
  sendAdminCompletion,
  batchSend
};
