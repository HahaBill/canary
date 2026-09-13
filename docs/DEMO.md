# Canary — Demo Script

Target: **~2 minutes**, with optional voice extension.

The memorable sequence is:

```text
Alert → WHY → SHOW ME → Deep link → Incident → What-if
```

All financial values must be read dynamically from the app/generator output. Do not memorize hand-written numbers.

---

# Before Demo

- [ ] Verify React deployment
- [ ] Verify selected incident exists
- [ ] Verify Sendblue outbound
- [ ] Verify inbound WHY
- [ ] Verify inbound SHOW ME
- [ ] Verify deep link
- [ ] Verify cached vendor research result
- [ ] Verify what-if simulator
- [ ] Keep recorded iMessage fallback ready
- [ ] If ElevenLabs is used, verify microphone and tool call

---

# 0:00 — Hook

> **“Coal miners used canaries as early-warning systems. Startup founders need one for their cash.”**

> “Most finance tools tell you what already happened. Canary watches for when financial behavior itself changes.”

---

# 0:15 — Show Alert First

Show the phone.

Canary message:

> 🐤 **Canary**  
> I detected a sustained increase in variable spending.  
> [PRIMARY DRIVER] is currently the largest contributor.  
> Impact: modeled runway [BEFORE] → [AFTER] versus the previous spending regime.  
> Reply **WHY** or **SHOW ME**.

Immediately below it, a native iMessage **voice note** (ElevenLabs, ~15 s) gives the conversational version of the same incident. Play it.

Say:

> "The text has the exact numbers. The voice note is the same incident, spoken. Both come from one incident object, so they can't disagree."

Trigger: `POST /api/alerts/send` with header `x-canary-secret: <WEBHOOK_SECRET>` (sends text + voice note to FOUNDER_PHONE). Canary only replies to FOUNDER_PHONE / ALLOWED_PHONES.

Do not start with architecture.

---

# 0:30 — WHY

Reply:

```text
WHY
```

Canary returns generator-derived explanation:

- detected change period;
- pre/post variable-spend rate;
- largest contributor;
- possibly second contributor.

Say:

> “Canary isn't asking an LLM whether a chart looks weird. It first normalizes the financial data, then uses change-point detection on variable spend.”

One sentence only.

---

# 0:50 — SHOW ME

Reply:

```text
SHOW ME
```

Canary sends a backend-generated deep link.

Tap it.

---

# 1:00 — Incident Page

React opens directly to the incident.

Show only:

1. timeline/change point;
2. contributor decomposition;
3. current burn/runway;
4. evidence section.

Say:

> “The same underlying problem becomes one incident, so Canary doesn't spam the founder with separate alerts for burn, cloud spend, and infrastructure.”

---

# 1:20 — Financial Correctness

Point to reconciliation/data-quality indicator.

Say:

> “Before detecting anything, Canary handles transfers, card settlements, financing and unknown categories so those don't silently corrupt burn.”

Do not spend more than ~10 seconds here.

---

# 1:30 — Vendor research

Show the unknown-vendor enrichment/evidence.

Say:

> “For ambiguous vendors, OpenAI proposes a category and live search independently identifies what the company does with a cited source. Canary only treats it as corroborated when the signals agree.”

This is the core vendor-research beat.

---

# 1:45 — What-If

Ask or use UI:

> “What if [PRIMARY DRIVER] were 20% lower?”

Canary calculates dynamically.

Show:

- monthly difference;
- runway effect;
- “Scenario estimate” label.

Say:

> “The LLM doesn't do this math. The financial engine does.”

---

# 2:00 — Finish

> **“Canary reconciles first, detects what changed, researches what matters, and tells the founder before they have to go looking.”**

Stop.

---

# Optional 20–30 Second ElevenLabs Extension

Only if voice is stable.

Press:

> **Ask Canary**

Ask:

> “What should I worry about most?”

Then:

> “What if [PRIMARY DRIVER] were 20% lower?”

ElevenLabs calls the same deterministic backend tools.

Finish with:

> “Web, iMessage and voice are just three interfaces over the same financial intelligence.”

---

# Fallback Plan

If live Sendblue fails:

1. play the short recorded alert → WHY → SHOW ME clip;
2. immediately continue live on React from the deep-link destination.

If live research fails:

- use the cached result;
- clearly label the result as previously retrieved external evidence.

If ElevenLabs fails:

- skip it entirely.

The core demo must never depend on voice.

---

# Judge Q&A Cheat Sheet

## “Where does the bank data come from?”

> “Per hackathon guidance we run on a fictional company, Perch Analytics, banking with a fictional sandbox bank. The sandbox sits behind a `BankProvider` interface, so a real bank API like Rho drops in without touching the engine, detectors, or UI. We read the sandbox's current balance and anchor the synthetic historical ledger so it closes exactly on that balance.”

## “Is any of this real money?”

> “No. The company, accounts, and transactions are synthetic and deterministic. The only real-world data is the vendor research, which uses a real indexed vendor name.”

## “Why synthetic history?”

> “Change detection needs a meaningful baseline. The sandbox doesn't necessarily provide enough historical depth, so we supplement with deterministic fixtures and label them clearly.”

## “How do you calculate burn?”

> “Deterministically from reconciled operating cash flows. Transfers, financing and duplicate settlements are excluded.”

## “Why CUSUM?”

> “We're detecting a sustained upward shift in variable spend, not merely one extreme transaction.”

## “What happens to the Figma one-off?”

> “It remains in real cash/burn, but because it is already tagged as a one-off it is winsorized out of the CUSUM monitoring series.”

## “What does the vendor research do?”

> “It independently corroborates unknown vendor identity with a cited source, and optionally monitors major vendors for dated external changes.”

## “Does the research know why AWS spend rose?”

> “No. Bank data doesn't expose workload root cause, so Canary does not claim that.”

## “Does the LLM calculate runway?”

> “No. All money math and materiality are deterministic.”

## “Why no auth?”

> “This is a fictional sandbox/synthetic hackathon environment. Production would require workspace authorization, verified phone ownership, and signed links.”
