# MeTerm 已知缺陷 / Known Issues

> 记录已知但暂不修复的缺陷和限制，供后续版本参考。
> Known defects and limitations deferred to future versions.

---

## JS-001: 多 JumpServer 实例单窗口限制

**模块**: `jumpserver-browser-window.ts`, `jumpserver-panel.ts`

**现象**: 当连接多个 JumpServer 时，资产浏览器窗口为单实例设计（固定 label `jumpserver-browser`），后连接的 JumpServer 配置会覆盖前一个。

**影响范围**:
- `localStorage` 中的 `jumpserver-config` 会被最后一次连接覆盖
- 独立窗口和停靠面板共用同一份配置，无法同时浏览不同 JumpServer 的资产
- 面板 `startDockedBrowser()` 和独立窗口 `openJumpServerBrowser()` 均读取同一个 config key

**当前状态**: 暂不修复。99% 场景只需连接单个 JumpServer，多实例需求极低。

**未来方案**（如需支持）:
1. 窗口 label 加入 JumpServer ID 后缀，支持多窗口并存
2. `localStorage` key 按 JumpServer ID 隔离
3. 面板支持多 tab 切换不同 JumpServer

---

## LNX-001: Wayland 上窗口置顶和画中画不生效

**模块**: `toolbar.ts` (`toggleAlwaysOnTop`), `pip.ts` (`enterPip`)

**现象**: 在 Ubuntu Wayland 会话下，点击「窗口置顶」或「画中画」按钮后窗口不会置于最上层。X11 会话下正常。

**根因**: Wayland 协议的安全模型不允许应用自行设置窗口层级。`setAlwaysOnTop(true)` 底层调用 `gtk_window_set_keep_above()`，在 X11 上通过 `_NET_WM_STATE_ABOVE` hint 生效，但 Wayland 合成器（GNOME Mutter）不支持此操作。画中画依赖 `setAlwaysOnTop(true)`，因此一并不生效。

**验证方式**:
```bash
# X11 后端下正常
GDK_BACKEND=x11 cargo tauri dev
```

**当前状态**: 平台限制，暂不修复。

**可能的方案**:
1. **UI 层面**: Wayland 下隐藏置顶和画中画按钮，避免用户困惑
2. **`gtk-layer-shell`**: Wayland 专用协议扩展，可实现窗口置顶，但仅 `wlr-layer-shell` 兼容的合成器支持（Sway、Hyprland 等），GNOME Mutter **不支持**
3. **等待 Wayland 生态**: 未来 `xdg-toplevel` 扩展可能增加 always-on-top 能力

---

## LNX-002: GTK CSD 顶部微小间隙（已修复）

**模块**: `commands/window.rs` (`apply_gtk_csd`)

**现象**: Linux CSD 模式下窗口顶部有数像素的透明间隙。

**根因**: 初始使用 `GtkBox` 作为空 titlebar widget，GTK 为其分配了最小高度。

**修复**: 参照 Firefox 的实现，改用 `GtkFixed`（`gtk_fixed_new()`）作为 titlebar widget，GTK 不为其分配任何空间。

---

## MAC-001: 主窗口位置与最大化还原在 macOS 尚未实机验收

**模块**: `main.ts`, `event-listeners.ts`, `window-geometry.ts`, `window-geometry-core.ts`

**现象**: v0.2.13 起主窗口除了尺寸还会记住位置和最大化状态，并在启动时还原。该行为只在开发机构建中验证过，尚未在 macOS 实机（尤其是多显示器与外接屏拔插场景）验收。

**影响范围**:

- 多显示器下的回退逻辑（`fitGeometryToScreens`）只走过单元测试；显示器枚举失败时回退到 WebView `screen`，该回退路径未实机验证
- 未接入任何「重置窗口位置」入口，位置被还原到不可用区域时用户只能删除设置项
- 属于对 macOS 窗口行为的改动，按 `PROJECT_RULES.md` 规则 1 需项目负责人确认

**当前状态**: 暂不修复，等待 macOS 实机验收。

**验证方式**:

1. 外接显示器上启动 → 移动窗口 → 退出 → 拔掉外接屏 → 再次启动，确认窗口回退到主屏可见区域
2. 最大化状态下退出，重启确认恢复最大化

---

## MAC-002: SSH 分屏 / 重连与正式签名安装包在 macOS 未实机验收

**模块**: `main.ts`（窗口生命周期）、`ssh-tab-title.ts`、`build-macos.sh`

**现象**: v0.2.13 的 SSH 标签名称模式、v0.2.14 的分屏与重连相关改动仅在开发环境验证；正式签名与公证安装包（Developer ID + notarization）不在本次交付范围。

**影响范围**:

- 分屏会话切换主机时，标签标题与 AI 对话主机归属的联动未实机验收
- 临时签名（ad-hoc）构建通过，但分发签名安装包未构建
- 按 `PROJECT_RULES.md` 规则 1，涉及 macOS 显示与交互的改动需项目负责人确认后再合入

**当前状态**: 暂不修复，等待 macOS 实机验收与正式签名构建。

---

## MAC-003: 未签名分发的门禁放行（助手脚本方案已废弃）

**模块**: `desktop/scripts/build-dmg.sh`、`build-macos.sh`、`.github/workflows/build-macos.yml`、`README.md` / `README_CN.md`

**现象**: 本 fork 不购买 Apple Developer Program，发布包不做 Developer ID 签名与公证，接收方首次打开会被 Gatekeeper 拦下。

**曾尝试的方案（已废弃）**: v0.2.15 曾在 dmg 内附带 `Open-MeTerm.command` 做一键放行，设想是「在映像窗口里直接双击即可运行」。**该方案在 macOS 真机上不成立**，2026-09-20 实测：双击后弹出「Apple 无法验证 "Open-MeTerm.command" 是否包含可能危害 Mac 安全或泄漏隐私的恶意软件」，只有「完成」与「移到废纸篓」两个选项，无法放行。

**性质说明**: 这一条不是"修 bug"，而是弃用一个**既无法在出货前验证、又已在真机实测失败的安装路径**。

- 真机事实：2026-09-20 双击 `Open-MeTerm.command` 弹出「Apple 无法验证 "Open-MeTerm.command" 是否包含可能危害 Mac 安全或泄漏隐私的恶意软件」，只有「完成」与「移到废纸篓」，放行不了
- 本机可复现的部分只有两条：卷内文件确实不带 `com.apple.quarantine`（`xattr` 干净）；`spctl -a -vv -t exec` 对未签名脚本**无论带不带隔离属性都返回 `rejected / source=no usable signature`**（对照实测）。因此 `spctl` 不能用来判定触发条件
- 本机不具备复现"双击"的条件（无 GUI 交互），这条链路的失败条件无法在出货前测出

**教训**: 先前把「卷内文件不带隔离属性」直接当成「助手可运行」的结论，是拿一个可测的局部事实替代了不可测的整条链路。交付路径必须在出货前可验证，否则宁可不用。

**现行方案**: 映像内**不放任何脚本**，只放 `MeTerm.app` 与 `Applications` 快捷方式，接收方按 macOS 标准姿势拖放安装；首次打开用「系统设置 → 隐私与安全性 → 仍要打开」放行，或执行 `xattr -cr "/Applications/MeTerm.app"`。

**影响范围**:

- macOS 15 起 Apple 已移除「右键 → 打开」的绕过方式，接收方只能走上述两条路径
- 未签名包无法通过 `spctl` 评估，属预期行为，不代表包损坏；但「签名与内容不匹配」是另一回事，那种情况会显示「已损坏，无法打开」，清除隔离属性也无效，已在 v0.2.15 中通过嵌入访达扩展后补 ad-hoc 重签修掉
- 本 fork 的 `Build macOS` 已于 2026-09-20 启用，推 `v*` 标签会真实触发构建并在该标签上创建 Release；其余 workflow 仍为手动禁用（其中两个需要自托管 runner，本机没有，触发后会永久排队）
- 该流水线首次运行（run `35495488669`，tag `v0.2.15`）在 `Build Tauri app` 步失败：未配置签名 secret 时，工作流级 `env` 把 `APPLE_*` 注入成空字符串，而 Tauri 按「变量是否存在」判断要不要签名（空串也算存在），于是进入签名分支并在签名前执行 `security import` 导入一份空证书，报 `failed to import keychain certificate`。已在三处同名步骤前补 `unset`（清单与 `build-macos.sh` 的未签名分支一致）

**当前状态**: 助手脚本已从仓库与打包路径中移除；README 与打包脚本同步改为「拖放安装 + 系统设置放行」。拖放安装路径本身是 macOS 标准流程，不再需要真机验收。

---

## AI-001: 对话历史绑定文件清理（本地已修复）

**模块**: `ai-conversation-binding-store.ts` (`bindLegacyHistory`), `ai-capsule-chat-persistence.ts` (`deleteConversation`)

**现象**: 将旧历史绑定到主机时，先写备份 `<id>.json.pre-host-binding.bak`，再写临时文件 `<id>.json.binding.tmp` 用于原子替换。两者都没有清理入口。

**影响范围**:

- 删除对话只删 `<id>.json`，同名的 `.bak` 与 `.tmp` 永久残留
- 绑定过程中 `rename` 失败可能留下 `.tmp`；同一路径重试成功后该临时文件会随重命名消失，但失败后不再重试时没有清理入口
- `loadConversations()` 用 `endsWith('.json')` 过滤目录条目，因此残留文件不会污染历史列表，只是静默占用磁盘

**当前状态**: 本地已修复，上述现象记录修复前的情况。显式删除对话时清理对应主文件、绑定备份和临时文件；主文件删除失败则保留恢复副本。绑定写入或替换失败会尝试删除临时文件，同时保留原始记录和备份。清理失败记录日志，允许重试；同一窗口的删除与绑定互斥。删除确认提示已明确包含备份，未自动扫描或批量清理已有文件。

**可能的方案**:

1. `deleteConversation()` 删除主文件后顺带 best-effort 清理同名 `.bak` / `.tmp`
2. 启动时扫描 `chat-history/`，删除没有对应主文件的孤立 `.tmp`（`.bak` 保留，作为用户数据的最后防线）
3. 若担心误删备份，改为在设置里提供「清理历史备份」入口，由用户显式触发

---

## SET-001: 跨窗口设置写入尚未串行化

**模块**: `themes.ts` (`saveSettings` / `updateSettings`)、`keyboard-shortcuts.ts`、`appearance.ts`，以及另外 10 个文件（见下方清单）

**现象**: 修改单个设置项的老写法是「读全量 → 改一项 → 把整个对象写回」：

```ts
const s = loadSettings();   // 读快照
s.fontSize = next;          // 改一项
saveSettings(s);            // 整对象覆写 localStorage
```

`saveSettings` 是整体覆写，跨窗口没有锁（项目里没有 `storage` 事件监听，只靠 Tauri `settings-changed` 事后刷新）。因此若快照读取与写回之间另一个窗口保存了设置，那次保存会被整体回写抹掉。这正是 v0.2.13 修复「主窗口忘记自己尺寸」时的同一类根因。

**影响范围**（按暴露窗口分两档，共 14 处 / 12 个文件）:

*一档：读与写在同一同步块内（暴露窗口≈微秒级，正常使用基本不会触发）*

- `ai-capsule-model-ui.ts:41`、`:77`
- `ai-capsule-thinking-toggle.ts:42`
- `ai-capsule-trust.ts:43`
- `ai-capsule-input-setup.ts:342`
- `terminal-file-link.ts:268`
- `settings-sharing.ts:127`
- `file-sidebar.ts:742`、`:766`
- `file-manager-toggle.ts:57`
- `drawer-layout.ts:118`
- `settings-window.ts:72→128`

*二档：回写长期存活的快照对象（暴露窗口从「上次刷新」延续到写入，风险相对高）*

- `keyboard-shortcuts.ts:88-89` —— 回写 `app-state` 的模块级 `settings`，仅在 `settings-changed` 时刷新；Cmd/Ctrl +/- 调整字号每次都会整对象回写
- `appearance.ts:69-70` —— 入参来自 `app-state.settings`，仅系统外观切换/启动时触发，且有 `effectiveTheme !== s.theme` 守护

实际暴露窗口**通常很短**：设置窗口每次改动都会 `emit('settings-changed')`，主窗口随即 `setSettings(loadSettings())` 刷新，中间只隔一次异步 `flushSettingsSecrets()` 往返。会长的情况是异常路径 —— `flushSettingsSecrets()` 失败时不会 emit，而 localStorage 已经写入，主窗口的快照可能整个会话都不再刷新。

**当前状态（本地修复）**: 上述 14 处运行时写入已全部改为按字段调用 `updateSettings`；字号快捷键读取最新字号并同步应用状态，主题应用读取最新设置。整对象保存函数已收为 `themes.ts` 私有，仅用于旧数据迁移及统一补丁保存；上面的清单和示例记录修复前的情况。

**剩余限制**: `updateSettings` 仍是同步的「读取最新 → 合并 → 写回」，跨窗口未加锁，两个窗口真正同时保存仍可能竞争；目前只减少旧快照覆盖，不保证并发原子性。设置和凭据存储格式保持不变，尚未迁移到后端单写者。

**可能的方案**:

1. 已完成运行时调用点收口，并添加回归测试防止重新导入或调用整对象保存函数。
2. 彻底方案：给设置写入加内存缓存与跨窗口单写者（版本号/时间戳）保护，`updateSettings` 已是收口点
3. 在补齐 1 或 2 之前，新增设置项时优先使用 `updateSettings`，不要再写 `saveSettings({ ...loadSettings(), ... })`

---
