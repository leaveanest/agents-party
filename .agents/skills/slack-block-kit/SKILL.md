---
name: slack-block-kit
description: Design, implement, or review Slack Block Kit messages, modals, buttons, selects, App Home views, and interaction handlers in this repository. Use when changing Slack UI blocks or debugging Slack invalid_blocks, missing interactions, modal state, or layout behavior.
---

# Slack Block Kit

Use this skill when work touches Slack Block Kit payloads in `src/slack/`, especially messages, modals, App Home, buttons, select menus, `block_actions`, `view_submission`, or Slack API errors such as `invalid_blocks`.

## Workflow

1. Start from the Slack surface.
   - Identify whether the payload is a message, modal, App Home view, or assistant/thread surface.
   - Confirm whether the desired layout is a section accessory, an `actions` row, an input block, or modal submit/close controls.
   - For current Slack behavior or a specific API error, check official Slack Block Kit docs before editing.
2. Trace the interaction contract.
   - Find the `action_id`, `block_id`, `callback_id`, and `private_metadata` in `src/slack/interactiveIds.ts`, `src/slack/events.ts`, and `src/slack/agentHandlers.ts`.
   - Verify every interactive element has a registered handler path or intentionally shares a handler through distinct `action_id`s and common value metadata.
   - Carry Slack `teamId` with channel, user, thread, and message identifiers.
3. Build valid Block Kit.
   - Keep buttons that should appear horizontally in the same `actions` block.
   - Make `action_id` unique among elements in the same containing block.
   - Make `block_id` stable enough for state reads but unique per logical block in a payload.
   - Put select inputs inside `input` blocks for modals when their values must be read on submit.
4. Preserve repository boundaries.
   - Keep Slack SDK and Block Kit construction inside `src/slack/`.
   - Keep provider/model routing rules in repository-owned modules; do not leak AI SDK types into Slack handlers.
   - Keep user-facing text in `src/i18n/resources.ts`.
5. Validate the user-visible path.
   - Add or update tests in `tests/slack/agentHandlers.test.ts` for serialized blocks and submission state.
   - Include a negative-path test for Slack validation mistakes that have already occurred, such as duplicate `action_id`s in one actions block.
   - Run `vp check --fix`, the targeted Slack tests, `vp run typecheck`, and `vp pack` when TypeScript changed.
   - Rebuild the local containers when Slack behavior needs immediate manual verification.

## References

- Read `references/block-kit-review-checklist.md` before changing non-trivial Slack Block Kit payloads.

## Guardrails

- Do not split buttons into separate blocks just to avoid duplicate `action_id`; use distinct action IDs when the intended layout is horizontal.
- Do not infer Block Kit rules from old screenshots or memory when Slack rejects a payload; verify against official docs.
- Do not add visible explanatory text when the desired Slack surface is an action menu.
- Do not store routing context in Slack payloads without `teamId`.
