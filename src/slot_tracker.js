'use strict';

/**
 * Computes authoritative adjudication status in code, enforcing that no card
 * can be marked "resolved" if required slots or sub-questions remain unfilled.
 *
 * States:
 * - 'resolved': All required slots filled, core answered, no material contradiction.
 * - 'partially_resolved': Core answered, but 1 or more required slots are missing.
 * - 'premise_rejected': Speaker disputes or rejects the card's framing.
 * - 'deferred': Speaker explicitly punts ("ask me later", "check with CPA").
 * - 'contradicted': Severe conflict with prior decisions or unverified math constraint.
 */
function computeAdjudicationStatus({
  card,
  transcript = '',
  extraction = {},
  contradictions = []
}) {
  const tLower = (transcript || '').toLowerCase().trim();

  // 1. Check for premise rejection
  const premise = extraction.premise || {};
  const isPremiseRejected = premise.accepted === false ||
    /\b(i don't think we need to (freeze|do|choose)|reject that premise|neither|that's the wrong question|not freezing)\b/i.test(tLower);

  if (isPremiseRejected) {
    return {
      status: 'premise_rejected',
      reason: 'Speaker disputed the premise of the card.',
      missingSlots: [],
      slots: extraction.slots || {}
    };
  }

  // 2. Check for explicit deferral / punt
  const isDeferred = /\b(ask me later|talk to (the )?cpa|haven't looked yet|let's defer|punt on this|not sure yet|skip this)\b/i.test(tLower);
  if (isDeferred && tLower.length < 100) {
    return {
      status: 'deferred',
      reason: 'Speaker explicitly deferred or skipped answering.',
      missingSlots: [],
      slots: extraction.slots || {}
    };
  }

  // 3. Check for severe contradictions
  const blockingContradiction = contradictions.find(c => c.severity === 'blocking' || c.severity === 'material');
  if (blockingContradiction) {
    return {
      status: 'contradicted',
      reason: blockingContradiction.note || 'Contradiction with prior decisions or math limit detected.',
      missingSlots: [],
      slots: extraction.slots || {}
    };
  }

  // 4. Evaluate Slots
  const expectedSlots = (card && card.expects && Array.isArray(card.expects.slots))
    ? card.expects.slots
    : [];

  const extractedSlots = (extraction.answer && extraction.answer.slots) || extraction.slots || {};

  // Infer slots from transcript if not already populated in extraction
  // E.g., looking for month/year or date indicators
  const filledSlots = {};
  const missingSlots = [];

  for (const s of expectedSlots) {
    const slotName = s.name;
    const isRequired = s.required !== false;
    let slotVal = extractedSlots[slotName] ? extractedSlots[slotName].value ?? extractedSlots[slotName] : null;

    // Regex fallback heuristics for common slot types
    if (slotVal == null) {
      if (s.type === 'date' || slotName.includes('date') || slotName.includes('year')) {
        const yearMatch = tLower.match(/\b(202[5-9]|203[0-5])\b/);
        if (yearMatch) slotVal = yearMatch[1];
      }
      if (slotName.includes('month')) {
        const monthMatch = tLower.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i);
        if (monthMatch) slotVal = monthMatch[1];
      }
      if (slotName.includes('state')) {
        if (tLower.includes('nevada')) slotVal = 'Nevada';
        else if (tLower.includes('california')) slotVal = 'California';
      }
    }

    if (slotVal != null && slotVal !== '') {
      filledSlots[slotName] = slotVal;
    } else if (isRequired) {
      missingSlots.push(s);
    }
  }

  // If card has explicit required slots and some are missing:
  if (expectedSlots.length > 0 && missingSlots.length > 0) {
    return {
      status: 'partially_resolved',
      reason: `Answered core, but missing required slot(s): ${missingSlots.map(m => m.name).join(', ')}.`,
      missingSlots: missingSlots.map(m => m.name),
      slots: filledSlots,
      elicitPrompt: missingSlots[0].elicit_if_missing || `Can you specify the ${missingSlots[0].name}?`
    };
  }

  // If question was multi-part and asked for date/deadline and none was stated:
  const cardPromptLower = (card && card.question ? card.question : '').toLowerCase();
  const asksDateOrDeadline = cardPromptLower.includes('what date') || cardPromptLower.includes('deadline');
  const hasDateStated = /\b(202[5-9]|january|february|march|april|may|june|july|august|september|october|november|december|q[1-4]|summer|spring|fall|winter)\b/i.test(tLower);

  if (asksDateOrDeadline && !hasDateStated) {
    return {
      status: 'partially_resolved',
      reason: 'Question asked for a date/deadline, but no timing was provided in response.',
      missingSlots: ['timing_deadline'],
      slots: filledSlots,
      elicitPrompt: 'What is the specific target date or deadline for that?'
    };
  }

  return {
    status: 'resolved',
    reason: 'Core question answered and all required parameters provided.',
    missingSlots: [],
    slots: filledSlots
  };
}

module.exports = {
  computeAdjudicationStatus
};
