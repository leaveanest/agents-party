---
name: lodging-search-advisor
description: Evaluate lodging options from a travel request into a short, decision-ready stay recommendation. Use when a Slack request asks where to stay near a destination, station, event area, or meeting point, especially when tradeoffs like budget, transit access, neighborhood fit, or late arrival matter.
---

# Lodging Search Advisor

Use this skill to turn a vague stay request into a practical short list.
Assume the user may provide only a city, station, venue, or purpose of trip.

## Workflow

1. Restate the stay goal in concrete terms:
   - destination area
   - trip purpose
   - check-in constraints
   - budget level
   - non-negotiables such as walkability, quietness, or family fit
2. Prioritize location before hotel marketing copy:
   - access to the destination
   - access from major stations or airports
   - neighborhood safety and late-night convenience
   - likely transit or taxi burden
3. Compare options using practical tradeoffs:
   - closest stay
   - best transit-balanced stay
   - best value stay
4. Call out what could change the recommendation:
   - very late arrival
   - early departure
   - luggage-heavy travel
   - weekend or event-driven price spikes
5. Ask at most one blocking follow-up question, and only if budget or destination ambiguity would materially change the area recommendation.

## Output Shape

- Recommended Area: the best area or station to stay near, with a one-line reason
- Top Options: two or three candidate stays or area types with short tradeoffs
- Transit Notes: practical access notes for the main destination
- Caveats: optional uncertainty, pricing volatility, or missing details

## Guardrails

- Do not rank properties on vibes alone when access or logistics point elsewhere.
- Do not assume the cheapest option is the best fit.
- Do not ignore late-night arrival, steep transfers, or long uphill walks when they matter.
- Keep the result concise enough to work in Slack.
