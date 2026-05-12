---
name: agent-skill-authoring
description: Create or refine Codex skills for this repository. Use when Codex needs to add a new skill under `.agents/skills/`, improve an existing `SKILL.md`, add bundled references or scripts, or validate that a repository-local Codex skill stays concise, reusable, and easy to trigger correctly.
---

# Agent Skill Authoring

Author Codex skills here as compact, reusable folders under `.agents/skills/`.
Keep the trigger description precise, keep the main instructions short, and move long supporting material into `references/` or `scripts/`.

## Workflow

1. Decide whether the task needs a skill.
   - Create a skill when the workflow will recur and benefits from reusable instructions or helper scripts.
   - Skip a new skill when a one-off code change or short explanation is enough.
2. Define the trigger surface first.
   - Choose a lowercase hyphenated skill name.
   - Write a description that states both what the skill does and when it should trigger.
   - Keep the folder name identical to the skill name.
3. Scaffold the skill under `.agents/skills/`.
   - Run `vp exec tsx scripts/init_codex_skill.ts` to create a new local Codex skill skeleton.
   - Create only the directories the skill actually needs.
4. Keep `SKILL.md` lean.
   - Put the workflow, guardrails, and repository-specific decisions in `SKILL.md`.
   - Move long examples, checklists, and domain detail into `references/`.
   - Add scripts only when the same code would otherwise be rewritten repeatedly.
5. Validate after editing.
   - Run `vp exec tsx scripts/validate_codex_skill.ts <skill>` to check the folder layout and frontmatter.
   - Forward-test the skill on a realistic task if the workflow is non-trivial.

## References

- Read `references/skill-best-practices.md` for naming, structure, and progressive disclosure rules.
- Read `references/repo-integration-checklist.md` before treating a skill as a standard repository workflow.

## Guardrails

- Do not bloat `SKILL.md` with long prose that belongs in `references/`.
- Do not create unrelated helper files that the skill never uses.
- Do not write broad descriptions that would trigger on unrelated requests.
- Do not add scripts that merely wrap a trivial one-line command.
