# Pydantic AI Best Practices

This note distills the framework guidance that mattered for this repository.

## Model Contract

- Prefer explicit `deps_type` objects for external services and repositories.
- Prefer explicit `output_type` models when the agent should return stable structured data.
- Keep `instructions` concise and durable; put volatile detail in tool calls, references, or repository code.

## Tools And Toolsets

- Group reusable capabilities into toolsets instead of scattering many unrelated inline tools.
- Keep tool signatures narrow and typed so the model has a clear contract.
- Expose side effects intentionally; avoid tools that hide writes behind vague names.

## Multi-Agent Design

- Default to a single agent flow.
- Split into multiple agents only when the participating agents need materially different tools, permissions, or context windows.
- Prefer explicit delegation boundaries over prompt-only roleplay splits.

## Testing And Regression Control

- Use `pydantic_ai.models.test.TestModel` for fast unit tests that assert tool registration and structured outputs.
- Add broader tests only after the structural contract is stable.
- Use evals or repeatable regression cases when agent behavior becomes important enough to protect over time.

## Repository Translation

- Put framework integration helpers close to agent code, not inside Slack handlers.
- Keep Slack handlers thin; have them call agent orchestration code instead of embedding prompts or tool logic.
- Keep persistence clients behind repositories or dependency objects passed through `RunContext`.
