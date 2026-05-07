# AI Expense Monitor

An event-driven financial monitoring system. Drop a bank statement CSV into a watched Google Drive folder; within a minute, the system parses transactions, categorizes them with Claude Haiku, runs four deterministic anomaly rules against six months of history, and posts an explained, severity-coded alert to Slack for anything unusual. Detection is rule-based and auditable; the LLM only handles the parts that benefit from natural language — naming a vendor, picking a category, and writing the one-sentence reason in the alert.

The interesting part isn't that it works — it's where the boundary between code and model is drawn. Math is in JavaScript, words are in Claude, and they don't trade jobs.

## Architecture

```
   bank_statement.csv
          │
          ▼
   Google Drive ──trigger──►  n8n workflow
                                  │
                                  ▼
                  ┌───────────────────────────────┐
                  │ 1. Download + parse CSV       │
                  │ 2. Normalize, build tx_id     │
                  │ 3. Dedup vs Sheet history     │
                  │ 4. Categorize (Haiku, batched)│
                  │ 5. Run 4 anomaly rules        │
                  │ 6. Explain (Sonnet) ◄── flagged only
                  │ 7. Append to Sheet            │
                  │ 8. Post to Slack    ◄── flagged only
                  └───────────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
   Google Sheets             Slack #finance-           Email digest
   Transactions +            alerts                    (Cron, daily)
   Anomalies tabs            (per anomaly)
```

The Sheet is the system of record. Slack is for real-time signal. Email is for the morning summary.

## The four anomaly rules

All four are implemented in [`rules.js`](./rules.js) as a single function `runAnomalyRules(newTransactions, history)`. Each rule appends a flag object — `{ rule, severity, reason, context }` — to the transaction. Rules are independent and stack: a transaction with multiple anomalies carries multiple flags.

### Rule 1 — Amount spike vs vendor history

A new charge is flagged if it satisfies **both** thresholds, computed against the same vendor's last 90 days of history:

- `amount > 2 × mean`, **and**
- `amount > mean + 2 × stddev`

Vendors with fewer than 3 prior samples are skipped — too few points produce a noisy mean. Severity: **high**. The `reason` quotes the multiple, the mean, the stddev, and the sample size.

> Example (from `test_rules.js`):
> AWS at €8,200 on 2026-05-03 → *"2.9x the 90-day vendor average (€2820, σ=€85, n=3)"*. Mean is €2,820 across the three preceding charges; €8,200 is both >2× the mean (€5,640 threshold) and >mean+2σ (€2,990 threshold), so the flag fires.

### Rule 2 — New vendor

Vendor name not present anywhere in history. Severity: **low**. New vendors are usually legitimate purchases, so this rule is informational rather than alarming — a soft signal that something deserves a glance, not a page.

> Example: `Linear App Inc` on 2026-05-04 → *"First time seeing vendor 'Linear'"*. Demo data has no prior Linear charge, so the new-vendor flag fires while Rules 1 and 3 sit out (no history to compare to).

### Rule 3 — Duplicate

Same vendor and same amount, within 48 hours, against either the existing history *or* another row in the same incoming batch. Severity: **medium**. Most of these are billing glitches or accidental double-submissions; a small fraction are genuine fraud, which is why the alert goes out either way.

> Example: two `Stripe Fee, €2.50` rows on 2026-05-02 → both flagged with *"Same vendor and amount (€2.50) charged within 48 hours"*. The 48-hour window catches typical retry-storm patterns; the in-batch comparison catches duplicates that arrive in the same upload.

### Rule 4 — Category total spike

Sum the current month's spend per category. If any category exceeds **2.5×** its trailing 6-month monthly average, flag the **largest contributing transaction** in that category. Severity: **high**. Flagging only the top contributor keeps one alert per spike instead of N noisy alerts for every charge in a hot category.

> Example: Marketing in May 2026 totals €4,500 against a 6-month average of €795 → *"Marketing spend this month (€4500) is 5.7x the 6-month average (€795)"*. The €4,500 Facebook Ads charge is the single largest contributor and therefore carries the flag; the rest of the Marketing rows in May (none, in this demo) would be silent.

## How the LLM is used

The LLM has exactly two jobs in this system. It never decides whether a transaction is anomalous.

### Categorization — Claude Haiku 4.5

Once per CSV, after dedup. Up to 50 transactions are sent in a single batched prompt. The model returns a JSON array with `vendor`, `category`, and `confidence` for each `tx_id`. Categorization is non-blocking: if Haiku miscategorizes a row, the rule engine still flags it correctly because Rules 1–4 work on `vendor` and `amount`, both of which are deterministic. A wrong category degrades the report, not the detection.

The category list is fixed (`Cloud Infrastructure`, `Software / SaaS`, `Marketing`, `Banking Fees`, `Subscriptions`, `Office`, etc.) so Rule 4 has stable buckets to sum across. The model is instructed to clean vendor names too — `AMAZON WEB SERVICES INC` becomes `AWS` — which keeps Rules 1 and 3 from splitting the same vendor across surface variations.

### Explanation — Claude Sonnet 4.6

One call per flagged transaction — typically a handful per file. The prompt is given the rule context (mean, stddev, ratio, etc.) and asked for a single concise sentence quoting those numbers. Sonnet's job is to translate `{ rule: "amount_spike", ratio: 2.9, mean: 2820 }` into *"This €8,200 AWS charge on 2026-05-03 is 2.9× the 90-day vendor average of €2,820"* — useful in a Slack alert, useless if it gets the math wrong, which is why the math happens before the LLM sees the row.

The split is the point of the design: rules do math; LLMs do words. If a reviewer asks "why was this flagged?", the answer is a number, not a model output.

## Idempotency

Drive triggers fire more than once for the same file — re-runs, restarts, manual re-uploads, the developer dropping the same CSV in twice while testing. Without protection, every duplicate event creates duplicate Sheet rows and false anomalies.

The fix is one line of design discipline:

```
tx_id = `${filename}_${rowindex}`
```

Every transaction carries a deterministic ID built from the source filename and its zero-indexed row position. So row 3 of `test_statement.csv` is always `test_statement.csv_3`, no matter how many times that file gets re-uploaded. Before any other processing, the dedup node reads all existing `tx_id`s from the Transactions tab into a `Set` and filters out any incoming row whose ID is already present. The same CSV uploaded ten times produces exactly one set of rows.

This also makes the system safe to re-run end-to-end. If the AI step fails halfway and you replay the file, only the genuinely new rows make it through. There is no "have I seen this before?" state to maintain — the answer is in the Sheet.

## Cost

Roughly half a cent per CSV processed, dominated by the Haiku categorization call. A typical 30-row file is one batched Haiku call (cents fractions) plus zero to a few Sonnet explanations (a fraction of a cent each). Slack, Sheets, Drive, and n8n itself are free at this volume.

The cost grows with anomaly count, not transaction count: a clean 200-row file costs about the same as a clean 30-row file (one Haiku call), while a noisy 30-row file with five flags adds five Sonnet calls. In practice the entire pipeline stays well under a cent per file as long as batching is honored.

Two design decisions keep this true:

1. **Batched categorization.** The naive version of this pipeline calls the API once per row. At 200 rows, that's 200 round-trips and 200× the per-call overhead. Batching 50 transactions into a single prompt cuts that to four calls per file with negligible quality loss — categories don't depend on context across rows.
2. **LLM-after-rules for explanation.** Sonnet is only invoked for transactions the rule engine has already flagged. On a clean day with zero anomalies, the explanation step doesn't run at all. The expensive model is gated behind cheap deterministic logic.

## Repo layout

| File | Purpose |
|---|---|
| [`rules.js`](./rules.js) | The anomaly rule engine. Pure JS, zero dependencies. Pasteable into an n8n Code node; also Node-importable for local testing. |
| [`seed_history.csv`](./seed_history.csv) | 60 rows of synthetic baseline transactions, Nov 2025 → Apr 2026. Import this into the `Transactions` tab once before demoing — without history, every transaction looks anomalous. |
| [`test_statement.csv`](./test_statement.csv) | 9 May 2026 rows containing one trigger for each of the four rules. This is the file you drop into the watched Drive folder for the demo. |
| [`test_rules.js`](./test_rules.js) | Local sanity check. Loads both CSVs, runs `runAnomalyRules`, prints which transactions got flagged with which rules. Use this before touching n8n. |
| [`n8n_snippets.md`](./n8n_snippets.md) | Every piece of code or JSON that goes into the workflow, in order, with brief placement notes. Build the n8n workflow by walking through this file once. |
| [`AI_Expense_Monitor_Project_Guide.md`](./AI_Expense_Monitor_Project_Guide.md) | The original spec. Phases, priorities, and out-of-scope decisions. |

## Running the demo

Two paths: a 30-second local sanity check that proves the rules work, and a full end-to-end run through n8n.

**Local check (no accounts needed):**

```bash
node test_rules.js
```

Loads `seed_history.csv` as history, runs `runAnomalyRules` against `test_statement.csv`, prints a flag report. All four rules should fire. Expected output (abridged):

```
Evaluated 9 new tx against 60 history rows
Flagged: 5 of 9

2026-05-02  Stripe                 €2.50
    [MEDIUM] duplicate        Same vendor and amount (€2.50) charged within 48 hours
2026-05-03  AWS                 €8200.00
    [HIGH  ] amount_spike     2.9x the 90-day vendor average (€2820, σ=€85, n=3)
    [HIGH  ] category_spike   Cloud Infrastructure spend this month (€10600) is 4.1x the 6-month average (€2585)
2026-05-04  Linear                €89.00
    [HIGH  ] category_spike   Software / SaaS spend this month (€120) is 3.9x the 6-month average (€31)
    [LOW   ] new_vendor       First time seeing vendor "Linear"
2026-05-04  Facebook Ads        €4500.00
    [HIGH  ] amount_spike     5.6x the 90-day vendor average (€807, σ=€12, n=3)
    [HIGH  ] category_spike   Marketing spend this month (€4500) is 5.7x the 6-month average (€795)

Rule coverage:  amount_spike  new_vendor  duplicate  category_spike
```

**Full demo:**

1. Set up the accounts and folders described in Phase 0 of the guide.
2. Import `seed_history.csv` into the `Transactions` tab of the Google Sheet (File → Import → Append). This is the baseline — without it, the rules have no history to compare against.
3. Build the n8n workflow by pasting each section of `n8n_snippets.md` into the corresponding node, in order.
4. Drop `test_statement.csv` into the `Expense-Inbox` Drive folder.
5. Within a minute: five Slack alerts in `#finance-alerts`, color-coded by severity, each quoting the actual numbers behind the flag.

## Limitations

These are deliberate scope cuts, not bugs. Each one would be straightforward to lift but would not make the demo more recruitable.

- **One CSV format.** The system assumes a three-column `date,description,amount` CSV. Real banks vary wildly. Multi-format auto-detection is doable but adds complexity that doesn't show up in the Loom.
- **No PDF parsing.** Most banks export PDFs; this project requires CSV. PDF parsing is a project of its own.
- **Single currency.** Amounts are treated as a single unit. No FX conversion, no per-account currencies.
- **No authentication.** Single-user system. The Drive folder, Sheet, and Slack channel are all owned by one account.
- **Sheets as a database.** Google Sheets handles thousands of rows comfortably and breaks somewhere past ten thousand. For a portfolio project this is fine; for production it is not.
- **Categorization is non-deterministic.** Haiku's category labels can drift on edge cases. This is mitigated by the rule engine ignoring `category` for everything except Rule 4, but the Sheet view of "spend by category" inherits the noise.
- **Rules are not learned.** Thresholds (2× mean, 90 days, 2.5× monthly average) are hand-picked defaults. They work for the synthetic data here and a typical small-business spending profile; they are not tuned to any particular real-world vendor mix.
- **Time zones are implicit.** All timestamps are UTC. Sub-day precision is treated as same-day for Rule 3. Most bank CSVs only carry date anyway.

## Next steps

If this were going past portfolio scope:

- **Multi-bank format adapter.** A first node that detects the bank from header signature and remaps to the canonical `date/description/amount` shape.
- **Confidence-weighted score.** Combine the four rule outputs into a single 0–1 score per transaction. Sort the daily digest by it. Today the rules are independent boolean flags; a weighted score would let the system distinguish a single low-severity new-vendor flag from a stack of three.
- **Per-vendor charts in Slack alerts.** Embed a 6-month amount-over-time sparkline for the flagged vendor directly in the Slack message. Makes the alert immediately verifiable without clicking through to the Sheet. (This is the recommended differentiator from the project guide.)
- **SQLite or Postgres backing store.** Keep Sheets for the human-readable view, but move the dedup lookup and history queries to a real database. Removes the ~10k row ceiling.
- **Threshold tuning per vendor.** Some vendors are spiky by nature (variable cloud bills); some are flat (a SaaS subscription). Today they share one threshold. A small per-vendor override table would cut noise.
- **Weekly executive summary.** A second Cron workflow on Sunday evening: pull the week's anomalies and category totals, send to Sonnet, email a 5-bullet summary.

## Tech stack

- **Orchestration:** n8n (self-hosted via Docker for portfolio recording, or n8n Cloud)
- **Ingestion:** Google Drive — watched folder, one-minute trigger
- **Storage:** Google Sheets — `Transactions` and `Anomalies` tabs
- **Categorization:** Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) — batched, ~50 transactions per call
- **Explanation:** Claude Sonnet 4.6 (`claude-sonnet-4-6`) — one call per flagged transaction
- **Real-time alerts:** Slack — block-kit messages with severity-coded color bars
- **Digest:** n8n Email Send node, daily Cron at 09:00
- **Anomaly engine:** Pure JavaScript, no dependencies, ~150 lines
- **Test runner:** Node.js, no frameworks
- **Secrets:** all API keys in n8n credentials, none in code

## What this project demonstrates

For anyone reading this as a portfolio piece, the things worth looking at:

- **Hybrid AI/code architecture.** The LLM is gated behind deterministic logic. Detection is auditable; explanation is natural-language. Either component can be swapped (different model, different rules) without touching the other.
- **Idempotent event processing.** Drive triggers are not exactly-once. The `tx_id` scheme + dedup-on-read makes the whole pipeline replayable, which matters for any real-world ingestion system.
- **Batched API usage.** Categorization sends 50 rows per call. The cost difference between this and per-row calls is two orders of magnitude on a 1,000-row file.
- **Schema-first design.** The Sheet's columns were settled before any node was built. Changing them later means rewriting every node that touches them — easy to underestimate.
- **Scope discipline.** Multi-bank parsing, PDF support, multi-currency, custom UI — all explicitly out of scope. The project is recruitable because it does one thing end-to-end, not five things halfway.
