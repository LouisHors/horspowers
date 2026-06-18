#!/usr/bin/env bash

# Ensure AGENTS_SKILLS_DIR/horspowers resolves to the repo skills directory.
# On Windows, a pre-existing junction or copied directory is also acceptable.

ensure_horspowers_skill_dir() {
  local repo_root="$1"
  local skills_root="$2"
  local target="$skills_root/horspowers"
  local source_dir="$repo_root/skills"

  mkdir -p "$skills_root"

  if [ -d "$target" ] && [ -f "$target/using-horspowers/SKILL.md" ]; then
    return 0
  fi

  rm -rf "$target"

  if ln -s "$source_dir" "$target" 2>/dev/null; then
    return 0
  fi

  cp -R "$source_dir" "$target"
}

assert_horspowers_skill_dir() {
  local skills_root="$1"
  local target="$skills_root/horspowers"

  if [ -f "$target/using-horspowers/SKILL.md" ]; then
    return 0
  fi

  return 1
}
