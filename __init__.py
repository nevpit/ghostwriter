from __future__ import annotations

from pathlib import Path

from .screenplay.tools import TOOLS


def _skill_frontmatter(skill_md: Path) -> tuple:
    """Read the single-line frontmatter fields used by bundled skills."""
    try:
        raw = skill_md.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return {}, ""
    lines = raw.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, ""
    fm = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if ":" not in line:
            continue
        key, _sep, value = line.partition(":")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in (chr(34), chr(39)):
            value = value[1:-1]
        fm[key.strip()] = value
    return fm, str(fm.get("description", ""))


def register(ctx) -> None:
    """Register the ghostwriter tools and bundled per-format skills."""
    for name, schema, handler, emoji in TOOLS:
        ctx.register_tool(
            name=name,
            toolset="screenplay",
            schema=schema,
            handler=handler,
            emoji=emoji,
        )

    # Bundled, versioned, per-format skills. Each skills/<doctype>/SKILL.md is
    # served read-only as ghostwriter:<doctype> (not copied into the user skills
    # dir, so it updates with the plugin; a customized copy is a separate skill).
    skill_dir = Path(__file__).resolve().parent / "skills"
    register_skill = getattr(ctx, "register_skill", None)
    if skill_dir.is_dir() and register_skill is not None:
        for doctype in sorted(p.name for p in skill_dir.iterdir() if (p / "SKILL.md").is_file()):
            skill_md = skill_dir / doctype / "SKILL.md"
            frontmatter, description = _skill_frontmatter(skill_md)
            register_skill(
                doctype,
                skill_md,
                description=description or f"How to use the ghostwriter {doctype} tools.",
                frontmatter=frontmatter or None,
            )
