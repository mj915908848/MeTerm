#!/usr/bin/env bash
#
# 一次性：生成应用内自动更新用的签名密钥，并写进 GitHub Actions secrets。
# One-off: create the in-app updater signing key and store it as GitHub Actions secrets.
#
# 用法 / Usage（在自己的终端里运行 / run in your own terminal）:
#   bash scripts/setup-updater-key.sh
#
# 做的事 / What it does:
#   1. 在 ~/.tauri/meterm-updater.key 生成 minisign 私钥（随机密码，存在同目录 .password，权限 600），
#      公钥在 ~/.tauri/meterm-updater.key.pub。已存在就复用，不会覆盖。
#   2. 用 gh 设置 secrets TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD。
#   3. 打印公钥：把它填进 desktop/src-tauri/tauri.conf.json 的 plugins.updater.pubkey。
#
# 私钥务必备份（例如存进密码管理器）。丢了以后，已装的版本就再也收不到自动更新，只能手动重装。
# Back the private key up. If it is lost, installed copies can never auto-update again.
#
set -euo pipefail

repo="${REPO:-mj915908848/MeTerm}"
key_dir="${HOME}/.tauri"
key="${key_dir}/meterm-updater.key"
pw_file="${key}.password"
# 与 desktop/package.json 锁定的 CLI 同版本 / same CLI version as desktop/package.json
tauri_cli="@tauri-apps/cli@2.11.1"

command -v gh >/dev/null || { echo "需要 GitHub CLI：brew install gh && gh auth login" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh 还没登录：先运行 gh auth login" >&2; exit 1; }

mkdir -p "${key_dir}"
chmod 700 "${key_dir}"

if [ -f "${key}" ]; then
  echo "复用已有私钥 / reusing existing key: ${key}"
  [ -f "${pw_file}" ] || { echo "找不到 ${pw_file}（私钥密码）" >&2; exit 1; }
else
  umask 077
  head -c 24 /dev/urandom | base64 | tr -d '/+=' > "${pw_file}"
  npx --yes "${tauri_cli}" signer generate --ci -w "${key}" -p "$(cat "${pw_file}")"
  chmod 600 "${key}" "${pw_file}"
fi

gh secret set TAURI_SIGNING_PRIVATE_KEY --repo "${repo}" --body "$(cat "${key}")"
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo "${repo}" --body "$(cat "${pw_file}")"

echo
echo "secrets 已设置 / secrets set on ${repo}."
echo "公钥（可以公开，发给 Claude 或填进 tauri.conf.json 的 plugins.updater.pubkey）:"
echo "Public key (safe to share; goes into plugins.updater.pubkey):"
echo
cat "${key}.pub"
echo
echo
echo "记得备份 ${key} 和 ${pw_file}。"
