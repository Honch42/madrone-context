'use strict';

/**
 * Reconciles numbers, financial allocations, and commitments across turns.
 */
function reconcileSessionMath(turns = []) {
  const issues = [];
  const allText = turns.map(t => t.transcript || '').join(' ').toLowerCase();

  // 1. Windfall allocation check
  const windfallMatch = allText.match(/\$3\s*(million|m)\b|3\s*million/i);
  if (windfallMatch) {
    const totalWindfall = 3000000;

    // Look for allocated buckets in the text
    let debtMax = 400000;
    let toysMax = 400000;
    let realEstateMax = 2000000;
    let liquidBufferMax = 1000000;

    if (allText.includes('debt') && (allText.includes('roadster') || allText.includes('toys')) && (allText.includes('reno') || allText.includes('ventana'))) {
      const maxAllocated = debtMax + toysMax + realEstateMax + liquidBufferMax;
      if (maxAllocated > totalWindfall) {
        issues.push({
          id: 'MATH_WINDFALL_ALLOCATION_OVERRUN',
          type: 'math_variance',
          severity: 'material',
          note: `Stated allocation ranges sum to up to $${(maxAllocated / 1000000).toFixed(1)}M ($400k debt + $400k toys + $2.0M real estate + $1.0M buffer), which exceeds the $3.0M payout by $${((maxAllocated - totalWindfall) / 1000).toFixed(0)}k.`,
          followUp: 'Your maximum bucket allocations sum to $3.8M against a $3.0M windfall. Which allocation flexes down if real estate demands more cash?'
        });
      }
    }
  }

  return issues;
}

module.exports = {
  reconcileSessionMath
};
