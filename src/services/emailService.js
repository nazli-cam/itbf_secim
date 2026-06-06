const nodemailer = require('nodemailer');
require('dotenv').config();

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

async function sendVoteToken(email, token, electionTitle, baseUrl) {
  const transporter = createTransporter();
  const voteUrl = `${baseUrl}/vote/${token}`;

  await transporter.sendMail({
    from: `"Election System" <${process.env.FROM_EMAIL}>`,
    to: email,
    subject: `Your Voting Link – ${electionTitle}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">You have been invited to vote</h2>
        <p>You have been invited to participate in the election: <strong>${electionTitle}</strong></p>
        <p>Please click the link below to cast your secret ballot:</p>
        <p style="text-align: center; margin: 30px 0;">
          <a href="${voteUrl}"
             style="background-color: #3498db; color: white; padding: 14px 28px;
                    text-decoration: none; border-radius: 6px; font-size: 16px;">
            Cast Your Vote
          </a>
        </p>
        <p style="color: #7f8c8d; font-size: 13px;">
          This link is unique to you. Do not share it with others.<br>
          If the button does not work, copy and paste this URL into your browser:<br>
          <a href="${voteUrl}">${voteUrl}</a>
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
        <p style="color: #bdc3c7; font-size: 12px;">This is an automated message from the election system.</p>
      </div>
    `
  });
}

async function sendReminder(email, token, electionTitle, baseUrl) {
  const transporter = createTransporter();
  const voteUrl = `${baseUrl}/vote/${token}`;

  await transporter.sendMail({
    from: `"Election System" <${process.env.FROM_EMAIL}>`,
    to: email,
    subject: `Reminder: You haven't voted yet – ${electionTitle}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #e67e22;">Voting Reminder</h2>
        <p>This is a reminder that you have not yet cast your vote in: <strong>${electionTitle}</strong></p>
        <p>Please click the link below to cast your secret ballot:</p>
        <p style="text-align: center; margin: 30px 0;">
          <a href="${voteUrl}"
             style="background-color: #e67e22; color: white; padding: 14px 28px;
                    text-decoration: none; border-radius: 6px; font-size: 16px;">
            Vote Now
          </a>
        </p>
        <p style="color: #7f8c8d; font-size: 13px;">
          This link is unique to you. Do not share it with others.<br>
          If the button does not work, copy and paste this URL into your browser:<br>
          <a href="${voteUrl}">${voteUrl}</a>
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
        <p style="color: #bdc3c7; font-size: 12px;">This is an automated message from the election system.</p>
      </div>
    `
  });
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
      optionRows += `
        <tr>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${label}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee; text-align: right;">${count}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee; text-align: right;">${pct}%</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee; width: 200px;">
            <div style="background: #ecf0f1; border-radius: 4px; height: 16px;">
              <div style="background: #3498db; width: ${pct}%; height: 16px; border-radius: 4px;"></div>
            </div>
          </td>
        </tr>
      `;
    }

    questionBlocks += `
      <h3 style="color: #2c3e50; margin-top: 24px;">${q.question_text}</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <thead>
          <tr style="background: #f8f9fa;">
            <th style="padding: 8px 12px; text-align: left;">Option</th>
            <th style="padding: 8px 12px; text-align: right;">Votes</th>
            <th style="padding: 8px 12px; text-align: right;">%</th>
            <th style="padding: 8px 12px;">Distribution</th>
          </tr>
        </thead>
        <tbody>${optionRows}</tbody>
      </table>
      <p style="color: #7f8c8d; font-size: 12px;">Total votes: ${totalVotes}</p>
    `;
  }

  return `
    <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
      <h2 style="color: #2c3e50;">Election Results: ${election.title}</h2>
      ${election.description ? `<p>${election.description}</p>` : ''}
      ${questionBlocks}
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
      <p style="color: #bdc3c7; font-size: 12px;">This is an automated message from the election system.</p>
    </div>
  `;
}

async function sendResults(email, questionsWithResults, election) {
  const transporter = createTransporter();
  const html = buildResultsHtml(election, questionsWithResults);

  await transporter.sendMail({
    from: `"Election System" <${process.env.FROM_EMAIL}>`,
    to: email,
    subject: `Election Results – ${election.title}`,
    html
  });
}

async function sendAdminCompletion(election, questionsWithResults) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return;

  const transporter = createTransporter();
  const html = buildResultsHtml(election, questionsWithResults);

  await transporter.sendMail({
    from: `"Election System" <${process.env.FROM_EMAIL}>`,
    to: adminEmail,
    subject: `[ADMIN] Election Complete – ${election.title}`,
    html: `<p><strong>All votes have been received. The election is now complete.</strong></p>${html}`
  });
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
