---
name: budget-stay-optimizer
description: Compare lodging choices by total practical cost, not just nightly rate. Use when a Slack request asks for a cheap stay, best value hotel, or lodging tradeoff that should include transit, taxi, and inconvenience costs.
---

# Budget Stay Optimizer

Use this skill to compare stay options by the full practical cost of the trip.
Assume the user may only give a destination, budget ceiling, or rough area.

## Workflow

1. Restate the lodging goal in concrete terms:
   - destination or main stop
   - nightly budget
   - number of nights
   - arrival and departure times
   - tolerance for walking, transfers, or late-night travel
2. Compare the real total cost, not the sticker price:
   - nightly rate
   - transit cost to the destination
   - taxi or rideshare fallback cost
   - extra inconvenience from distance, transfers, or time loss
3. Rank options by value, then by simplicity:
   - best total-cost choice
   - best low-friction choice
   - best backup if prices move
4. Call out hidden cost drivers:
   - airport access
   - late check-in
   - luggage burden
   - weekend or event pricing
5. Ask at most one blocking follow-up question, and only if destination or budget ambiguity would materially change the ranking.

## Output Shape

- Best Value: the option with the lowest practical total cost
- Tradeoff Summary: why it wins and what it gives up
- Runner-Up Options: one or two alternatives with different balance points
- Hidden Costs: transit, taxi, time, or inconvenience factors that matter
- Caveats: optional uncertainty, missing details, or price volatility

## Guardrails

- Do not optimize on nightly rate alone.
- Do not ignore transit or taxi costs when they dominate the trip.
- Do not treat a far-cheaper room as a better deal if it creates major friction.
- Keep the result concise enough to work in Slack.
