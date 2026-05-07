/**
 * AI Expense Monitor — Anomaly Detection Rules (Phase 4)
 *
 * Pure-JS implementation of all four anomaly rules from the project guide.
 * Designed to be pasted into an n8n Code node ("Run Once for All Items"):
 * the function `runAnomalyRules` is environment-agnostic, and the small
 * adapter at the bottom of this file wires it into n8n's `items` / `$()`
 * conventions.
 *
 * Detection is rule-based and deterministic. The LLM is not consulted here;
 * its job (per the guide) is categorization upstream and one-sentence
 * explanation downstream — never detection.
 */

/**
 * Run all four anomaly rules against a batch of new transactions.
 *
 * Each transaction in the returned array carries a `flags` array. A flag is
 * `{ rule, severity, reason, context }`. Zero flags ⇒ normal. A single tx may
 * collect multiple flags (e.g. a brand-new vendor that also duplicates).
 *
 * Expected transaction shape (both arguments):
 *   { tx_id, date: "YYYY-MM-DD", description, amount: number,
 *     vendor: string, category: string }
 *
 * @param {Array<Object>} newTransactions  Rows from the just-uploaded CSV.
 * @param {Array<Object>} history          Prior rows from the Transactions tab.
 *                                         Should span ~6 months for Rule 4.
 * @returns {Array<Object>} New array; inputs are not mutated.
 */
function runAnomalyRules(newTransactions, history) {
  const enriched = newTransactions.map(tx => ({ ...tx, flags: [] }));

  const parseDate = s => new Date(`${String(s).slice(0, 10)}T00:00:00Z`);
  const daysBetween = (a, b) =>
    Math.abs((parseDate(a) - parseDate(b)) / (1000 * 60 * 60 * 24));
  const monthKey = d => String(d).slice(0, 7); // "YYYY-MM"

  // ---------------------------------------------------------------------------
  // Rule 1 — Amount spike vs vendor history
  // ---------------------------------------------------------------------------
  // Threshold: amount > 2 × mean AND amount > mean + 2 × stddev,
  //            computed over the same vendor's last 90 days of history.
  // Guard:     skip vendors with fewer than 3 prior samples (thin data ⇒ noisy).
  // Severity:  high — a real money signal worth waking someone up for.
  // ---------------------------------------------------------------------------
  for (const tx of enriched) {
    const past = history.filter(
      h => h.vendor === tx.vendor && daysBetween(h.date, tx.date) <= 90
    );
    if (past.length < 3) continue;

    const amounts = past.map(p => p.amount);
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const variance =
      amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / amounts.length;
    const stddev = Math.sqrt(variance);

    if (tx.amount > 2 * mean && tx.amount > mean + 2 * stddev) {
      tx.flags.push({
        rule: 'amount_spike',
        severity: 'high',
        reason:
          `${(tx.amount / mean).toFixed(1)}x the 90-day vendor average ` +
          `(€${mean.toFixed(0)}, σ=€${stddev.toFixed(0)}, n=${past.length})`,
        context: { mean, stddev, n: past.length, ratio: tx.amount / mean },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Rule 2 — New vendor
  // ---------------------------------------------------------------------------
  // Threshold: vendor name not present anywhere in history.
  // Severity:  low — most new vendors are legitimate; treat as informational.
  // ---------------------------------------------------------------------------
  const knownVendors = new Set(history.map(h => h.vendor));
  for (const tx of enriched) {
    if (!knownVendors.has(tx.vendor)) {
      tx.flags.push({
        rule: 'new_vendor',
        severity: 'low',
        reason: `First time seeing vendor "${tx.vendor}"`,
        context: { vendor: tx.vendor },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Rule 3 — Duplicate
  // ---------------------------------------------------------------------------
  // Threshold: same vendor AND same amount within 48 hours of any other tx
  //            (history OR another row in the same batch).
  // Severity:  medium — usually a billing glitch, occasionally fraud.
  // ---------------------------------------------------------------------------
  const allRows = [...history, ...enriched];
  for (const tx of enriched) {
    const matches = allRows.filter(
      o =>
        o.tx_id !== tx.tx_id &&
        o.vendor === tx.vendor &&
        Number(o.amount) === Number(tx.amount) &&
        daysBetween(o.date, tx.date) <= 2
    );
    if (matches.length > 0) {
      tx.flags.push({
        rule: 'duplicate',
        severity: 'medium',
        reason:
          `Same vendor and amount (€${Number(tx.amount).toFixed(2)}) ` +
          `charged within 48 hours`,
        context: { matched_tx_ids: matches.map(m => m.tx_id) },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Rule 4 — Category total spike
  // ---------------------------------------------------------------------------
  // Threshold: current-month total spend per category > 2.5 × the trailing
  //            6-month monthly average for that category.
  // Action:    flag ONLY the largest contributing transaction in the offending
  //            category — one alert per spike, not N noisy alerts.
  // Severity:  high — category-level signals usually mean a budget breach.
  // ---------------------------------------------------------------------------
  if (enriched.length > 0) {
    const latestDate = enriched
      .map(t => t.date)
      .reduce((a, b) => (parseDate(a) > parseDate(b) ? a : b));
    const currentKey = monthKey(latestDate);

    const categories = new Set(
      enriched.map(t => t.category).filter(Boolean)
    );

    for (const category of categories) {
      const inCategory = r => r.category === category;
      const inCurrentMonth = r => monthKey(r.date) === currentKey;

      const currentMonthRows = [
        ...history.filter(h => inCategory(h) && inCurrentMonth(h)),
        ...enriched.filter(t => inCategory(t) && inCurrentMonth(t)),
      ];
      const currentMonthTotal = currentMonthRows.reduce(
        (s, r) => s + Number(r.amount),
        0
      );

      const trailingMonthly = {};
      for (const h of history) {
        if (!inCategory(h)) continue;
        const k = monthKey(h.date);
        if (k === currentKey) continue;
        trailingMonthly[k] = (trailingMonthly[k] || 0) + Number(h.amount);
      }
      const trailingTotals = Object.values(trailingMonthly);
      if (trailingTotals.length === 0) continue;
      const trailingAvg =
        trailingTotals.reduce((a, b) => a + b, 0) / trailingTotals.length;

      if (trailingAvg > 0 && currentMonthTotal > 2.5 * trailingAvg) {
        const largest = enriched
          .filter(t => inCategory(t) && inCurrentMonth(t))
          .reduce(
            (best, t) => (best && best.amount >= t.amount ? best : t),
            null
          );
        if (largest) {
          largest.flags.push({
            rule: 'category_spike',
            severity: 'high',
            reason:
              `${category} spend this month (€${currentMonthTotal.toFixed(0)}) ` +
              `is ${(currentMonthTotal / trailingAvg).toFixed(1)}x the ` +
              `6-month average (€${trailingAvg.toFixed(0)})`,
            context: {
              category,
              currentMonthTotal,
              trailingAvg,
              ratio: currentMonthTotal / trailingAvg,
            },
          });
        }
      }
    }
  }

  return enriched;
}

// ---------------------------------------------------------------------------
// Dual-context bottom: n8n Code node adapter OR Node.js export.
// In n8n, `items` and `$` are defined globally — the first branch runs.
// In Node, neither is defined — the function is exported via module.exports.
// ---------------------------------------------------------------------------
if (typeof items !== 'undefined' && typeof $ === 'function') {
  // Assumes an upstream Google Sheets "Read" node named "Read Transactions".
  const newTransactions = items.map(i => i.json);
  const history = $('Read Transactions').all().map(i => i.json);
  const result = runAnomalyRules(newTransactions, history);
  return result.map(tx => ({ json: tx }));
} else if (typeof module !== 'undefined' && module.exports) {
  module.exports = { runAnomalyRules };
}
