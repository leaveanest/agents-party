# Block Kit Review Checklist

Use this checklist when implementing or reviewing Slack Block Kit in this repository.

## Official Docs To Recheck

- Actions block: `https://docs.slack.dev/reference/block-kit/blocks/actions-block/`
- Button element: `https://docs.slack.dev/reference/block-kit/block-elements/button-element/`
- Input block: `https://docs.slack.dev/reference/block-kit/blocks/input-block/`
- Static select: `https://docs.slack.dev/reference/block-kit/block-elements/static-select-menu-element/`
- Multi static select: `https://docs.slack.dev/reference/block-kit/block-elements/multi-select-menu-element/`
- Modals: `https://docs.slack.dev/surfaces/modals/`
- Block actions payload: `https://docs.slack.dev/reference/interaction-payloads/block_actions-payload/`

## Payload Validity

- `actions` block elements are rendered as one horizontal action row.
- A single `actions` block can contain multiple buttons, but each element's `action_id` must be unique within that block.
- Use different `action_id`s for different buttons even when they route to the same handler; put the operation scope in the button `value`.
- `block_id` should be unique for each block in a message or view and should change when updating a message iteration if Slack needs to distinguish state.
- Keep button text short enough for Slack's compact layout.
- Keep message top-level `text` useful as fallback and notification text; do not rely on it as the primary visible UI if blocks carry the real surface.

## Modal State

- Inputs that must be read in `view_submission` should be inside `input` blocks with predictable `block_id` and element `action_id`.
- For selects, verify `initial_option` is one of the exact options in the same element.
- For multi-selects, verify every `initial_options` entry appears in `options`.
- Keep modal `private_metadata` small, JSON-parseable, and scoped with `teamId`.
- Treat `channelId`, `userId`, message timestamps, and `threadTs` as scoped by Slack team/workspace.

## Interaction Routing

- Register every action id in `src/slack/events.ts`, or intentionally register several action ids to the same handler.
- Parse button `value` defensively and reject missing `teamId` or scope-specific identifiers at the server boundary.
- Avoid depending on label text to determine behavior; use action ids and JSON metadata.
- Preserve authorization checks before saving workspace, channel, thread, credential, or provider settings.

## Tests

- Serialize the generated payload and assert important labels, action ids, block ids, and metadata.
- Assert unwanted controls are absent, especially when one modal is scoped to channel or thread settings only.
- Add regression tests for Slack API validation constraints when a bug was caused by invalid payload shape.
- Test modal submissions with realistic `view.state.values` keyed by the expected `block_id` and `action_id`.

## Common Failure Patterns

- Duplicate `action_id` values inside one `actions` block cause Slack `invalid_blocks`.
- Moving buttons into separate `actions` blocks changes layout from horizontal to vertical.
- Missing `teamId` in button values or modal metadata makes Slack channel/thread/user ids ambiguous.
- A modal can open but show no selector when options are filtered to an empty list.
- `initial_option` not present in `options` can make Slack reject or omit the control.
