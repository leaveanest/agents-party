---
name: shipper-communication-drafter
description: Draft shipper-facing logistics updates from rough internal context. Use when internal notes or huddle summaries need to become a concise external status message.
---

# Shipper Communication Drafter

Use this skill to convert rough internal status into a customer-facing update.
The user may provide incomplete facts, shorthand, or a spoken summary.

## Workflow

1. Identify the confirmed operational facts.
2. Draft a calm external update that states:
   - what happened
   - the current status
   - what is being done next
   - when the next update will come, if known
3. If critical facts are unknown, avoid overcommitting and use careful wording.
4. Add a short internal note listing assumptions or gaps when helpful.

## Output Shape

- Message Draft: ready to send to the shipper
- Internal Notes: optional assumptions, open questions, or facts to confirm

## Guardrails

- Do not promise a recovery time unless the input supports it.
- Do not expose internal blame, speculation, or unnecessary operational detail.
- Do not force the user to provide a full template first.
- Keep the message concise, clear, and practical for Slack or email reuse.
