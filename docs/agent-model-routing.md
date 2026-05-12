# Agent And Model Routing

This document describes the target routing policy for Slack AI execution.

## Status

This is the implemented product direction. Slack routing decisions come from explicit workspace, channel, and thread configuration; the TypeScript runner does not infer specialists from prompt keywords.

## Policy

Agent and model selection are configuration decisions, not prompt-text guesses.

When a Slack event needs an AI response, the routing layer resolves:

1. thread-level agent and model
2. channel-level default agent and model
3. workspace-level default agent and model
4. application fallback only where explicitly configured for local or bootstrap use

Thread settings have the highest precedence because a thread is the active conversation boundary. A thread may be pinned to a specific agent/model after the first response, or changed later by an explicit management action.

Channel defaults are used for new conversations in that channel. Workspace defaults are used only when the channel has no override.

## Responsibilities

- Slack handlers validate the event, enforce channel/thread policy, fetch needed Slack context, and call the routing layer.
- The routing layer resolves the effective agent, effective model, auto-reply policy, and thread state.
- `AgentRunner` executes an already-resolved agent with an already-resolved model.
- `ProviderRouter` enforces model registry and capability checks before provider invocation.
- Specialist runtimes are implementation details of an agent, not a global keyword router.

## Non-Goals

- Do not select the primary agent by matching keywords in the user message.
- Do not infer the provider from model name strings outside the model registry.
- Do not let Slack handlers call provider SDKs directly.
- Do not silently fall back to a different model when the configured model lacks required capabilities.

## Specialist Behavior

Agents may still use specialists internally. For example, a configured travel assistant may call a maps runtime, or a configured media agent may call image generation.

Those choices are scoped to the selected agent. They should not replace the top-level workspace/channel/thread agent selection policy.

## Thread Persistence

After a response, the thread state should record the effective agent id and, when configured at thread scope, the effective model id. Follow-up messages continue with that stored route when auto-reply is enabled and the channel/thread policy allows it.

If the configured agent is disabled or the configured model is unknown, routing should fail closed with a clear Slack-visible fallback and structured logs naming the failed route.
