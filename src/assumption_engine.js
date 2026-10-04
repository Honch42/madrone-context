'use strict';

const ASSUMPTION_RULES = [
  {
    id: 'TAX_MORTGAGE_INTEREST_CAP',
    domain: 'tax',
    pattern: /\b(higher|maximize|large(r)?)\s+(amount\s+of\s+)?mortgage\b.*\b(tax\s+(benefit|deduction)|deduction)\b/i,
    flag: 'UNVERIFIED_ASSUMPTION',
    severity: 'material',
    note: 'IRC § 163(h)(3) caps acquisition debt interest deduction at $750,000. Mortgages above $750k yield zero incremental deduction on personal return.',
    followUp: 'Federal mortgage interest deduction is capped at $750k acquisition debt. Does that alter your target loan balance?'
  },
  {
    id: 'TAX_SCHEDULE_E_RENTAL_ALLOCATION',
    domain: 'tax',
    pattern: /\b(rent(ed|ing)?\s+out|rental\s+income|rented\b.*\b(another|family))\b/i,
    flag: 'TAX_STRUCTURING_CHECK',
    severity: 'material',
    note: 'Mortgage interest and expenses on the rented main home must be allocated to Schedule E (rental property), not personal Schedule A itemized deductions.',
    followUp: 'Has your CPA confirmed the Schedule E vs personal residence expense allocation formula?'
  },
  {
    id: 'LEGAL_CA_FTB_CLOSEST_CONNECTIONS',
    domain: 'legal',
    pattern: /\b(nevada|nv)\b.*\b(weekly|regular)\b.*\b(california|ca)\b/i,
    flag: 'AUDIT_RISK_EXPOSURE',
    severity: 'material',
    note: 'California FTB applies the "closest connections" test. Regular weekly presence to see a minor child plus leased metro space represents substantial audit nexus regardless of day count.',
    followUp: 'Between weekly visits to Pax and a leased CA space, what is your annual California day count ceiling?'
  },
  {
    id: 'VENTANA_HOLD_VS_IPO_WAVE_TENSION',
    domain: 'strategy',
    pattern: /\b(hold(\s+la\s+ventana)?\s+forever|not\s+looking\s+at.*return)\b/i,
    flag: 'STRATEGIC_ALIGNMENT_CHECK',
    severity: 'low',
    note: 'Ventana was prioritized in turn 3 to "front-run OpenAI/Anthropic IPO wealth waves" (appreciation/demand wave), but later noted as hold-forever for cash-flow neutrality.',
    followUp: 'Is Ventana an equity appreciation play or strictly a break-even lifestyle hub?'
  }
];

/**
 * Evaluates transcript and extraction against assumption rules.
 */
function evaluateAssumptions(transcript = '', context = {}) {
  const flags = [];
  const text = String(transcript);

  for (const rule of ASSUMPTION_RULES) {
    if (rule.pattern.test(text)) {
      flags.push({
        id: rule.id,
        domain: rule.domain,
        flag: rule.flag,
        severity: rule.severity,
        note: rule.note,
        followUp: rule.followUp
      });
    }
  }

  // Check for combined cross-turn FTB risk
  const allTurnsText = (context.allSessionTurnsText || text).toLowerCase();
  if (allTurnsText.includes('nevada') && allTurnsText.includes('pax') && allTurnsText.includes('lease') && allTurnsText.includes('california')) {
    if (!flags.some(f => f.id === 'LEGAL_CA_FTB_CLOSEST_CONNECTIONS')) {
      flags.push({
        id: 'LEGAL_CA_FTB_CLOSEST_CONNECTIONS',
        domain: 'legal',
        flag: 'AUDIT_RISK_EXPOSURE',
        severity: 'material',
        note: 'Combined session context shows Nevada domicile target + weekly California visits + leased CA space. FTB closest-connections audit defense required.',
        followUp: 'What specific steps will be taken to audit-proof the CA-NV residency split against FTB scrutiny?'
      });
    }
  }

  return flags;
}

module.exports = {
  ASSUMPTION_RULES,
  evaluateAssumptions
};
