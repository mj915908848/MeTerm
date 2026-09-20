#!/bin/bash
# build-dmg.sh — 组装 macOS 分发用 DMG（本地 build-macos.sh 与 CI 共用这一份实现）
#
# 用法 / Usage:
#   build-dmg.sh <app_path> <output_dmg> [volume_name]
#
# 映像内的布局 / Layout inside the volume:
#   MeTerm.app               拖到「应用程序」即可完成安装
#   Applications             指向 /Applications 的快捷方式
#
# 分发说明 / Distribution note:
#   本 fork 不做 Developer ID 签名与公证，接收方首次打开会被 Gatekeeper 拦下；
#   放行方式见 README 的「macOS 首次打开被拦下怎么办」。
#
#   映像内**刻意不放任何脚本**：整个磁盘映像带隔离来源，卷内脚本会被 Gatekeeper
#   判为 `rejected / source=no usable signature`（spctl 实测），双击只会弹
#   「Apple 无法验证…」，比不给更好吗？不会 —— 它只会让接收方以为包坏了。
#   安装方式保持 macOS 的标准姿势：拖进「应用程序」，首次打开走系统设置放行。
#
# 打包工具 / Tools:
#   优先 create-dmg（有窗口布局），失败则回退 hdiutil。
#   两个分支都会在产出后挂载并核对内容，核对不过就换另一条路重来，
#   避免出现「构建成功但包是空的」这种情况。
set -uo pipefail

WINDOW_W=660
WINDOW_H=400
ICON_SIZE=80
ICON_Y=170
APP_X=180
DROP_X=480

log()  { printf '[dmg] %s\n' "$*"; }
ok()   { printf '[dmg] OK  %s\n' "$*"; }
warn() { printf '[dmg] !!  %s\n' "$*"; }
err()  { printf '[dmg] !!  %s\n' "$*" >&2; }

usage() {
    printf 'usage: %s <app_path> <output_dmg> [volume_name]\n' "$(basename "$0")" >&2
    exit 2
}

[ $# -ge 2 ] || usage
APP_PATH="$1"
OUTPUT_DMG="$2"
VOLUME_NAME="${3:-$(basename "${APP_PATH%.app}")}"

[ -d "$APP_PATH" ] || { err "找不到 .app：$APP_PATH"; exit 1; }
[ -f "$APP_PATH/Contents/Info.plist" ] || { err "不像一个 .app：$APP_PATH"; exit 1; }
case "$OUTPUT_DMG" in
    *.dmg) ;;
    *) err "输出必须是以 .dmg 结尾的路径：$OUTPUT_DMG"; exit 1 ;;
esac
case "$OUTPUT_DMG" in
    ""|/|.|..) err "输出路径不安全：$OUTPUT_DMG"; exit 1 ;;
esac

APP_BASENAME="$(basename "$APP_PATH")"
STAGING_DIR=""
VERIFY_MOUNT=""

cleanup() {
    if [ -n "$VERIFY_MOUNT" ]; then
        hdiutil detach "$VERIFY_MOUNT" -quiet >/dev/null 2>&1 || true
        rmdir "$VERIFY_MOUNT" >/dev/null 2>&1 || true
        VERIFY_MOUNT=""
    fi
    # create-dmg 中途失败可能留下挂着的卷
    for vol in "/Volumes/$VOLUME_NAME"; do
        if [ -d "$vol" ]; then
            hdiutil detach "$vol" -force -quiet >/dev/null 2>&1 || true
        fi
    done
    if [ -n "$STAGING_DIR" ] && [ -d "$STAGING_DIR" ]; then
        rm -rf "$STAGING_DIR" >/dev/null 2>&1 || true
        STAGING_DIR=""
    fi
}
trap cleanup EXIT INT TERM

make_staging() {
    local temp_root="${TMPDIR:-/tmp}"
    temp_root="${temp_root%/}"
    STAGING_DIR="$(mktemp -d "$temp_root/meterm-dmg.XXXXXXXX")" || {
        err "无法创建临时目录"; exit 1
    }
    chmod 700 "$STAGING_DIR"
    ditto "$APP_PATH" "$STAGING_DIR/$APP_BASENAME" || { err "复制 .app 到暂存目录失败"; exit 1; }
}

try_create_dmg() {
    log "用 create-dmg 打包…"
    create-dmg \
        --volname "$VOLUME_NAME" \
        --window-size "$WINDOW_W" "$WINDOW_H" \
        --icon-size "$ICON_SIZE" \
        --icon "$APP_BASENAME" "$APP_X" "$ICON_Y" \
        --app-drop-link "$DROP_X" "$ICON_Y" \
        "$OUTPUT_DMG" \
        "$STAGING_DIR"
}

try_hdiutil() {
    log "用 hdiutil 打包…"
    ln -s /Applications "$STAGING_DIR/Applications" || { err "创建 Applications 快捷方式失败"; return 1; }
    rm -f "$OUTPUT_DMG"
    hdiutil create -quiet -volname "$VOLUME_NAME" -srcfolder "$STAGING_DIR" \
        -ov -format UDZO "$OUTPUT_DMG"
}

verify_dmg() {
    local dmg="$1"
    [ -f "$dmg" ] || { warn "没有产出文件"; return 1; }
    VERIFY_MOUNT="$(mktemp -d "${TMPDIR:-/tmp}/meterm-verify.XXXXXXXX")" || return 1
    if ! hdiutil attach -nobrowse -readonly -mountpoint "$VERIFY_MOUNT" "$dmg" >/dev/null 2>&1; then
        warn "无法挂载产出核对"; return 1
    fi

    local problems=0
    local app_inside=""
    app_inside="$(find "$VERIFY_MOUNT" -maxdepth 1 -name '*.app' -print -quit 2>/dev/null || true)"
    if [ -z "$app_inside" ]; then
        warn "映像内没有 .app"; problems=1
    else
        # 嵌入 Finder 扩展后如果不重签，外层 .app 就没有 _CodeSignature，
        # 接收方可能看到「已损坏，无法打开」，那时清隔离标记也救不回来。
        if [ ! -d "$app_inside/Contents/_CodeSignature" ]; then
            warn ".app 缺少 _CodeSignature —— 包签名残缺，接收方可能见到「已损坏」"
            warn "  修法：对 .app 执行 codesign --force --sign - 后再打包"
            problems=1
        elif ! codesign --verify --strict "$app_inside" >/dev/null 2>&1; then
            warn ".app 签名校验未通过：$(codesign --verify --strict "$app_inside" 2>&1 | head -1)"
        fi
    fi
    if [ ! -L "$VERIFY_MOUNT/Applications" ]; then
        warn "映像内没有 Applications 快捷方式 —— 接收方无法拖放安装"; problems=1
    fi

    hdiutil detach "$VERIFY_MOUNT" -quiet >/dev/null 2>&1 || true
    rmdir "$VERIFY_MOUNT" >/dev/null 2>&1 || true
    VERIFY_MOUNT=""
    return "$problems"
}

make_staging
mkdir -p "$(dirname "$OUTPUT_DMG")"

built=""
if command -v create-dmg >/dev/null 2>&1; then
    if try_create_dmg >/dev/null && verify_dmg "$OUTPUT_DMG"; then
        built="create-dmg"
    else
        warn "create-dmg 这条路过不了核对，回退 hdiutil"
    fi
fi

if [ -z "$built" ]; then
    if ! try_hdiutil; then
        err "hdiutil 打包失败"
        exit 1
    fi
    if ! verify_dmg "$OUTPUT_DMG"; then
        err "产出的 DMG 内容核对不通过：$OUTPUT_DMG"
        exit 1
    fi
    built="hdiutil"
fi

size="$(du -h "$OUTPUT_DMG" | cut -f1)"
ok "打包完成（${built}）：${OUTPUT_DMG}  (${size})"
log "映像内为 ${APP_BASENAME} 与 Applications 快捷方式，接收方拖放安装即可。"
exit 0
