---
name: airport-transfer-planner
description: Plan airport-to-hotel or hotel-to-airport transfers into a short, practical recommendation. Use when a Slack request needs the best transfer option based on arrival time, luggage, late-night constraints, cost, or total transfer burden.
---

# Airport Transfer Planner

Use this skill to turn a loose airport transfer request into a practical plan.
Assume the input may be incomplete and optimize for the transfer that is easiest to execute in real life.

## Workflow

1. Restate the transfer goal in concrete terms:
   - airport and terminal if known
   - hotel or destination area
   - arrival or departure time
   - luggage load
   - traveler constraints such as children, mobility needs, or late-night arrival
2. Prioritize transfer burden over raw distance:
   - number of train or bus changes
   - wait time and missed-connection risk
   - walking with luggage
   - taxi pickup convenience
3. Compare practical transfer options:
   - fastest option
   - cheapest option
   - simplest option with the fewest friction points
4. Call out what could change the recommendation:
   - late-night arrivals or departures
   - airport rail shutdown windows
   - heavy luggage
   - weather or service disruption risk
5. Ask at most one blocking follow-up question, and only if the airport, terminal, or hotel area is missing in a way that changes the transfer plan materially.

## Output Shape

- Recommended Transfer: one clear option with a short reason
- Alternatives: two or three fallback transfer choices
- Transfer Notes: concise timing, connection, and luggage notes
- Caveats: optional uncertainty, service windows, or cost tradeoffs

## Guardrails

- Do not optimize for the shortest route if it creates a difficult luggage transfer.
- Do not assume the cheapest option is best for a late arrival.
- Do not ignore terminal changes, last-train risk, or hotel access from the station.
- Keep the answer short enough to work in Slack.
