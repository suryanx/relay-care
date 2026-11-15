# Catalyst Solo AI Hackathon — Project Rules

7-hour solo build. Problem statement arrives separately. Global config (`~/.claude/CLAUDE.md`, Graphify) still applies.

## Gate: no code before approval
1. Analyze the problem statement into four lists: **Mandatory requirements**, **Assumptions**, **Optional enhancements**, **Acceptance tests**.
2. Propose 1 recommended idea/architecture (plus at most 1 alternative) with rationale.
3. Wait for explicit user approval. Do not scaffold or write code before it.

## Build principles
- Simplest architecture that meets every mandatory requirement. Justify each dependency; no multi-agent systems unless a requirement demands it.
- Core end-to-end workflow first (input → processing → output → deployed). Secondary features only after the core works on Cloud Run.
- Modular, readable, secure, accessible (semantic HTML, keyboard, contrast), efficient, testable.
- Secrets: env vars / Secret Manager only. Never hardcode or commit keys. Keep `.env*` in `.gitignore`; commit only `.env.example`.
- Never claim something works without verifying it (run it, test it, or inspect it in the browser). Report failures honestly.

## Tools — use selectively, not automatically
- **frontend-design skill**: set typography, palette, layout, hierarchy, responsive design up front. Avoid generic AI aesthetics.
- **21st.dev MCP**: search/reuse components when it saves time. Never trigger paid generation without asking.
- **Playwright MCP**: verify the running app — interactions, responsiveness, console errors, screenshots.
- **Graphify**: only once the core app exists and dependency analysis would materially help.
- **Elephant-Goldfish (egm)**: short, targeted architecture reviews only when warranted.

## Deployment & submission
- Target: **Google Cloud Run** (container listens on `$PORT`, default 8080). Prioritize deploy reliability — deploy the core early, then iterate.
- Public GitHub repo, single branch (`main`). Repo < 10 MB: no build output, `node_modules`, datasets, or large media committed.
- Deliverables: GitHub URL, working Cloud Run URL, LinkedIn post.
- **Ask before** creating/pushing the repo, deploying, enabling APIs/billing, or publishing anything.

## Time discipline
Rough budget: analysis+approval ~0:30 · core build ~3:00 · first deploy by ~4:00 · polish/tests ~2:00 · submission assets ~0:30.
