#!/usr/bin/env bash
#
# 生成 GitHub Release 的正文 / Compose the GitHub Release body.
#
# 用法 / Usage:  bash .github/scripts/release-body.sh <tag>     # 例如 v0.2.15
#
# 正文 = UPDATE.md 里该 tag 对应的更新日志段，结构对齐上游：
#
#     ## 更新日志 / Changelog
#         <中文段：### 新功能 / ### 问题修复 / 优化 / ### 验证>
#     ---
#     ## Changelog (English)
#         <英文段：### What's New / ### Bug Fixes / ### Validation>
#
# UPDATE.md 的版本段约定：中文在前、`---` 分隔、英文在后（`## v0.2.13` 起采用）。
# 段内没有 `---` 时（例如只有中文的旧版本），只输出中文段，不报错。
#
# 这是发布正文的唯一来源：macOS 与 Windows 两套 workflow 都调它，正文因此完全一致，
# 谁先跑完都不会把对方的正文覆盖成另一份。UPDATE.md 里没有对应版本段时给出占位说明
# 并正常退出，不让发布步骤失败。
#
# 注意：脚本内含中文，变量一律写 ${VAR}——全角标点紧跟 $VAR 会被 bash 算进变量名，
# 在 UTF-8 locale 下直接 unbound variable（2026-09-20 已在别处踩过）。
#
set -euo pipefail

tag="${1:-}"
if [ -z "${tag}" ]; then
  echo "usage: release-body.sh <tag>" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
changelog_file="${repo_root}/UPDATE.md"

# 版本段：从 `## <tag>` 到下一个 `## v...` 之前。终止条件必须是 `## v<数字>`——
# 段内含 `## Changelog (English)`（也是 `## ` 开头），用 `^## ` 会把它当成段尾。
section=""
if [ -f "${changelog_file}" ]; then
  section="$(awk -v want="${tag}" '
    $0 ~ "^## " want "[[:space:]]*$" { inside = 1; next }
    inside && /^## v[0-9]/ { exit }
    inside { print }
  ' "${changelog_file}")"
fi

if [ -z "${section}" ]; then
  cat <<EOF
## 更新日志 / Changelog

本版本在 \`UPDATE.md\` 中没有对应的更新记录。

No changelog entry for this version was found in \`UPDATE.md\`.
EOF
  exit 0
fi

# 首尾去空行，并去掉结尾的分隔线（版本段之间的 `---`）
trimmed="$(printf '%s\n' "${section}" | awk '
  { buf[++n] = $0 }
  END {
    first = 1
    while (first <= n && buf[first] ~ /^[[:space:]]*$/) first++
    last = n
    while (last >= first && (buf[last] ~ /^[[:space:]]*$/ || buf[last] == "---")) last--
    for (i = first; i <= last; i++) print buf[i]
  }
')"

# 在第一条独立的 `---` 处切成中文段 / 英文段（只切一次）。
# 英文段开头若写了 `## Changelog (English)`（UPDATE.md 里为了自读性保留），
# 这里剥掉——标题由本脚本统一输出，避免页面出现两个同名标题。
cn="$(printf '%s\n' "${trimmed}" | awk '/^---[[:space:]]*$/ && !done { done = 1; exit } { print }')"
en="$(printf '%s\n' "${trimmed}" | awk '
  /^---[[:space:]]*$/ && !done { done = 1; next }
  done {
    if (!started) {
      if ($0 ~ /^[[:space:]]*$/) next
      if ($0 ~ /^##[[:space:]]+Changelog[[:space:]]*\(English\)[[:space:]]*$/) next
      started = 1
    }
    print
  }
')"

# 去掉尾随空行
trim_tail() {
  awk '{ buf[++n] = $0 } END { while (n >= 1 && buf[n] ~ /^[[:space:]]*$/) n--; for (i = 1; i <= n; i++) print buf[i] }'
}

{
  printf '## 更新日志 / Changelog\n\n'
  printf '%s\n' "${cn}" | trim_tail
  if [ -n "$(printf '%s' "${en}" | tr -d '[:space:]')" ]; then
    printf '\n---\n\n## Changelog (English)\n\n'
    printf '%s\n' "${en}" | trim_tail
  fi
}
