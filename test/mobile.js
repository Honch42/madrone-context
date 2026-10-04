'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');

process.env.NODE_ENV = 'test';
process.env.MADRONE_ALLOW_ENV_OVERRIDES = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'madrone-mobile-test-'));
process.env.MADRONE_CONFIG_DIR = path.join(tmp, 'config');
process.env.MADRONE_EXTRA_VAULT_PATHS = os.tmpdir();

const config = require('../src/config');
config.setSetting('workspaceDir', path.join(tmp, 'vault'));
config.setSetting('mediaDir', path.join(tmp, 'media'));
config.setSecret('geminiApiKey', 'test-key');

// Setup mock directory structure
const vaultDir = path.join(tmp, 'vault');
fs.mkdirSync(path.join(vaultDir, 'Core'), { recursive: true });
fs.writeFileSync(path.join(vaultDir, 'Core', 'master_dossier.md'), '# Master Dossier\n\n## Core Principles\n- Value truth over comfort\n');
fs.mkdirSync(path.join(vaultDir, '_Inbox', 'Agent_Hypotheses'), { recursive: true });
fs.writeFileSync(path.join(vaultDir, '_Inbox', 'Agent_Hypotheses', 'test_hypothesis.md'), '---\nsummary: "Refactored Reno House LLC agreement"\n---\n# Reno House LLC\nDetails of refactor.\n');

const deckBuilder = require('../src/deck_builder');
const mobileIngest = require('../src/mobile_ingest');
const serverMod = require('../src/server');

// Mock provider
const mockProvider = {
  transcribe: async (buf, mime) => {
    return 'I decided to reorganize the Reno LLC agreement because the equity allocation needed clarity.';
  },
  oneShot: async (prompt) => {
    if (prompt.includes('brain dump')) {
      return '```json\n' + JSON.stringify({
        title: 'Reno LLC Equity Realization',
        summary: 'Decided to clarify equity allocation in Reno LLC.',
        decisions: ['Restructured Reno LLC equity split'],
        people: [{ name: 'Jerry Fiat', note: 'Partner in Reno LLC' }],
        projects: [{ name: 'Reno House', note: 'LLC holding property' }],
        topics: [{ name: 'Equity Distribution', note: 'Governance' }],
        dossier_updates: ['Prioritizes explicit ownership clarity before capital contribution'],
        follow_up_questions: ['What percentage allocation was finalized?']
      }) + '\n```';
    }
    return '## Executive Summary\nJohn clarified equity splits during the drive session.';
  }
};

async function runTests() {
  console.log('[test/mobile] Starting test suite...');

  // 1. Test buildDeck
  const deck = deckBuilder.buildDeck({ workspaceDir: vaultDir });
  assert(deck.length >= 2, 'Deck should contain at least 2 cards');
  assert(deck[0].is_freeform === true, 'First card must be unprompted brain dump');
  const hypCard = deck.find(c => c.id.startsWith('hyp-test_hypothesis'));
  assert(hypCard, 'Deck should include pending hypothesis card');
  assert(hypCard.question.includes('Reno House LLC'), 'Card should contain hypothesis summary');
  console.log('ok - deck builder parses hypotheses and unprompted dump card');

  // 2. Test logDismissedFeedback
  mobileIngest.logDismissedFeedback(vaultDir, hypCard.id, 'irrelevant');
  const deckAfterDismiss = deckBuilder.buildDeck({ workspaceDir: vaultDir });
  const dismissedFound = deckAfterDismiss.find(c => c.id === hypCard.id);
  assert(!dismissedFound, 'Dismissed card should be excluded from future deck generation');
  console.log('ok - dismissed card logged and excluded from deck');


  // 3. Test processTurn with Unprompted Brain Dump
  const fakeAudio = Buffer.from('RIFF....WAVEfmtFakeAudioData', 'utf-8');
  const turnArgs = {
    sessionId: 'test_session_1',
    cardId: 'freeform-dump',
    turnIndex: 1,
    turnId: 'turn-001',
    audioBuffer: fakeAudio,
    mimeType: 'audio/mp4',
    durationSeconds: 45,
    isFreeform: true,
    provider: mockProvider,
    ctxSettings: { workspaceDir: vaultDir, mediaDir: path.join(tmp, 'media') }
  };
  const turnResult = await mobileIngest.processTurn(turnArgs);

  assert(turnResult.ok === true, 'Turn process should succeed');
  assert(fs.existsSync(turnResult.dumpNotePath), 'Dump markdown note must be written to disk');
  const dumpContent = fs.readFileSync(turnResult.dumpNotePath, 'utf-8');
  assert(dumpContent.includes('Reno LLC Equity Realization'), 'Dump note must contain extracted title');
  assert(dumpContent.includes('Restructured Reno LLC equity split'), 'Dump note must contain decisions');
  assert(dumpContent.includes('Jerry Fiat'), 'Dump note must contain mentioned entities');
  assert(dumpContent.includes('Raw Transcript'), 'Dump note must preserve full raw transcript');
  console.log('ok - unprompted brain dump autonomously extracts insights and writes to Obsidian inbox');

  // 3b. turn_id idempotency: replaying the same turn returns the cached synthesis without re-processing
  const replayResult = await mobileIngest.processTurn({ ...turnArgs, audioBuffer: Buffer.from('DIFFERENT-BYTES-SAME-TURN-ID') });
  assert.strictEqual(replayResult.turnId, turnResult.turnId, 'Replay must resolve to the same turnId');
  assert.strictEqual(replayResult.dumpNotePath, turnResult.dumpNotePath, 'Replay must not produce a second dump note');
  assert.strictEqual(replayResult.mediaPath, turnResult.mediaPath, 'Replay must not re-archive media');
  assert.strictEqual(mobileIngest.getCachedTurn('test_session_1', 'turn-001'), turnResult, 'Cached turn must be retrievable by session/turn id');
  assert.strictEqual(mobileIngest.getCachedTurn('test_session_1', 'never-seen'), null, 'Unknown turn ids are not cached');
  console.log('ok - replayed turn_id is idempotent and returns the cached result');

  // 4. Test Staged Deltas listing
  const stagedItems = mobileIngest.listStagedItems(vaultDir);
  assert(stagedItems.length >= 1, 'Staged deltas should be listed');
  assert(stagedItems[0].dossier_updates.length >= 1, 'Staged item should have candidate dossier updates');
  const dossierPath = path.join(vaultDir, 'Core', 'master_dossier.md');
  const dossierHashAtStaging = crypto.createHash('sha256').update(fs.readFileSync(dossierPath)).digest('hex');
  assert.strictEqual(stagedItems[0].base_hash, dossierHashAtStaging, 'Staged item must record SHA256 base_hash of master_dossier.md');
  assert.strictEqual(stagedItems[0].base_file, 'Core/master_dossier.md', 'Staged item must name the base file');
  assert.strictEqual(mobileIngest.computeDossierHash(vaultDir), dossierHashAtStaging, 'computeDossierHash must match an independent SHA256');
  console.log('ok - candidate dossier updates staged for desktop review with base_hash');

  // 5. Test concludeDriveSession
  const concludeResult = await mobileIngest.concludeDriveSession({
    sessionId: 'test_drive_session_1',
    turns: [
      {
        cardId: 'card-1',
        cardPrompt: 'What drove the Reno decision?',
        transcript: 'We confirmed it was necessary to prevent future deadlock.',
        cardSourceFile: path.join(vaultDir, '_Inbox', 'Agent_Hypotheses', 'test_hypothesis.md'),
        isFreeform: false
      }
    ],
    ctxSettings: { workspaceDir: vaultDir },
    provider: mockProvider
  });

  assert(concludeResult.ok === true, 'Session conclusion must succeed');
  assert(fs.existsSync(concludeResult.notePath), 'Session dossier note must exist');
  const sessionDoc = fs.readFileSync(concludeResult.notePath, 'utf-8');
  assert(sessionDoc.includes('Session: test_drive_session_1'), 'Session note has proper header');
  console.log('ok - session dossier compiled with executive summary');

  // 6. Test Commit Staged Item to Master Dossier
  const commitResult = mobileIngest.commitStagedItem(vaultDir, stagedItems[0].id, stagedItems[0].dossier_updates);
  assert(commitResult.ok === true, 'Commit must succeed');
  const updatedDossier = fs.readFileSync(dossierPath, 'utf-8');
  assert(updatedDossier.includes('Prioritizes explicit ownership clarity'), 'Master dossier must be updated');
  assert.strictEqual(commitResult.base_hash, dossierHashAtStaging, 'Commit must report the base_hash the delta was staged against');
  assert(commitResult.new_base_hash && commitResult.new_base_hash !== dossierHashAtStaging, 'Commit must report the new base hash after appending');
  assert.strictEqual(commitResult.new_base_hash, mobileIngest.computeDossierHash(vaultDir), 'Reported new base hash must match the dossier on disk');
  assert(!fs.existsSync(path.join(vaultDir, '_Inbox', 'Staged_Dossier_Deltas', stagedItems[0].id)), 'Committed item must be removed from staging');
  console.log('ok - human review gate commits staged diffs to Master Dossier');

  // 6b. Stale base detection: dossier edited between staging and commit
  const turn2 = await mobileIngest.processTurn({ ...turnArgs, turnIndex: 2, turnId: 'turn-002' });
  assert(turn2.ok === true, 'Second turn should succeed');
  const stagedForStale = mobileIngest.listStagedItems(vaultDir);
  assert(stagedForStale.length >= 1, 'Second turn should stage a fresh delta');
  const staleItem = stagedForStale[0];
  assert.strictEqual(staleItem.base_hash, mobileIngest.computeDossierHash(vaultDir), 'Fresh staged item must match current dossier hash');
  fs.appendFileSync(dossierPath, '\n- Edited on the desk while a delta was staged\n');
  const staleResult = mobileIngest.commitStagedItem(vaultDir, staleItem.id, staleItem.dossier_updates);
  assert(staleResult.ok === false && staleResult.code === 'STALE_BASE', 'Commit against a changed dossier must be rejected as STALE_BASE');
  assert.strictEqual(staleResult.expected_base_hash, staleItem.base_hash, 'Stale rejection reports the staged base_hash');
  assert.strictEqual(staleResult.current_base_hash, mobileIngest.computeDossierHash(vaultDir), 'Stale rejection reports the current dossier hash');
  assert(fs.existsSync(path.join(vaultDir, '_Inbox', 'Staged_Dossier_Deltas', staleItem.id)), 'Stale item must remain staged');
  const forcedResult = mobileIngest.commitStagedItem(vaultDir, staleItem.id, staleItem.dossier_updates, { force: true });
  assert(forcedResult.ok === true && forcedResult.forced === true, 'Forced commit must succeed and be flagged');
  const missingResult = mobileIngest.commitStagedItem(vaultDir, 'nope.json', []);
  assert(missingResult.ok === false && missingResult.code === 'NOT_FOUND', 'Missing item must report NOT_FOUND');
  console.log('ok - base_hash detects a stale Master Dossier before appending');

  // 7. Test Express Server HTTP Endpoints
  const app = serverMod.createApp();
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const base = `http://127.0.0.1:${port}`;
  const postJson = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // GET /api/deck (generalized) and its /api/mobile/deck alias
  const deckJson = await (await fetch(`${base}/api/deck?surface=hub`)).json();
  assert(deckJson.ok === true && Array.isArray(deckJson.deck), 'API /api/deck should return deck');
  assert.strictEqual(deckJson.surface, 'hub', 'API /api/deck should echo the requested surface');
  const defaultDeckJson = await (await fetch(`${base}/api/deck`)).json();
  assert.strictEqual(defaultDeckJson.surface, 'mobile', 'API /api/deck should default surface to mobile');
  const mobileDeckJson = await (await fetch(`${base}/api/mobile/deck`)).json();
  assert(mobileDeckJson.ok === true && Array.isArray(mobileDeckJson.deck), 'API /api/mobile/deck alias should return deck');
  assert.strictEqual(mobileDeckJson.deck.length, deckJson.deck.length, 'Alias must serve the same deck as /api/deck');

  // Verify HTTP 400 on invalid domain parameter format
  const badDomainRes = await fetch(`${base}/api/deck?domain=bad!domain`);
  assert.strictEqual(badDomainRes.status, 400, 'Invalid domain format must return HTTP 400');
  const badDomainJson = await badDomainRes.json();
  assert.strictEqual(badDomainJson.code, 'INVALID_DOMAIN_PARAMETER');

  // Verify HTTP 404 on unknown domain
  const unknownDomainRes = await fetch(`${base}/api/deck?domain=unknown-briefing-id`);
  assert.strictEqual(unknownDomainRes.status, 404, 'Unknown domain parameter must return HTTP 404');
  const unknownDomainJson = await unknownDomainRes.json();
  assert.strictEqual(unknownDomainJson.code, 'UNKNOWN_DOMAIN');

  // Verify HTTP 403 when host identity is locked to work
  process.env.MADRONE_HOST_ROLE = 'role=work';
  const lockedDeckRes = await fetch(`${base}/api/deck`);
  assert.strictEqual(lockedDeckRes.status, 403, 'Locked work host identity must return HTTP 403');
  const lockedJson = await lockedDeckRes.json();
  assert.strictEqual(lockedJson.code, 'WORK_HOST_IDENTITY_LOCKED');
  delete process.env.MADRONE_HOST_ROLE;

  // Surface routes exist (served bundle or redirect to a fallback frontend)
  for (const route of ['/hub', '/capture']) {
    const r = await fetch(`${base}${route}`, { redirect: 'manual' });
    assert(r.status === 200 || (r.status >= 300 && r.status < 400), `${route} should be routed (got ${r.status})`);
  }

  // Stage a delta, then list and commit it through the generalized endpoints
  const httpStagedTurn = await mobileIngest.processTurn({ ...turnArgs, sessionId: 'http-staged-session', turnId: 'http-staged-turn' });
  assert(httpStagedTurn.ok === true, 'Staging turn should succeed');
  const stagedJson = await (await fetch(`${base}/api/staged`)).json();
  assert(stagedJson.ok === true && Array.isArray(stagedJson.items) && stagedJson.items.length >= 1, 'API /api/staged should list items');
  const mobileStagedJson = await (await fetch(`${base}/api/mobile/staged`)).json();
  assert.strictEqual(mobileStagedJson.items.length, stagedJson.items.length, 'Alias /api/mobile/staged must list the same items');
  const httpItem = stagedJson.items[0];
  assert(httpItem.base_hash, 'Listed staged item must expose base_hash');
  const commitRes = await postJson(`${base}/api/commit_staged`, { item_id: httpItem.id, approved_dossier_updates: httpItem.dossier_updates });
  const commitJson = await commitRes.json();
  assert(commitRes.status === 200 && commitJson.ok === true, 'API /api/commit_staged should commit');
  assert.strictEqual(commitJson.committed, httpItem.dossier_updates.length, 'Commit count must match approved updates');
  assert.strictEqual(commitJson.base_hash, httpItem.base_hash, 'HTTP commit must preserve the staged base_hash');
  const missingRes = await postJson(`${base}/api/mobile/commit_staged`, { item_id: 'does-not-exist.json', approved_dossier_updates: [] });
  assert.strictEqual(missingRes.status, 404, 'Alias commit of a missing item should return 404');
  const noIdRes = await postJson(`${base}/api/commit_staged`, {});
  assert.strictEqual(noIdRes.status, 400, 'Commit without item_id should return 400');

  // POST /api/mobile/turn, then replay the same turn_id
  const postTurn = turnId => fetch(`${base}/api/mobile/turn`, {
    method: 'POST',
    headers: {
      'Content-Type': 'audio/mp4',
      'x-session-id': 'http-test-session',
      'x-card-id': 'freeform',
      'x-turn-index': '1',
      'x-is-freeform': 'true',
      'x-turn-id': turnId
    },
    body: fakeAudio
  }).then(r => r.json());
  const turnJson = await postTurn('http-turn-001');
  assert(turnJson.ok === true, 'API /api/mobile/turn should return ok');
  assert.strictEqual(turnJson.turnId, 'http-turn-001', 'Turn response must carry the turn_id');
  assert(!turnJson.replayed, 'First submission must not be flagged as a replay');
  const replayJson = await postTurn('http-turn-001');
  assert(replayJson.ok === true && replayJson.replayed === true, 'Replayed turn_id must return the cached result flagged as replayed');
  assert.strictEqual(replayJson.turnId, turnJson.turnId, 'Replay must resolve to the same turnId');
  assert.strictEqual(replayJson.mediaPath, turnJson.mediaPath, 'Replay must not re-archive media');
  const jsonl = fs.readFileSync(path.join(vaultDir, 'Core', 'Sessions', 'http-test-session_turns.jsonl'), 'utf-8');
  assert.strictEqual(jsonl.split('\n').filter(l => l.includes('"turnId":"http-turn-001"')).length, 1, 'Replay must not duplicate the durable turn record');

  server.close();
  console.log('ok - HTTP endpoints functional (deck + alias, hub/capture, staged, commit_staged, idempotent turn)');

  console.log('\nAll Madrone Mobile unit and integration tests passed successfully.');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
