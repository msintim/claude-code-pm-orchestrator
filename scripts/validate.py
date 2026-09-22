#!/usr/bin/env python3
"""Validate the starter kit's structure: agent frontmatter parses, core prompt has its placeholders."""

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
REQUIRED_AGENT_KEYS = {"name", "description", "model"}
REQUIRED_PLACEHOLDERS = ("<WORKSPACE_ROOT>", "<YOUR_NAME>")

errors = []


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
        errors.append(f"{path}: invalid YAML frontmatter — {exc}")
        return
    if not isinstance(data, dict):
        errors.append(f"{path}: frontmatter did not parse to a mapping")
        return
    missing = REQUIRED_AGENT_KEYS - data.keys()
    if missing:
        errors.append(f"{path}: frontmatter missing required key(s): {sorted(missing)}")


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

    if errors:
        print("Validation failed:")
        for e in errors:
            print(f"  - {e}")
        return 1

    print(f"OK: {len(agent_files)} agent file(s) validated, CLAUDE.md placeholders present.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
