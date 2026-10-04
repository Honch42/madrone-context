'use strict';

const DECIDED_REGEX = /\b(decided|committed|we're doing|it's going to be|final answer|locked in|definitely)\b/i;
const LEANING_REGEX = /\b(probably|leaning|most likely|i think|i'd say|likely|unless|tentatively|for now|my sense is|potentially|seems like)\b/i;
const OPEN_REGEX    = /\b(undecided|haven't decided|not sure|still thinking|could go either way|open question|don't know|no idea)\b/i;

/**
 * Computes deterministic lexical prior for stance.
 */
function lexicalStancePrior(text) {
  if (!text || typeof text !== 'string') return 'open';
  if (OPEN_REGEX.test(text)) return 'open';
  if (LEANING_REGEX.test(text) && !DECIDED_REGEX.test(text)) return 'leaning';
  if (DECIDED_REGEX.test(text) && !LEANING_REGEX.test(text)) return 'decided';
  // If ambiguous or leaning marker exists even alongside strong words, default to leaning
  if (LEANING_REGEX.test(text)) return 'leaning';
  return null;
}

/**
 * Reconciles model-proposed stance with deterministic lexical prior.
 * Invariant: Can DOWNGRADE stance from decided -> leaning -> open, NEVER upgrade.
 */
function reconcileStance(proposedStance, transcript) {
  const prior = lexicalStancePrior(transcript);
  const normalized = (proposedStance || '').toLowerCase();

  // If model says decided but lexical signals indicate hesitation/leaning/open:
  if (normalized === 'decided' && (prior === 'leaning' || prior === 'open')) {
    return {
      stance: prior,
      source: 'lexical_override',
      note: `Downgraded from decided to ${prior} due to lexical hedge markers.`
    };
  }

  if (normalized === 'leaning' && prior === 'open') {
    return {
      stance: 'open',
      source: 'lexical_override',
      note: 'Downgraded from leaning to open due to explicit indecision markers.'
    };
  }

  const finalStance = ['decided', 'leaning', 'open'].includes(normalized)
    ? normalized
    : (prior || 'leaning');

  return {
    stance: finalStance,
    source: normalized ? 'model' : 'lexical_default',
    note: ''
  };
}

module.exports = {
  lexicalStancePrior,
  reconcileStance,
  DECIDED_REGEX,
  LEANING_REGEX,
  OPEN_REGEX
};
