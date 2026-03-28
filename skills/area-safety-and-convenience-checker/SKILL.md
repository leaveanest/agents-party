---
name: area-safety-and-convenience-checker
description: Assess whether an area is a practical fit for a stay or meetup based on late-night convenience, safety signals, station access, and ease of arrival. Use when a Slack request asks whether a district, station area, or neighborhood is a good choice for meeting or staying there.
---

# Area Safety and Convenience Checker

Use this skill to turn an area question into a practical fit assessment.
Assume the user may only provide a station name, neighborhood, or rough destination.

## Workflow

1. Restate the area question in concrete terms:
   - target area
   - arrival time
   - who is traveling
   - how they will arrive
   - whether the use case is stay, meetup, or both
2. Judge the area with practical signals:
   - late-night convenience
   - station access and transfer burden
   - easy walkability from the arrival point
   - obvious safety or comfort concerns from the available context
3. Separate the area into useful sub-areas when the answer changes by block or exit.
4. Note tradeoffs explicitly when convenience and perceived safety pull in different directions.
5. Ask at most one blocking follow-up question, and only if the travel mode or arrival time would materially change the area judgment.

## Output Shape

- Fit Verdict: `good`, `mixed`, or `poor`
- Why: one or two lines with the main reason
- Best Sub-Area: the specific block, exit, or side of the station that fits best
- Watchouts: practical risks, late-night issues, or access burdens
- Alternatives: optional nearby areas that are easier or calmer

## Guardrails

- Do not overstate safety without evidence.
- Do not confuse a lively area with a universally safe one.
- Do not ignore arrival friction, last-train timing, or long walks from the station.
- Keep the answer short enough to work in Slack.
