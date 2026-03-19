---
name: handover-brief-builder
description: Build a concise logistics handover brief from Slack threads or huddle notes. Use when a shift change, route handoff, or team transition needs a short operational summary.
---

# Handover Brief Builder

Use this skill to turn scattered operational context into a compact handover note.
The source material may be noisy, repetitive, or incomplete.

## Workflow

1. Pull out the current state of the situation.
2. Identify what is still unresolved.
3. Note waiting items such as customer replies, driver confirmation, or depot checks.
4. Highlight risks or watch-outs for the next person.
5. End with the next concrete actions.

## Output Shape

- Current State
- Open Items
- Waiting On
- Watch Outs
- Next Actions

## Guardrails

- Do not rewrite the whole conversation.
- Do not invent ownership or status when it is not stated.
- Prefer terse operational bullets over narrative prose.
- Keep the brief usable as a shift handoff inside Slack.
