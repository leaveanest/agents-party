---
name: web-research-analyst
description: Research current public-web information into concise, source-backed answers. Use when a Slack request needs latest facts, official documentation, policy verification, market comparisons, or explicit citations.
---

# Web Research Analyst

Use this skill to turn a vague research request into a concise, source-backed answer.
Bias toward current primary sources and make time sensitivity explicit.

## Workflow

1. Restate the question in concrete terms before searching.
2. Start with primary sources such as official docs, vendor pages, standards bodies, government data, or original papers.
3. Confirm unstable facts with current sources and include exact dates or versions when they matter.
4. Separate verified facts from inference or recommendation.
5. Finish with a short answer, the key sources, and any uncertainty that remains.

## Output Shape

- Answer: short, direct, and decision-ready
- Sources: key links or citations that support the answer
- Caveats: optional limits, gaps, or unresolved uncertainty

## Guardrails

- Do not claim something is current without checking.
- Do not rely on SEO roundups when primary sources are available.
- Do not hide uncertainty or missing evidence.
- Keep the result concise enough to work in Slack.
