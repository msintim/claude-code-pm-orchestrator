#!/usr/bin/env python3
"""Validate the starter kit's structure: agent frontmatter parses and is well-formed, core prompt has its placeholders."""

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
REQUIRED_AGENT_KEYS = {"name", "description", "model"}
# Sub-agent frontmatter keys documented at https://code.claude.com/docs/en/sub-agents
KNOWN_AGENT_KEYS = REQUIRED_AGENT_KEYS | {
    "tools", "disallowedTools", "permissionMode", "maxTurns", "skills", "mcpServers", "hooks",
    "memory", "background", "omitClaudeMd", "effort", "isolation", "color", "initialPrompt", "experimental",
}
MODEL_ALIASES = {"sonnet", "opus", "haiku", "fable", "inherit"}
# Anthropic-API model IDs, incl. dated/legacy ones and the [1m] suffix; Bedrock/Vertex IDs are not covered.
FULL_MODEL_ID = re.compile(r"^claude-[a-z0-9]+(-[a-z0-9]+)*(\[1m\])?$")
GATE_AGENT_PREFIX = "opus-"
REQUIRED_PLACEHOLDERS = ("<WORKSPACE_ROOT>", "<YOUR_NAME>")

errors = []
warnings = []


def check_agent_frontmatter(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        errors.append(f"{path}: missing YAML frontmatter (must start with '---')")
        return
    end = text.find("\n---", 4)
    if end == -1:
        errors.append(f"{path}: unterminated YAML frontmatter")
        return
    raw = text[4:end]
    try:
        data = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        errors.append(f"{path}: invalid YAML frontmatter: {exc}")
        return
    if not isinstance(data, dict):
        errors.append(f"{path}: frontmatter did not parse to a mapping")
        return
    missing = {key for key in REQUIRED_AGENT_KEYS if data.get(key) in (None, "")}
    if missing:
        errors.append(f"{path}: frontmatter missing or empty required key(s): {sorted(missing)}")
    # Warn rather than fail: Claude Code adds frontmatter keys over time, but a typo is silently ignored.
    unknown = data.keys() - KNOWN_AGENT_KEYS
    if unknown:
        warnings.append(f"{path}: unrecognized frontmatter key(s) {sorted(unknown)}: typo, or newer than this list?")

    name = data.get("name")
    if name and name != path.stem:
        errors.append(f"{path}: name {name!r} does not match filename {path.stem!r}")

    model = data.get("model")
    if model in (None, ""):
        return
    model = str(model)
    if model not in MODEL_ALIASES and not FULL_MODEL_ID.match(model):
        errors.append(f"{path}: model {model!r} is neither an alias {sorted(MODEL_ALIASES)} nor a full model ID like 'claude-opus-5-5'")
    elif path.stem.startswith(GATE_AGENT_PREFIX) and (model in MODEL_ALIASES or model.endswith("-latest")):
        errors.append(f"{path}: gate agent uses floating model {model!r}; pin a full, versioned model ID")


def check_core_prompt(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    for placeholder in REQUIRED_PLACEHOLDERS:
        if placeholder not in text:
            errors.append(f"{path}: expected placeholder {placeholder!r} not found")


def main() -> int:
    agents_dir = ROOT / "agents"
    agent_files = sorted(agents_dir.glob("*.md"))
    if not agent_files:
        errors.append(f"no agent files found under {agents_dir}")
    for path in agent_files:
        check_agent_frontmatter(path)

    claude_md = ROOT / "CLAUDE.md"
    if not claude_md.exists():
        errors.append(f"{claude_md} not found")
    else:
        check_core_prompt(claude_md)

    for w in warnings:
        print(f"warning: {w}")

    if errors:
        print("Validation failed:")
        for e in errors:
            print(f"  - {e}")
        return 1

    print(f"OK: {len(agent_files)} agent file(s) validated, CLAUDE.md placeholders present.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
