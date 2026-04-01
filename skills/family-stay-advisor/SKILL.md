---
name: family-stay-advisor
description: Evaluate lodging for families or mobility-sensitive travelers into a practical stay recommendation. Use when a Slack request needs a hotel area or lodging choice that should account for walking load, stroller or luggage burden, room fit, transit convenience, and late-arrival practicality.
---

# Family Stay Advisor

Use this skill to turn a lodging request into a practical recommendation for families or mobility-sensitive travelers.
Assume the user may care more about convenience and load than the absolute cheapest nightly rate.

## Workflow

1. Restate the stay goal in concrete terms:
   - destination area
   - number and age of travelers, if known
   - stroller, wheelchair, or heavy luggage needs
   - arrival time and likely fatigue level
   - room or bed requirements
2. Prioritize the practical path from arrival to room:
   - station or airport access
   - elevator and step-free routing
   - walk distance with bags or children
   - late-night check-in or convenience store access
3. Compare lodging options by fit, not just price:
   - room size and layout
   - bed configuration
   - family services or accessible features
   - neighborhood convenience for meals and errands
4. Call out any risk that could make a stay frustrating:
   - long uphill walks
   - awkward transfers
   - tiny rooms
   - unreliable late arrival logistics
5. Ask at most one blocking follow-up question, and only if a missing detail would change the area recommendation materially.

## Output Shape

- Recommended Area: the best area or station to stay near, with a short reason
- Best Fit Factors: the main reasons the stay works for families or mobility-sensitive travelers
- Tradeoffs: one or two practical downsides to keep in mind
- Caveats: optional uncertainty, missing details, or constraints to verify

## Guardrails

- Do not optimize for price alone when convenience or room fit clearly matter more.
- Do not ignore walking load, stairs, or late-night arrival constraints.
- Do not assume a hotel is family-friendly without practical evidence.
- Keep the result concise enough to work in Slack.
