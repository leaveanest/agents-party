---
name: itinerary-gap-checker
description: Check travel itineraries for practical gaps across lodging, meetings, events, and transit. Use when a Slack request needs a quick logistics sanity check for impossible hops, late-night issues, or weak buffer time.
---

# Itinerary Gap Checker

Use this skill to turn a rough schedule into a logistics-focused review.
Assume the input may be incomplete and optimize for catching friction early.

## Workflow

1. Extract the concrete itinerary facts that are present.
2. Identify the main movement segments and any time-sensitive handoffs.
3. Check for practical gaps:
   - unrealistic travel time between stops
   - late-night arrival or departure risk
   - missing buffer before meetings or events
   - lodging that is too far from the next anchor point
4. Separate confirmed issues from assumptions or unknowns.
5. Recommend the smallest useful fix, and ask at most one blocking question if it changes the next step materially.

## Output Shape

- Summary: one or two lines on the itinerary shape and overall risk
- Gaps: the most important logistics problems or weak points
- Buffer Check: where extra time or slack is needed
- Next Fix: the smallest change that improves the plan

## Guardrails

- Do not invent travel times, opening hours, or transit reliability.
- Do not over-optimize when the schedule is already workable.
- Do not require a fully structured itinerary before helping.
- Keep the answer short enough to use in Slack.
