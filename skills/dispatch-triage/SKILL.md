---
name: dispatch-triage
description: Triage logistics and dispatch issues from sparse Slack or huddle updates. Use when someone reports a delay, no-show, missed pickup, route disruption, or urgent redispatch need with incomplete details.
---

# Dispatch Triage

Use this skill to turn a messy operational update into an immediate triage view.
Assume the input may be incomplete, spoken, or partially contradictory.

## Workflow

1. Extract only the facts that are actually present.
2. Separate confirmed facts from assumptions and unknowns.
3. Assess urgency using practical operations signals:
   - safety risk
   - customer impact
   - same-day or time-window risk
   - cascading impact on later stops or vehicles
4. Recommend the next actions that help the dispatcher move forward now.
5. Ask at most one blocking follow-up question, and only if it changes the next action materially.

## Output Shape

- Situation: one or two lines summarizing the issue
- Urgency: `high`, `medium`, or `low`
- Likely Impact: who or what may be affected next
- Immediate Checks: the first facts worth confirming
- Next Actions: short operational steps

## Guardrails

- Do not invent ETAs, route feasibility, or vehicle availability.
- Do not require many structured fields before helping.
- Prefer a useful triage answer over a perfect optimization answer.
- Keep the answer short enough to work in Slack.
