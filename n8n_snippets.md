# n8n Workflow Snippets — AI Expense Monitor

Reference for every piece of code or JSON to paste into n8n nodes, in workflow order. Node names referenced in `$('...')` calls assume the names below — rename in your own workflow accordingly.

Workflow shape:
`Drive Trigger → Download → Spreadsheet File (parse CSV) → Normalize → Read Transactions (Sheets) → Dedup → Split in Batches → Categorize HTTP → Categorize-Merge → Rules → IF (flagged?) → Explain HTTP → Format Slack → Slack Post → Sheets Append (both tabs) → Drive Move`

---

## 1. Normalize node — Code node (JavaScript)

Sits right after the CSV parser. Builds a deterministic `tx_id` from filename + row index (this is what makes Phase 2 dedup work), normalizes EU comma-decimals and `DD/MM/YYYY` dates, and stamps `source_file` and `created_at`. Output rows still lack `vendor`/`category` — those come from Phase 3.

```javascript
return items.map((item, idx) => {
  const row = item.json;
  const filename = $('Google Drive Trigger').first().json.name;

  // Handle EU decimal comma
  const amountRaw = String(row.amount).replace(',', '.');
  const amount = parseFloat(amountRaw);

  // Normalize date — try DD/MM/YYYY then fall through (assume already ISO)
  let date = row.date;
  const eu = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
  if (eu) date = `${eu[3]}-${eu[2]}-${eu[1]}`;

  return {
    json: {
      tx_id: `${filename}_${idx}`,
      date,
      description: row.description?.trim() || '',
      amount,
      source_file: filename,
      created_at: new Date().toISOString(),
    }
  };
});
```

---

## 2. Dedup node — Code node (JavaScript)

Sits after Normalize and after a Sheets node named `Read Transactions` that pulls the entire current Transactions tab. Drops any new rows whose `tx_id` already exists in the Sheet — protects against Drive trigger re-fires and manual re-uploads.

```javascript
const existing = new Set(
  $('Read Transactions').all().map(i => i.json.tx_id)
);
return items.filter(item => !existing.has(item.json.tx_id));
```

---

## 3. Categorize prompt — HTTP Request (Anthropic)

Place this **after** an Item Lists "Split in Batches" node configured to batch ~50 items at a time. POSTs each batch to Claude Haiku for vendor/category/confidence. Robustness note: the response is parsed in the next node, where bad JSON is caught.

**Endpoint:** `POST https://api.anthropic.com/v1/messages`

**Headers:**

```
x-api-key: <ANTHROPIC_API_KEY>          ← set via n8n credential, never inline
anthropic-version: 2023-06-01
content-type: application/json
```

**Body (JSON):**

```json
{
  "model": "claude-haiku-4-5-20251001",
  "max_tokens": 4096,
  "messages": [
    {
      "role": "user",
      "content": "You are a financial categorization assistant.\n\nFor each transaction below, return a JSON array of objects with:\n  - tx_id (echo back exactly)\n  - vendor (clean name, e.g., 'AWS' not 'AMAZON WEB SERVICES INC')\n  - category (one of: Cloud Infrastructure, Software / SaaS, Payroll, Travel, Office, Marketing, Professional Services, Subscriptions, Banking Fees, Tax, Other)\n  - confidence (number between 0 and 1)\n\nOutput ONLY the JSON array. No prose, no code fences.\n\nTransactions:\n{{ JSON.stringify($input.all().map(i => ({ tx_id: i.json.tx_id, description: i.json.description, amount: i.json.amount }))) }}"
    }
  ]
}
```

---

## 4. Categorize-merge node — Code node (JavaScript)

Sits immediately after the Categorize HTTP node. Parses the JSON array out of Claude's response and joins `vendor`/`category`/`confidence` back onto the original transactions by `tx_id`. Bad JSON is routed out as a single error item so the downstream Sheets node can append it to a `failures` tab.

```javascript
let categorized = [];
try {
  const responseText = items[0].json.content[0].text;
  categorized = JSON.parse(responseText.trim());
} catch (err) {
  return [{
    json: {
      _error: 'categorize_parse_failed',
      _message: err.message,
      _raw: items[0].json,
    }
  }];
}

const byId = Object.fromEntries(categorized.map(c => [c.tx_id, c]));

// Pull the originals from the upstream batch (rename if your batch node differs)
const originals = $('Split in Batches').all().map(i => i.json);

return originals.map(tx => {
  const c = byId[tx.tx_id] || { vendor: 'Unknown', category: 'Other', confidence: 0 };
  return {
    json: {
      ...tx,
      vendor: c.vendor,
      category: c.category,
      confidence: Number(c.confidence) || 0,
    }
  };
});
```

---

## 5. Rules node — Code node (JavaScript)

Sits after Categorize-Merge. Inlines the full `runAnomalyRules` function (n8n Code nodes can't `require` local files), reads history once from the `Read Transactions` node already in the workflow, and emits each transaction with a `flags` array.

```javascript
function runAnomalyRules(newTransactions, history) {
  const enriched = newTransactions.map(tx => ({ ...tx, flags: [] }));

  const parseDate = s => new Date(`${String(s).slice(0, 10)}T00:00:00Z`);
  const daysBetween = (a, b) =>
    Math.abs((parseDate(a) - parseDate(b)) / (1000 * 60 * 60 * 24));
  const monthKey = d => String(d).slice(0, 7);

  // Rule 1 — Amount spike vs vendor history (>2x mean AND >mean+2σ over 90d, n≥3)
  for (const tx of enriched) {
    const past = history.filter(
      h => h.vendor === tx.vendor && daysBetween(h.date, tx.date) <= 90
    );
    if (past.length < 3) continue;
    const amounts = past.map(p => Number(p.amount));
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

  // Rule 2 — New vendor (informational)
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

  // Rule 3 — Duplicate (same vendor + amount within 48h, history OR same batch)
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

  // Rule 4 — Category total spike (current month >2.5× trailing 6mo average)
  if (enriched.length > 0) {
    const latestDate = enriched
      .map(t => t.date)
      .reduce((a, b) => (parseDate(a) > parseDate(b) ? a : b));
    const currentKey = monthKey(latestDate);
    const categories = new Set(enriched.map(t => t.category).filter(Boolean));

    for (const category of categories) {
      const inCategory = r => r.category === category;
      const inCurrentMonth = r => monthKey(r.date) === currentKey;

      const currentMonthRows = [
        ...history.filter(h => inCategory(h) && inCurrentMonth(h)),
        ...enriched.filter(t => inCategory(t) && inCurrentMonth(t)),
      ];
      const currentMonthTotal = currentMonthRows.reduce(
        (s, r) => s + Number(r.amount), 0
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
              category, currentMonthTotal, trailingAvg,
              ratio: currentMonthTotal / trailingAvg,
            },
          });
        }
      }
    }
  }

  return enriched;
}

// Adapter
const newTransactions = items.map(i => i.json);
const history = $('Read Transactions').all().map(i => ({
  ...i.json,
  amount: Number(i.json.amount),
}));
const result = runAnomalyRules(newTransactions, history);
return result.map(tx => ({ json: tx }));
```

---

## 6. Filter flagged — IF node (expression)

Sits after Rules. The TRUE branch goes on to Explain + Slack; the FALSE branch goes straight to the Sheets Append for the `Transactions` tab. Set the IF node to a single condition, type **Boolean**, comparing the expression to `true`.

```
{{ $json.flags.length > 0 }}
```

---

## 7. Explain prompt — HTTP Request (Anthropic)

One call per flagged transaction (small fan-out — typically a handful per file). Sonnet handles the natural-language explanation; the rule context is injected so the sentence quotes the actual numbers, not vibes.

**Endpoint:** `POST https://api.anthropic.com/v1/messages`

**Headers:** same as section 3.

**Body (JSON):**

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 200,
  "messages": [
    {
      "role": "user",
      "content": "Write a single concise sentence explaining why this transaction was flagged. Be specific. Quote the numbers from the rule context. Do not speculate about fraud or intent.\n\nTransaction: {{ $json.vendor }} — €{{ $json.amount }} on {{ $json.date }}\nFlags: {{ JSON.stringify($json.flags) }}"
    }
  ]
}
```

---

## 8. Format Slack message — Code node (JavaScript)

Sits after the Explain HTTP node. Builds a Slack `attachments` payload with a colored bar matching the highest-severity flag (red/orange/yellow). Wire its output into the Slack "Post Message" node by mapping `channel`, `text`, and `attachments` from `$json`.

```javascript
const tx = $json;
const explanation = $('Explain HTTP').first().json.content[0].text.trim();

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };
const SEVERITY_COLOR = {
  high:   '#dc3545',  // red
  medium: '#fd7e14',  // orange
  low:    '#ffc107',  // yellow
};

const topFlag = tx.flags.reduce(
  (a, b) => (SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a)
);
const ruleList = tx.flags
  .map(f => `\`${f.rule}\` (${f.severity})`)
  .join(', ');

return [{
  json: {
    channel: '#finance-alerts',
    text: `Anomaly: ${tx.vendor} €${Number(tx.amount).toFixed(2)}`,
    attachments: [{
      color: SEVERITY_COLOR[topFlag.severity],
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: '🚨 Anomaly detected' },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Vendor:*\n${tx.vendor}` },
            { type: 'mrkdwn', text: `*Amount:*\n€${Number(tx.amount).toFixed(2)}` },
            { type: 'mrkdwn', text: `*Date:*\n${tx.date}` },
            { type: 'mrkdwn', text: `*Severity:*\n${topFlag.severity.toUpperCase()}` },
          ],
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Rules:* ${ruleList}\n*Reason:* ${explanation}` },
        },
      ],
    }],
  }
}];
```
