---
name: web-research-agent
description: "Plan and execute source-backed web research in Codex. Use when a task requires browsing for up-to-date facts, official documentation, market scans, product comparisons, or cited summaries from the public web."
---

# Web Research Agent

Turn broad web research requests into concise, source-backed answers.
Bias toward current primary sources, make time sensitivity explicit, and separate verified facts from inference.

## Workflow

1. Frame the research target before searching.
   - State the question to answer, the likely decision it informs, and which parts are time-sensitive.
   - Decide whether the task needs current facts, historical context, recommendations, or a comparison table.
2. Search from primary sources outward.
   - Start with official documentation, vendor pages, standards bodies, government datasets, or original papers when available.
   - Add reputable secondary coverage only to fill gaps, compare viewpoints, or confirm market context.
3. Check recency and scope on every unstable fact.
   - Record exact dates, versions, prices, regions, and availability windows when they matter.
   - Treat claims such as `latest`, `current`, `today`, and `best` as requiring explicit verification.
4. Synthesize only what is supported.
   - Lead with the direct answer or recommendation.
   - Link every substantive claim to a source.
   - Call out uncertainty, source conflicts, and any assumptions made from incomplete evidence.
5. Keep the result decision-ready.
   - Use a short summary first, then the key findings, then open questions or risks.
   - When the research feeds implementation work, extract the concrete constraints and decisions that affect code or architecture.

## Source Rules

- Prefer primary sources over summaries.
- Use multiple sources for recommendations, product comparisons, legal or policy questions, and anything time-sensitive.
- Quote sparingly and paraphrase by default.
- Avoid SEO-style roundups, undated blog posts, and content farms when better sources exist.

## Guardrails

- Do not claim something is current without checking the web.
- Do not blur observed facts with your own synthesis; label inference clearly.
- Do not hide missing evidence. Say what you could not verify.
- Do not over-collect sources. Stop once the answer is well-supported and the remaining uncertainty is explicit.
