# Claude Code PM Orchestrator — Starter Kit

[![Validate](https://github.com/msintim/claude-code-pm-orchestrator/actions/workflows/validate.yml/badge.svg)](https://github.com/msintim/claude-code-pm-orchestrator/actions/workflows/validate.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A battle-tested operating model for running Claude Code as a **Project Manager** that plans, delegates to sub-agents, gates merges and deployments through adversarial review, and keeps continuity across sessions via a markdown memory vault.

This is extracted and genericized from a real multi-project setup. The specific project names, personal quota readings, and incident dates have been stripped — what's left is the reusable mechanics.

## What's in here

- **`CLAUDE.md`** — the core orchestrator prompt. Drop this in as your global `~/.claude/CLAUDE.md` (applies to every project) or a single project's `CLAUDE.md`. It opens with a guard telling sub-agents to skip the PM role, because Claude Code loads `CLAUDE.md` into sub-agents too.
- **`agents/opus-reviewer.md`** — whole-branch pre-merge review gate, pinned to a high-capability model.
- **`agents/opus-security-auditor.md`** — pre-deployment security gate.
- **`agents/opus-architect.md`** — architecture adjudication / ADRs for high-stakes design decisions.
- **`agents/Explore.md`** — read-only codebase search agent (overrides Claude Code's built-in `Explore`). Runs on the Standard tier instead of inheriting the PM's (more expensive) model; pass `model: "haiku"` per call for pure file/symbol lookups. It uses the floating `sonnet` alias on purpose: it isn't a gate, so tracking the latest Sonnet is fine. Its tools are an allowlist (`Read, Grep, Glob, Bash`), so it gets none of your MCP tools; Bash stays, so "read-only" is enforced by its prompt, not by permissions.

## Requirements

- **Claude Code v2.1.271 or later** (`claude --version`). The Explore override relies on `omitClaudeMd` (added in v2.1.271 — older versions silently ignore it and load your whole PM prompt into every search), and older releases let `CLAUDE_CODE_SUBAGENT_MODEL` override the gate agents' pinned models.
- **v2.1.277+ recommended** — the first release that reads `AGENTS.md` directly.
- Python 3 only if you want to run the validator: `pip install -r requirements.txt && python scripts/validate.py`.

## Install

**Back up first:** these steps overwrite any existing files with the same names.

1. Copy `CLAUDE.md` to `~/.claude/CLAUDE.md` (global, all projects) or `<project>/CLAUDE.md` (single project). If a `CLAUDE.md` is already there, merge instead of replacing it.
   - **Projects that use `AGENTS.md`:** Claude Code reads `AGENTS.md` only when there is no `CLAUDE.md` in the working directory or any folder above it (your global `~/.claude/CLAUDE.md` doesn't count). Adding a project `CLAUDE.md` therefore silently stops `AGENTS.md` loading — make `@AGENTS.md` its first line, or set `"pluginConfigs": {"agents-md@builtin": {"options": {"instructionFiles": "claude-md-and-agents-md"}}}` in `settings.json`.
2. Copy the four files in `agents/` to `~/.claude/agents/`. If you already have your own `Explore.md` there, this replaces it.
3. Fill in the placeholders in `CLAUDE.md` (search for `<…>`):
   - `<WORKSPACE_ROOT>` — the folder containing your projects, e.g. `~/dev/Projects`.
   - `<YOUR_NAME>` — how you want to be addressed in reports.
   - Model IDs — verify current model IDs/names for your account; the ones here (`claude-opus-5-5`, `claude-sonnet-5`, etc.) will drift over time.
4. (Optional) Set a default sub-agent model in `~/.claude/settings.json`:
   ```json
   {
     "env": {
       "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-5"
     }
   }
   ```
   Agents that set their own `model` (like the gate agents) keep it. Never set `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` — it overrides those pins by design.
5. (Optional) Set up the memory vault — see below. Everything else works without it; you just lose cross-session continuity.

## The memory vault (optional but recommended)

Create `<WORKSPACE_ROOT>/_memory/` with:

```
_memory/
  MEMORY.md          # index — Projects section, links to everything else
  decisions.md        # settled decisions, so you don't re-litigate them
  projects/
    <project-name>.md # one file per active project
  sessions/
    YYYY-MM-DD-<topic>.md  # session logs; keep last 10, archive older
```

`MEMORY.md` starter:

```markdown
# Memory Index

## Projects
<!-- one line per active project, link to its file -->

## Recent Sessions
<!-- pinned handoffs and last few session logs -->
```

The orchestrator prompt reads `MEMORY.md` at session start and writes to it after decisions, project status changes, and completed work — no separate setup needed beyond creating the folder.

**Built-in auto memory:** Claude Code has its own per-project memory, also indexed by a file called `MEMORY.md` (under `~/.claude/projects/<project>/memory/`). They don't collide by default — different folders, and the vault is never auto-loaded — but both ask Claude to save notes. The prompt makes the vault the source of truth. If you'd rather have one system, turn the built-in one off with `"autoMemoryEnabled": false` in `~/.claude/settings.json`.

## Why this shape (the non-obvious parts)

- **Plan Verification Gate** — plans fail from *unverified* claims (a symbol that doesn't exist, a cited spec that was never saved, a reconstructed enum that drifts from the real one), not from bad planning. Grep every symbol a plan names before dispatching it.
- **Opus pinning** — the Agent tool's `model: "opus"` alias resolves to the *newest* Opus release, which is not always the one you tested against. Pin high-stakes gates to a specific Opus version through dedicated agent definitions instead of the alias, so a model upgrade doesn't silently change gate behavior mid-project.
- **Remediation earns a fresh reviewer** — a fix to a security or money path is a change to that path. The agent that wrote the findings already knows what it expects to find; it will miss what its own fix broke. A green test suite is not a confirming round — only a new reviewer, uncontaminated by the fix's context, is.
- **Parallel dispatch needs disjoint files** — two sub-agents touching the same file, even on "independent" tasks, is how work gets silently clobbered. Verify file-set overlap before parallelizing, not after.

## Customize

- No high-capability/"Opus-tier" model on your plan? Drop the pinned-agent pattern and route everything through your best available model — keep the *gate* (a fresh, adversarial review before merge/deploy), even if the model tier is uniform.
- Different OS/shell? The prompt has a short Environment section — rewrite it for your shell instead of PowerShell/Git Bash.
- Not doing multi-project orchestration? Drop the Project Registry section and the memory vault's `projects/` folder — keep the rest.
