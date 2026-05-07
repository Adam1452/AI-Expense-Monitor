/**
 * Local sanity check for runAnomalyRules.
 *
 * Loads seed_history.csv as the historical baseline (already enriched with
 * vendor/category, as if it had already passed through Phase 3 categorization),
 * loads test_statement.csv as raw incoming rows (just date/description/amount,
 * the way they land from a bank export), attaches the vendor/category mapping
 * the LLM would assign, and runs the rules.
 *
 * Run:  node test_rules.js
 */

const fs = require('fs');
const path = require('path');
const { runAnomalyRules } = require('./rules.js');

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const cells = line.split(',');
    const row = {};
    headers.forEach((h, i) => (row[h] = cells[i]));
    return row;
  });
}

// --- Load seed history ------------------------------------------------------
const seedRaw = parseCSV(
  fs.readFileSync(path.join(__dirname, 'seed_history.csv'), 'utf8')
);
const history = seedRaw.map(r => ({
  ...r,
  amount: parseFloat(r.amount),
  confidence: parseFloat(r.confidence),
}));

// --- Load test statement (3-column CSV, as it lands from a bank) ------------
// Stand in for Phase 3 categorization with a hand-written vendor/category map.
const VENDOR_MAP = {
  'Spotify Premium': { vendor: 'Spotify',      category: 'Subscriptions' },
  'Stripe Fee':      { vendor: 'Stripe',       category: 'Banking Fees' },
  'AWS':             { vendor: 'AWS',          category: 'Cloud Infrastructure' },
  'GitHub':          { vendor: 'GitHub',       category: 'Software / SaaS' },
  'Notion':          { vendor: 'Notion',       category: 'Software / SaaS' },
  'Linear App Inc':  { vendor: 'Linear',       category: 'Software / SaaS' },
  'Facebook Ads':    { vendor: 'Facebook Ads', category: 'Marketing' },
};

const testRaw = parseCSV(
  fs.readFileSync(path.join(__dirname, 'test_statement.csv'), 'utf8')
);
const newTransactions = testRaw.map((r, i) => {
  const map = VENDOR_MAP[r.description] || { vendor: r.description, category: 'Other' };
  return {
    tx_id: `test_statement.csv_${i}`,
    date: r.date,
    description: r.description,
    amount: parseFloat(r.amount),
    vendor: map.vendor,
    category: map.category,
  };
});

// --- Run rules --------------------------------------------------------------
const result = runAnomalyRules(newTransactions, history);
const flagged = result.filter(t => t.flags.length > 0);

console.log('═'.repeat(72));
console.log(`Evaluated ${result.length} new tx against ${history.length} history rows`);
console.log(`Flagged: ${flagged.length} of ${result.length}`);
console.log('═'.repeat(72));
console.log();

const SEV_ORDER = { high: 0, medium: 1, low: 2 };

for (const tx of flagged) {
  const amount = `€${tx.amount.toFixed(2)}`;
  console.log(`${tx.date}  ${tx.vendor.padEnd(15)} ${amount.padStart(12)}  (${tx.tx_id})`);
  const sortedFlags = [...tx.flags].sort(
    (a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]
  );
  for (const flag of sortedFlags) {
    console.log(`    [${flag.severity.toUpperCase().padEnd(6)}] ${flag.rule.padEnd(15)}  ${flag.reason}`);
  }
  console.log();
}

// --- Rule coverage summary --------------------------------------------------
const rulesFired = new Set();
for (const tx of flagged) for (const f of tx.flags) rulesFired.add(f.rule);
const allRules = ['amount_spike', 'new_vendor', 'duplicate', 'category_spike'];

console.log('─'.repeat(72));
console.log('Rule coverage:');
for (const rule of allRules) {
  const mark = rulesFired.has(rule) ? 'OK ' : '-- ';
  console.log(`  ${mark}  ${rule}`);
}
console.log('─'.repeat(72));
