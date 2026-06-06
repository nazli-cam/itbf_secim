router.post('/api/send-tokens', requireAdmin, csrfProtection, async (req, res) => {
  try {
    const election = await queries.getActiveElection();
    if (!election) return res.status(404).json({ error: 'No election found' });

    const voters = await queries.getVotersByElection(election.id);
    const unsent = voters.filter(v => !v.token_sent_at);
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

    if (unsent.length === 0) {
      return res.json({ success: true, sent: 0, message: 'All voters have already been sent a token' });
    }

    console.log(`[send-tokens] Starting: ${unsent.length} token(s) to send for election ${election.id}`);

    const results = await emailService.batchSend(unsent, async (voter) => {
      console.log(`[send-tokens] Sending to ${voter.email} (voter id=${voter.id})`);
      await emailService.sendVoteToken(voter.email, voter.vote_token, election.title, baseUrl);
      await queries.markTokenSent(voter.id);
      console.log(`[send-tokens] Sent and marked: ${voter.email}`);
    });

    const failed = results.filter(r => !r.success);
    console.log(`[send-tokens] Done. ${results.length - failed.length} sent, ${failed.length} failed.`);
    if (failed.length > 0) {
      failed.forEach(r => console.error(`[send-tokens] FAILED: ${r.item.email} — ${r.error}`));
    }

    await queries.logAudit('tokens_sent', 'admin', {
      election_id: election.id,
      sent: results.length - failed.length,
      failed: failed.length
    });

    res.json({
      success: true,
      sent: results.length - failed.length,
      failed: failed.length,
      message: `Sent ${results.length - failed.length} token(s)${failed.length > 0 ? `, ${failed.length} failed (check logs)` : ''}`
    });
  } catch (err) {
    console.error('[send-tokens] Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
