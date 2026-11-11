"""Cross-reference test: bundled skills must only reference tools that exist.

Catches drift between the bundled per-format skills (``skills/*/SKILL.md`` and
their ``references``) and the plugin's ``provides_tools`` (``plugin.yaml``). If
a skill mentions a ``ghost_*`` / ``ghostwriter_*`` tool that is not in
``provides_tools`` (renamed, removed, or a typo), this fails the same day — so
the skill can never point the agent at a tool that doesn't exist.
"""
import re
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent
TOOL_RE = re.compile(r"\b(ghostwriter_[a-z0-9_]+|ghost_[a-z0-9_]+)\b")


def _provides_tools():
    text = (PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8-sig", errors="replace")
    tools, in_block = set(), False
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("provides_tools:"):
            in_block = True
            continue
        if in_block:
            if s.startswith("- "):
                tools.add(s[2:].strip())
            elif s == "":
                continue
            else:
                break
    return tools


def _skill_text():
    skill_dir = PLUGIN_DIR / "skills"
    parts = []
    if skill_dir.is_dir():
        for p in sorted(skill_dir.rglob("*.md")):
            parts.append(p.read_text(encoding="utf-8-sig", errors="replace"))
    return "\n".join(parts)


def test_bundled_screenplay_skill_exists():
    smd = PLUGIN_DIR / "skills" / "screenplay" / "SKILL.md"
    assert smd.is_file(), f"bundled screenplay skill missing: {smd}"


def test_skill_frontmatter_name_matches_dir():
    smd = PLUGIN_DIR / "skills" / "screenplay" / "SKILL.md"
    text = smd.read_text(encoding="utf-8-sig", errors="replace")
    name = None
    for line in text.split("---", 2)[1].splitlines():
        if line.strip().lower().startswith("name:"):
            name = line.split(":", 1)[1].strip().strip(chr(34)).strip(chr(39)).strip()
            break
    assert name == "screenplay", f"frontmatter name {name!r} != dir name 'screenplay'"


def test_skill_only_references_known_tools():
    tools = _provides_tools()
    mentioned = set(TOOL_RE.findall(_skill_text()))
    unknown = mentioned - tools
    assert not unknown, f"skill references tools not in provides_tools: {sorted(unknown)}"
    assert mentioned, "no ghost_* tool referenced in any bundled skill (empty stub?)"
