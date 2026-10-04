'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Common English words and known safe words to ignore during novel entity scanning.
 */
const COMMON_DICTIONARY = new Set([
  'i', 'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'because', 'as', 'what', 'when',
  'where', 'who', 'why', 'how', 'this', 'that', 'these', 'those', 'my', 'your', 'his', 'her',
  'its', 'our', 'their', 'we', 'you', 'he', 'she', 'it', 'they', 'in', 'on', 'at', 'to', 'for',
  'with', 'from', 'by', 'about', 'into', 'through', 'after', 'over', 'between', 'out', 'up',
  'down', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
  'did', 'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'reno',
  'california', 'nevada', 'tahoe', 'lake', 'us', 'usa', 'llc', 'cpa', 'ftb', 'roadster',
  'barndominium', 'tesla', 'synergy', 'anthropic', 'openai', 'ipo', 'january', 'february',
  'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'well', 'yeah', 'yes', 'no', 'let', 'so', 'oh', 'ok', 'okay', 'again', 'also', 'just', 'now',
  'right', 'really', 'actually', 'probably', 'maybe', 'think', 'know', 'see', 'look', 'mean',
  'good', 'bad', 'great', 'new', 'old', 'way', 'much', 'more', 'less', 'too', 'very', 'like',
  'get', 'got', 'make', 'made', 'take', 'took', 'come', 'came', 'go', 'went', 'say', 'said',
  'tell', 'told', 'give', 'given', 'find', 'found', 'keep', 'kept', 'put', 'set', 'run', 'need',
  'want', 'use', 'using', 'used', 'try', 'trying', 'work', 'working', 'help', 'start', 'end',
  'call', 'talk', 'turn', 'point', 'thing', 'things', 'lot', 'lots', 'bit', 'kind', 'sort',
  "i'm", "i'd", "i've", "i'll", "it's", "that's", "there's", "here's", "what's", "don't",
  "doesn't", "didn't", "won't", "wouldn't", "can't", "couldn't", "shouldn't",
  'fable', 'astra', 'gemini', 'antigravity', 'madrone', 'claude', 'chatgpt'
]);

/**
 * Detects low-confidence transcriptions and unverified assumptions.
 * Holds them as 'unknown' and automatically formats clarification questions.
 */
function detectUncertainties({
  transcript = '',
  extraction = {},
  assumptions = [],
  knownEntities = new Set()
}) {
  const uncertainties = [];
  const text = String(transcript);

  // 1. Scan for unverified material assumptions (e.g. tax limits, audit risk)
  for (const asm of assumptions) {
    if (asm.severity === 'material' || asm.severity === 'blocking') {
      uncertainties.push({
        id: `unc_asm_${asm.id.toLowerCase()}`,
        kind: 'assumption_verification',
        topic: asm.domain,
        flag: asm.flag,
        suspectToken: asm.domain,
        contextQuote: asm.note,
        question: asm.followUp || `We flagged an unverified assumption regarding ${asm.domain}: "${asm.note}". Would you like to confirm or adjust this?`,
        status: 'held_as_unknown'
      });
    }
  }

  // 2. Scan for novel proper nouns / phonetically suspect capitalized words
  // Only inspect mid-sentence tokens (skip sentence-initial capitalized words)
  const wordRegex = /\b[A-Z][a-zA-Z0-9'-]*\b/g;
  const seenWords = new Set();
  const normalizedKnown = new Set();
  if (knownEntities && knownEntities.forEach) {
    knownEntities.forEach(e => normalizedKnown.add(String(e).toLowerCase().trim()));
  }

  let match;
  while ((match = wordRegex.exec(text)) !== null) {
    const w = match[0];
    const idx = match.index;

    // Check if sentence-initial: look backwards for preceding terminal punctuation
    const preceding = text.slice(Math.max(0, idx - 5), idx).trim();
    const isSentenceInitial = idx === 0 || preceding === '' || /[.!?\n\r"']$/.test(preceding);
    if (isSentenceInitial) continue;

    const wLower = w.toLowerCase();
    if (COMMON_DICTIONARY.has(wLower) || seenWords.has(wLower)) continue;
    if (normalizedKnown.has(wLower)) continue;
    seenWords.add(wLower);

    // If word is unknown and appears mid-sentence, hold as unknown
    uncertainties.push({
      id: `unc_token_${wLower}_${crypto.createHash('sha1').update(text).digest('hex').slice(0, 6)}`,
      kind: 'transcription_uncertainty',
      topic: 'Vocabulary Verification',
      flag: 'LOW_CONFIDENCE_TRANSCRIPTION',
      suspectToken: w,
      contextQuote: text.slice(Math.max(0, idx - 30), Math.min(text.length, idx + 60)).trim(),
      question: `In a recent session, you mentioned "${w}". Was "${w}" transcribed correctly, or did you say something else?`,
      status: 'held_as_unknown'
    });

    if (uncertainties.length >= 3) break; // Hard ceiling of 3 cards per session
  }

  return uncertainties.slice(0, 3);
}

/**
 * Surfaces detected uncertainties into the Agent Hypotheses queue as actionable follow-up cards
 * so they automatically appear in the next session's deck without requiring manual user auditing.
 */
function surfaceUncertaintiesToDeskQueue(workspaceDir, sessionId, uncertainties = []) {
  if (!uncertainties.length) return [];

  const hypothesesDir = path.join(workspaceDir, '_Inbox', 'Agent_Hypotheses');
  if (!fs.existsSync(hypothesesDir)) {
    fs.mkdirSync(hypothesesDir, { recursive: true });
  }

  const generatedCards = [];

  for (const unc of uncertainties) {
    const safeId = unc.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `99_clarify_${safeId}.md`;
    const filePath = path.join(hypothesesDir, filename);

    // If already exists, do not overwrite
    if (fs.existsSync(filePath)) continue;

    const fileContent = [
      '---',
      `id: "${safeId}"`,
      `badge: "CLARIFICATION: UNKNOWN"`,
      `type: "clarification"`,
      `priority: 95`,
      `source: "Uncertainty Detector"`,
      `session_id: "${sessionId}"`,
      `status: "pending_clarification"`,
      `suspect_token: "${unc.suspectToken}"`,
      `epistemic_state: "held_as_unknown"`,
      '---',
      '',
      `### Spoken Prompt`,
      unc.question,
      '',
      `### Context`,
      `- **Flag**: ${unc.flag || 'LOW_CONFIDENCE_TRANSCRIPTION'}`,
      `- **Original Quote**: "${unc.contextQuote}"`,
      `- **Current State**: Held as unknown. Ground truth will not be updated until confirmed.`
    ].join('\n');

    fs.writeFileSync(filePath, fileContent, 'utf-8');
    generatedCards.push(filePath);
  }

  return generatedCards;
}

module.exports = {
  detectUncertainties,
  surfaceUncertaintiesToDeskQueue,
  COMMON_DICTIONARY
};
