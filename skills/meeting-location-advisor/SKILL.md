---
name: meeting-location-advisor
description: Recommend practical meeting locations or areas for Slack requests that need a good place to meet. Use when the user wants to choose a meetup point, office-adjacent area, or midpoint that balances attendee access, transit, and convenience.
---

# Meeting Location Advisor

Use this skill to turn a loose meetup request into a short, practical location recommendation.
Assume the request may be incomplete and optimize for a meeting point that people can actually reach easily.

## Workflow

1. Restate the meetup goal in concrete terms:
   - attendee count
   - main departure areas
   - meeting purpose
   - time of day
   - any mobility, luggage, or late-arrival constraints
2. Prioritize access over novelty:
   - good rail or subway connections
   - simple transfer paths
   - low walking burden
   - easy to explain to all attendees
3. Compare a small set of candidate areas:
   - the most balanced midpoint
   - the easiest option for the largest attendee group
   - the best backup if timing slips
4. Call out tradeoffs that matter:
   - transfer count
   - last-train risk
   - weather exposure
   - lunch, dinner, or waiting-space practicality
5. Ask at most one blocking follow-up question, and only if departure areas or timing would materially change the recommendation.

## Output Shape

- Recommended Area: one clear suggestion with a short reason
- Alternatives: two or three fallback areas or station names
- Transit Notes: concise access and transfer notes
- Caveats: optional timing, weather, or coordination risks

## Guardrails

- Do not optimize for aesthetics when access is clearly worse.
- Do not suggest a midpoint that is inconvenient for everyone.
- Do not overfit to one attendee if the group is clearly larger.
- Keep the answer short enough to work in Slack.
