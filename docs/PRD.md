# Canary — Final Hackathon PRD

**Project:** Canary  
**Hackathon:** LOCK IN Hack 2026 at Rho  
**Primary sponsor integration:** Tavily  
**Secondary sponsor integration:** ElevenLabs  
**Supporting technology:** OpenAI, Cloudflare, Sendblue  
**Nice-to-have:** Notion

> **Data source decision (2026-09-12):** The live Rho API is **not** used in this build. Per hackathon guidance, Canary runs against a **fictional company** and a **fictional bank sandbox** ("Canary Sandbox Bank"). The sandbox is implemented behind a `BankProvider` interface so a real bank API (Rho or otherwise) can be swapped in later without touching the engine, detectors, or UI. Everywhere this document previously said "Rho balance" or "Rho data", read "sandbox bank balance / sandbox bank data".

## Fictional company

```text
Company:      Perch Analytics, Inc.
Stage:        Seed, B2B analytics SaaS, cloud-heavy
Team:         14 people
Raised:       ~$3.0M
Bank:         Canary Sandbox Bank (fictional)
Accounts:     Operating checking, savings/reserve, corporate card
```

All company, vendor-payment, and balance data are synthetic and generated deterministically. The only exception is the **real, indexed vendor name** used for the Tavily corroboration fixture (see §7 and §11).

---

# 1. Product Summary

## One-line pitch

**Canary is an explainable early-warning system for startup finances. It reconciles company cash activity, detects meaningful changes in spending and runway, researches relevant evidence, and proactively tells founders what deserves attention through web, iMessage, and voice.**

### Simple explanation

> **Most finance tools tell you what happened. Canary watches for when financial behavior itself changes.**

Canary is inspired by the canary-in-the-coal-mine metaphor: an early-warning system that detects danger before humans notice it.

---

# 2. Product Thesis

Canary is **not** an autonomous CFO.

It does not:

- move money;
- make payments;
- cancel vendors;
- switch cloud providers;
- make financial decisions for founders.

Instead, Canary:

1. reconstructs financial activity;
2. reconciles cash movement;
3. classifies transactions;
4. detects meaningful changes;
5. groups related signals into incidents;
6. quantifies financial impact deterministically;
7. researches supporting external evidence;
8. proactively alerts the founder;
9. lets the founder investigate through web, iMessage, or voice.

### Engineering philosophy

> **Reconcile first. Detect second. Research third. Explain everything.**

---

# 3. Target User

Early-stage startup founder who:

- has meaningful company cash;
- banks with a modern business bank (modeled here by the fictional Canary Sandbox Bank);
- has recurring SaaS/cloud/vendor spending;
- may have employee card spend;
- does not yet have a dedicated CFO;
- wants financial awareness without studying accounting dashboards.

Typical profile:

- 3–30 employees;
- roughly $500K–$5M raised;
- software/cloud-heavy company.

The UX should feel consumer-quality rather than accounting-heavy.

---

# 4. Product Principles

## Nothing falls through silently

Unknown category ≠ ignored transaction.

If classification is uncertain:

> **Needs Review**

The amount still affects cash and burn.

## Rules where rules work

Use deterministic logic first.

## AI for ambiguity

Use OpenAI for semantic long-tail cases, not for deterministic calculations.

## Statistics for change

Persistent burn drift and one-off unusual payments are different problems.

## Deterministic money math

LLMs never calculate:

- burn;
- runway;
- deltas;
- materiality;
- reconciliation;
- scenario outcomes.

## Evidence before suggestions

Keep these categories distinct:

- **Observed**
- **Detected**
- **Evidence**
- **Estimate**
- **Suggestion**

## One problem = one incident

Do not notify separately about burn drift, AWS acceleration, and infrastructure growth if they are manifestations of the same underlying incident.

---

# 5. Core Product Loop

```text
Canary Sandbox Bank (BankProvider)
 │
 ▼
Raw accounts + transactions
 │
 ▼
Normalization
 │
 ▼
Reconciliation
 │
 ▼
Classification
 │
 ▼
Financial ledger
 │
 ├───────────────┐
 ▼               ▼
One-off rules    CUSUM
+ robust stats   change detection
 │               │
 └───────┬───────┘
         ▼
      Incident
         │
         ▼
   Materiality rules
         │
         ▼
 Financial impact
         │
         ├──────────────┐
         ▼              ▼
      Tavily       deterministic
      evidence       scenarios
         │              │
         └──────┬───────┘
                ▼
             Canary
       ┌────────┼────────┐
       ▼        ▼        ▼
     React   Sendblue  ElevenLabs
      Web    iMessage    Voice
```

---

# 6. Data Strategy — P0

The product demo requires enough history to establish normal behavior.

Therefore the first system component is a **deterministic synthetic company generator**.

The generator should produce **16–20 weeks** of realistic startup financial history and be seeded so the output is repeatable.

**Important:** all demo numbers shown in React, iMessage, voice, and the demo script must be **derived from generator output**. Do not hand-type financial figures in documentation or UI.

The sandbox bank exposes a **closing balance** for the fictional company (a fixed, configured anchor in the company profile). Synthetic history is generated **backward from that sandbox closing balance**, so the synthetic ledger closes exactly on the balance the bank reports.

The `BankProvider` interface (accounts, balances, transactions) is the seam where a real bank API would plug in. The engine, detectors, and UI never know which provider is behind it.

The demo must clearly label:

- sandbox-bank-sourced current balance/accounts;
- synthetic historical fixtures;
- that the company is fictional.

---

# 7. Synthetic Demo Fixtures

The demo dataset should include:

- recurring payroll;
- rent;
- SaaS;
- cloud spend;
- contractors;
- employee card spend;
- customer inflows;
- refunds;
- internal transfers;
- financing.

Planted events:

1. **Sustained variable-spend regime change**
   - starts early enough to provide a meaningful post-change segment;
   - should be gradual enough that the story remains “sustained drift,” not a single extreme week.

2. **One-off unusual vendor payment**
   - large relative to that vendor’s own historical payments.

3. **Unknown real vendor**
   - use a real, indexed vendor name that Tavily can identify reliably;
   - cache the successful result for demo reliability.

4. **Financing event**
   - small enough and timed so it does not create impossible cash history;
   - may be excluded from the primary demo seed if unnecessary.

5. **Internal transfer / card settlement**
   - used to test reconciliation correctness.

The generator must include assertions so it acts as the verification layer.

---

# 8. Reconciliation Engine

Before calculating burn or detecting incidents, Canary must handle:

## Internal transfers

Checking → savings is not company spend.

## Card settlements

A card purchase and the later bank settlement must not be double counted.

## Pending vs settled

Pending and settled versions of the same transaction must not both count.

## Financing

SAFE/equity/debt inflows increase cash but do not count as revenue or reduce operating burn.

## Refunds

Refunds should be netted against the relevant vendor/category where possible.

## Needs Review

Unknown category still contributes to total cash and burn.

---

# 9. Statement Reconciliation — P1

If the sandbox bank exposes statement data (opening/closing per period):

```text
opening balance
+
recognized net cash movement
=
expected closing balance
```

Compare with statement closing balance.

Mismatch:

> **Reconciliation mismatch**

This is valuable, but because it depends on sandbox/API availability it is **P1, not P0**.

---

# 10. Classification Pipeline

```text
Transaction
    │
    ▼
Deterministic rules
    │
    ├── match → classified
    │
    └── unknown
          │
          ▼
       OpenAI
          │
          ▼
External corroboration useful?
          │
          ▼
        Tavily
          │
          ▼
Enough independent evidence?
      /                 \
    yes                 no
     │                   │
classified          Needs Review
```

Store:

- category;
- method;
- reason;
- supporting signals;
- confidence level.

Do not use LLM self-reported numeric confidence.

Confidence comes from corroborating signals.

---

# 11. Tavily Workflow — P0

Primary Tavily use:

> **Unknown vendor identification / corroboration**

Example:

1. transaction merchant is not in deterministic rules;
2. OpenAI proposes a category;
3. Tavily searches the real vendor;
4. structured extraction returns what the company does plus URL/source;
5. compare extracted business type to the proposed category;
6. accept only if the signals agree.

This is more defensible than generic vendor-optimization search.

### P1 Scout

Monitor financially important vendors for **dated recent changes**:

- pricing changes;
- new plans;
- startup credits;
- announcements;
- discount programs.

Every source must include dates.

---

# 12. Detector A — One-Off Vendor Anomaly

Use vendor-relative history.

Requirements:

- at least **3 prior vendor payments** before using vendor-median anomaly logic;
- otherwise treat the vendor as “new vendor,” not statistically anomalous.

Possible rule:

```text
current > 3 × vendor median
AND
absolute difference > threshold
```

Optional robust statistic:

```text
MAD = median(|x - median|)
```

### One-off materiality

Because one-offs do not have `monthly_delta`, use a separate rule such as:

```text
amount >= max(
  fixed_threshold,
  X% of normalized monthly burn
)
```

Exact thresholds belong in config.

---

# 13. Detector B — Burn Change Detection

Use **one-sided upward CUSUM** on normalized **calendar-week variable spend**.

Do not use rolling 7-day windows.

Do not use EWMA as a second detector.

EWMA may be shown only as a visualization overlay.

### Preprocessing

Exclude or normalize:

- payroll;
- rent;
- annual renewals;
- predictable debt payments.

Tagged one-off anomalies and annual renewals should be **winsorized/excluded from the CUSUM monitoring series** while still counting in the financial ledger and burn.

### Suggested CUSUM configuration

Document/configure explicitly:

```text
direction = upward
k = 0.5σ
h = 4–5σ
σ = robust baseline estimate using MAD
aggregation = non-overlapping calendar weeks
```

Change point:

> last zero of cumulative statistic before alarm.

After a confirmed regime change:

> re-baseline to the new regime.

---

# 14. Burn Window

Do not use “trailing 8 weeks forever.”

The representative burn window depends on the detected regime.

After a confirmed change point:

- use the **post-change segment** once it contains a minimum required number of weeks;
- otherwise fall back to the prior trailing-window method.

The change detector is therefore not only an alerting mechanism; it helps determine which historical segment is representative of current burn.

---

# 15. Contributor Decomposition

After detecting a burn shift:

```text
vendor_delta =
post_change_vendor_rate
-
pre_change_vendor_rate
```

Prefer **dollar contribution** over percentage-of-total.

Example display:

```text
AWS            +$X/week
Recruiting     +$Y/week
SaaS           +$Z/week
Other          -$W/week
```

Negative contributors are valid.

Do not force shares to sum neatly to 100%.

---

# 16. Detector Interaction Rules

This is explicit to prevent contradictory alerts.

## One-off shock vs CUSUM

A tagged one-off payment:

- counts in the real ledger;
- counts in cash/burn;
- is excluded/winsorized in the CUSUM monitoring series.

## Child signal vs incident

A signal joins an existing incident if its entity/category is part of that incident’s contributor decomposition.

Example:

- burn incident includes SaaS increase;
- recurring Notion increase contributes to SaaS;
- do not show it as a second independent high-level alert.

Standalone one-offs remain separate.

---

# 17. Incident Model

Canonical fields:

```text
id
type
entity
estimated_change_point
severity
status
first_detected
last_updated
last_notified
financial_impact
```

States:

```text
OPEN
ACKNOWLEDGED
RESOLVED
```

### Deduplication

Do **not** key exactly on change-point week because the estimate may move as data arrives.

Match a new detection to an existing open incident if:

- type/entity match;
- estimated change point is within approximately ±2 weeks.

Update the incident instead of creating a new one.

---

# 18. Materiality

The LLM never decides whether an incident deserves interruption.

### Rate-change materiality

Example configurable rules:

```text
monthlyized_delta >= fixed_amount
OR
monthlyized_delta >= % of normalized burn
OR
runway_impact >= threshold
```

### One-off materiality

Separate rule:

```text
one_off_amount >= fixed_amount
OR
one_off_amount >= % of normalized monthly burn
```

All values must live in config.

---

# 19. Runway

Runway is deterministic:

```text
runway_months =
available_operating_cash
/
normalized_current_operating_burn
```

Exclude:

- financing inflows from operating burn;
- transfers;
- duplicate settlements.

Include:

- Needs Review expenses.

When a regime change is confirmed, current burn should use the representative post-change segment once enough data exists.

---

# 20. Evidence Taxonomy

Every user-facing investigation must preserve:

## OBSERVED

Direct financial data.

## DETECTED

Canary rule/statistical output.

## EVIDENCE

External cited information.

## ESTIMATE

Deterministic scenario calculation.

## SUGGESTION

AI-generated next step.

Example:

```text
OBSERVED
AWS spend increased in the post-change segment.

DETECTED
Variable spend shifted upward.

EVIDENCE
Recent cited vendor information.

ESTIMATE
A hypothetical 20% reduction changes modeled burn/runway by X.

SUGGESTION
Review relevant resources before making an operational decision.
```

---

# 21. OpenAI Role

OpenAI handles:

- semantic classification;
- founder intent parsing;
- tool selection;
- explanations;
- evidence summarization.

It does not:

- perform money math;
- decide materiality;
- invent URLs;
- silently classify uncertain transactions;
- infer operational root cause from bank data.

Suggested tools:

```text
get_health_summary()
get_active_incidents()
get_incident(id)
explain_incident(id)
get_vendor_spend(vendor)
get_runway()
get_evidence(id)
simulate_cost_change(entity, percentage)
create_app_link(destination, id, tab)
```

---

# 22. React Web App

Stack:

- React;
- Vite;
- TypeScript;
- Tailwind;
- shadcn/ui;
- Recharts;
- Cloudflare Workers (the SPA is built to `apps/api/public` and served as Worker static assets).

### P0 routes

```text
/
dashboard

/incidents/:id
```

Needs Review can be a **dashboard section/modal**, not a dedicated P0 page.

### Incident page

Must show:

- what changed;
- timeline/change point;
- drivers;
- financial impact;
- why Canary flagged it;
- evidence;
- what-if simulator;
- data-quality warnings if relevant.

---

# 23. Sendblue — P0 Interaction

P0 iMessage behavior should use **keyword commands**, not full natural-language routing.

Example:

> 🐤 Canary  
> I detected a sustained increase in variable spending.  
> AWS is the largest contributor.  
> Reply **WHY** or **SHOW ME**.

Commands:

```text
WHY
SHOW ME
```

Optional:

```text
SOURCES
```

Natural-language iMessage routing is P1.

Use a verified/shared-secret webhook mechanism where possible.

---

# 24. Deep Links

The LLM never writes URLs.

Tool:

```text
create_app_link(
  destination,
  id,
  tab
)
```

Example:

```text
/incidents/inc_123
/incidents/inc_123?tab=evidence
```

---

# 25. What-If Simulator — P0

This is one of the strongest demo moments.

Example user request:

> What if AWS were 20% lower?

Backend calculates from current generator-derived values.

Return:

- current spend;
- hypothetical delta;
- monthlyized/annualized effect;
- current modeled runway;
- scenario runway.

Label clearly:

> **Scenario estimate — not guaranteed savings.**

No hand-written example numbers in production UI/docs.

---

# 26. ElevenLabs — P1

ElevenLabs reuses the same backend tools.

Feature:

> **Ask Canary**

Best demo question:

> “What if AWS were 20% lower?”

The agent calls the deterministic simulator.

Precompute speech-friendly strings:

```text
"about thirty-nine hundred dollars per month"
```

The ElevenLabs prompt must preserve the evidence taxonomy and avoid unsupported prescriptions.

Voice-controlled React navigation is stretch.

---

# 27. Cloudflare Architecture

Deploy a **skeleton Worker in hour one**.

Why:

- Sendblue inbound requires a public URL;
- ElevenLabs server tools require a public URL;
- keys/integrations need early verification.

Architecture:

```text
Cloudflare
│
├── React/Vite
├── Workers
│   ├── API
│   ├── Sendblue webhook
│   └── agent tools
├── D1
│   ├── transactions
│   ├── classifications
│   ├── incidents
│   ├── evidence
│   └── job state
├── Cron
│   ├── bank sync (sandbox BankProvider)
│   └── detector run
└── R2
    └── optional media
```

Do not depend on Cloudflare Queues.

---

# 28. P0 Scope — Smallest Compelling Canary

This is the **actual P0**.

1. **Public skeleton Worker**
   - serve the sandbox `BankProvider` (fictional company balance/accounts/transactions);
   - verify Tavily API;
   - verify Sendblue outbound + inbound webhook;
   - create ElevenLabs agent/tool endpoint if possible.

2. **Synthetic generator anchored to the sandbox bank closing balance**
   - 16–20 weeks;
   - deterministic seed;
   - planted sustained burn shift;
   - planted one-off;
   - real indexed unknown vendor fixture.

3. **Reconciliation-correct financial engine**
   - transfers;
   - settlements;
   - pending/settled;
   - financing;
   - refunds;
   - Needs Review amounts.

4. **One CUSUM burn-change incident**
   - variable spend only;
   - one-sided upward;
   - explicit parameters;
   - contributor decomposition;
   - post-change burn window.

5. **One one-off vendor detector**
   - vendor median/MAD;
   - n ≥ 3 prior payments;
   - one-off materiality.

6. **One Tavily corroboration workflow**
   - real vendor;
   - structured business-type extraction;
   - source URL;
   - compare against OpenAI category;
   - cached fallback.

7. **One React incident page**
   - chart;
   - drivers;
   - impact;
   - evidence;
   - what-if.

8. **Sendblue alert**
   - WHY;
   - SHOW ME;
   - deep link.

9. **Deterministic what-if simulator**

That is the complete P0.

---

# 29. P1

- ElevenLabs embedded voice;
- statement reconciliation;
- recurring-charge drift detector;
- natural-language iMessage routing;
- dated Scout research;
- real bank API integration (Rho) behind `BankProvider`;
- card/cardholder analysis;
- richer Needs Review interactions;
- voice-controlled React navigation.

---

# 30. P2

- Notion export;
- weekly Notion brief;
- invoicing/receivables;
- alert images;
- phone-call voice;
- cross-cloud comparison;
- broader Scout.

---

# 31. Explicitly Out of Scope

Do not build:

- autonomous payments;
- money transfers;
- vendor cancellation;
- cloud migration;
- tax workflows;
- QuickBooks integration;
- full bookkeeping;
- investment advice;
- full FinOps;
- Isolation Forest/SHAP service;
- complex agent orchestration;
- full authentication;
- many dashboards.

---

# 32. Demo Reliability

Prepare recorded fallback for the live iMessage sequence.

The deployed React flow must always work independently.

Cache the Tavily enrichment used in the demo.

Do not rely on a fictional vendor for live research.

---

# 33. Final Demo Sequence

The demo should focus on the sequence judges will remember:

```text
Canary alert
   ↓
WHY
   ↓
grounded explanation
   ↓
SHOW ME
   ↓
deep link
   ↓
React incident page
   ↓
what-if simulation
```

Everything else is one sentence or technical Q&A.

---

# 34. Final Positioning

## Canary

### Early warning for startup cash.

**Canary reconciles startup financial activity, detects meaningful changes in spending and runway, researches supporting evidence, and proactively tells founders what deserves attention through web, iMessage, and voice.**

It does not replace a CFO.

It helps founders notice when they need to start thinking like one.
