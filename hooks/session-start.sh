#!/usr/bin/env bash
# SessionStart hook for the Horspowers Claude Code plugin.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

warning_message=""
legacy_skills_dir="${HOME}/.config/superpowers/skills"
if [ -d "$legacy_skills_dir" ]; then
    warning_message="\n\n<important-reminder>IN YOUR FIRST REPLY AFTER SEEING THIS MESSAGE YOU MUST TELL THE USER:⚠️ **WARNING:** Horspower now uses Claude Code's skills system. Custom skills in ~/.config/superpowers/skills are not loaded; move them to ~/.claude/skills.</important-reminder>"
fi

project_identity_kind=$(PLUGIN_ROOT="$PLUGIN_ROOT" node --input-type=module -e '
import path from "node:path";
import { pathToFileURL } from "node:url";
const moduleUrl = pathToFileURL(path.join(process.env.PLUGIN_ROOT, "lib/project-identity.mjs")).href;
const { identifyGitProject } = await import(moduleUrl);
const identity = await identifyGitProject(process.cwd());
process.stdout.write(identity.kind);
' 2>/dev/null || printf 'none')

upgrade_message=""
if [ "$project_identity_kind" = "company" ] || [ "$project_identity_kind" = "ambiguous_company_remote" ] || [ "$project_identity_kind" = "none" ]; then
    config_marker="<external-document-runtime-not-ready identity=\"$project_identity_kind\">Horspowers 外置文档运行时尚未就绪；未执行本地配置、升级或文档操作。</external-document-runtime-not-ready>"
else
    version_marker="$PWD/.horspowers-version"
    needs_upgrade_check="false"
    if [ ! -f "$version_marker" ]; then
        needs_upgrade_check="true"
    else
        marker_version=$(cat "$version_marker" 2>/dev/null || printf '0.0.0')
        needs_upgrade_check=$(MARKER_VERSION="$marker_version" node -e '
const current = (process.env.MARKER_VERSION || "0.0.0").split(".").map(Number);
const baseline = [4, 2, 0];
let lower = false;
for (let index = 0; index < Math.max(current.length, baseline.length); index += 1) {
  const left = current[index] || 0;
  const right = baseline[index] || 0;
  if (left < right) { lower = true; break; }
  if (left > right) break;
}
console.log(lower);
' 2>/dev/null || printf 'false')
    fi

    if [ "$needs_upgrade_check" = "true" ]; then
        if [ -d "$PWD/document-driven-ai-workflow" ]; then
            upgrade_message="\n\n<upgrade-needed>⚠️ 检测到旧 document-driven-ai-workflow 目录。运行 /upgrade 或 node lib/version-upgrade.js 后再清理旧目录。</upgrade-needed>"
        elif [ -d "$PWD/.docs" ] || [ -d "$PWD/doc" ] || [ -d "$PWD/document" ]; then
            upgrade_message="\n\n<upgrade-needed>⚠️ 检测到旧文档目录。运行 /upgrade 或 node lib/version-upgrade.js 迁移。</upgrade-needed>"
        fi
    fi

    config_status=$(PLUGIN_ROOT="$PLUGIN_ROOT" node -e '
const path = require("path");
const root = process.env.PLUGIN_ROOT;
const { detectConfigFiles, readConfig, checkConfigUpdate, validateConfig } = require(path.join(root, "lib/config-manager.js"));
const files = detectConfigFiles(process.cwd());
if (files.hasOld && !files.hasNew) {
  console.log("needs-migration");
} else if (!files.hasNew) {
  console.log("needs-init");
} else {
  const config = readConfig(process.cwd());
  if (!config || !validateConfig(config).valid) console.log("invalid");
  else if (checkConfigUpdate(config).needsUpdate) console.log("needs-update");
  else console.log("valid");
}
' 2>/dev/null || printf 'invalid')

    case "$config_status" in
        needs-init)
            config_marker="<config-needs-init>true</config-needs-init>"
            ;;
        needs-migration)
            config_marker="<config-needs-migration>true</config-needs-migration>"
            ;;
        needs-update)
            config_marker="<config-needs-update>true</config-needs-update>"
            ;;
        invalid)
            config_marker="<config-invalid>true</config-invalid>"
            ;;
        valid)
            config_marker="<config-valid>true</config-valid>"
            ;;
        *)
            config_marker="<config-exists>false</config-exists>"
            ;;
    esac
fi

skill_content=$(cat "${PLUGIN_ROOT}/skills/using-horspowers/SKILL.md" 2>/dev/null || printf 'Error reading using-horspowers skill')
SKILL_B64=$(printf '%s' "$skill_content" | base64) \
WARNING_B64=$(printf '%s' "$warning_message" | base64) \
UPGRADE_B64=$(printf '%s' "$upgrade_message" | base64) \
CONFIG_MARKER_B64=$(printf '%s' "$config_marker" | base64) \
node -e '
const { Buffer } = require("buffer");
const decode = (name) => Buffer.from(process.env[name] || "", "base64").toString("utf8");
const skill = decode("SKILL_B64");
const warning = decode("WARNING_B64");
const upgrade = decode("UPGRADE_B64");
const configMarker = decode("CONFIG_MARKER_B64");
const context = [
  "<EXTREMELY_IMPORTANT>",
  "You have horspowers. The compact horspowers:using-horspowers entrypoint follows.",
  skill,
  configMarker,
  "On the next substantive user message, resolve and call the documented route-request.mjs through safe stdin. SessionStart performs no project initialization, qmd query, or target-Skill routing.",
  upgrade,
  warning,
  "</EXTREMELY_IMPORTANT>"
].filter(Boolean).join("\n\n");
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }, null, 2));
'
