# MeTerm 更新记录

## v0.2.18

### 新功能

- **恢复整页独立主页** — 无会话时主页占据完整窗口，连接入口更清晰；主页与相册页隐藏服务器信息面板，避免后台继续轮询。
- **连接窗口支持批量整理** — 可多选连接、拖入分组，排序入口收敛到同一处；连接请求仍由主窗口创建会话，连接窗口保留自己的界面状态。

### 问题修复 / 优化

- **Agent Shell Hook 更稳健** — 无 Hook 的会话不再卡住；身份检测兼容不同 Shell 方言，并通过远端 exec 通道识别主机，避免把 Hook 注入嵌套 SSH。自动重试不再被无关按键打断，也不会覆盖用户已有的 `DEBUG` trap 或丢弃数组形式的 `PROMPT_COMMAND`。
- **服务器信息轮询更轻、更准确** — CPU 采样不再依赖远端 `sleep`，进程列表降低刷新频率；面板不可见时停止轮询。便携系统分支按实际输出解析进程，无法取得 CPU 时显示未知，并过滤面板自身的采样进程。
- **连接分组与窗口路由修复** — 批量移动按整个选区处理，内部保留分组名不再与用户分组冲突，已有记录仍可访问；连接窗口中的会话请求、语言、主题和保存操作也能正确到达所属窗口。
- **修复 SSH 端口输入与辅助窗口右键菜单** — SSH 端口框不再使用会拦截键盘菜单的数字输入类型；设置、关于和更新窗口不再弹出 WebView 默认菜单。
- **状态栏和启动状态修正** — 空闲时状态栏可自动收起，连接后保持显示；主页启动时不再误报本地连接，关闭面板时工具栏状态同步更新。
- **发布包校验与启动稳定性改进** — DMG 重建后的内容校验更可靠，并修复终端生命周期回调的循环依赖。

### 验证

- 前端单测 591 项、Rust 测试 705 项通过（复用相同源码输入下刚完成的结果；本次仅更新版本元数据与本更新记录）。
- macOS ARM64 未公证发布包已构建；App 为 ad-hoc 签名（无 Developer ID / 无公证），签名校验通过，DMG 挂载后确认包含 App 与 Applications 快捷方式。

---

## Changelog (English)

### What's New

- **The full-page home view is back** — When no session is open, the home view fills the window and presents connection entry points more clearly. The server-info panel stays hidden on the home and gallery views instead of polling in the background.
- **The connections window can organize selections in batches** — Select multiple connections, drag them into a group, and use one shared sorting entry point. The main window still owns session creation while the connections window keeps its own UI state.

### Bug Fixes

- **Agent shell hooks are more robust** — The Agent no longer stalls on sessions without a shell hook. Host detection works across shell dialects and uses the remote exec channel, so a nested SSH session is never mistaken for the host. Unrelated keystrokes no longer cancel a retry chain, and hook installation preserves an existing `DEBUG` trap and array-form `PROMPT_COMMAND` entries.
- **Server-info polling is lighter and more accurate** — CPU sampling no longer relies on remote `sleep`, the process list refreshes less often, and polling stops while the panel is hidden. Portable process-list branches parse their actual output shape, report CPU as unknown when it cannot be measured, and filter out the panel's own sampling process.
- **Connection grouping and window routing are fixed** — Batch moves apply to the whole selection, the reserved internal group name no longer conflicts with user groups, and existing records remain reachable. Session requests, language, theme, and save actions from the connections window now reach the correct window.
- **SSH port entry and auxiliary-window context menus are fixed** — The SSH port field no longer uses a numeric input type that interferes with keyboard menus; Settings, About, and Updater windows no longer show the WebView's default context menu.
- **Status-bar and startup state are corrected** — The status bar can hide while idle and stays visible after connecting. Startup no longer reports a false local connection, and the toolbar state follows a panel closing itself.
- **Packaging checks and startup stability are improved** — Rebuilt DMGs receive more reliable content validation, and a circular terminal lifecycle callback dependency is removed.

### Validation

- 591 front-end unit tests and 705 Rust tests passed (reused from the immediately preceding run on the same source inputs; this release change only updates version metadata and these notes).
- The unnotarized ARM64 macOS package has been built. Its ad-hoc app signature (no Developer ID or notarization) verified, and the mounted DMG contains the app and an Applications shortcut.

---

## v0.2.17

### 新功能

- **启动不再自动打开本地会话** — 设置里早就有「启动时自动创建本地会话」这一项（默认关、复选框与中英文案齐全），但启动路径从未读过它，每次启动都无条件打开一个本地终端，复选框怎么勾都不生效。现在它真正起作用：默认为关时应用停在首页，打开则与之前一致。以「打开此目录」方式显式启动时优先级最高，不受该设置影响 —— 那是用户的明确动作。
- **首页列出最近连接过的服务器** — 启动落在首页之后，首页需要一个「一键回到上次那台服务器」的入口。原先空态卡片下方是一条横向滚动的「最近活跃」卡片条：同样取自连接历史，但只列 SSH 与远程两类、还会被搜索框联动过滤，卡片又宽，一屏放不下几条。现在改为纵向紧凑列表，SSH 在前、远程在后，每行是图标 + 连接名 + `user@host[:port]`（非默认端口才补端口），整行点击直接建连，悬停出现的 × 可把该条从历史里移除，移除后就地重渲染。没有任何历史时整块不渲染，首页仍只显示空态卡片。
- **连接列表移入独立窗口** — 连接按钮改为打开一个 400×640 可缩放的独立窗口，内含搜索框、新建连接按钮组（本地 / SSH / 远程 / JumpServer / 手机）与分组连接列表。点选一行即在主窗口建立会话；右键仍可移动分组、取消分组、删除与编辑，但弹窗不再由主窗口代渲染 —— 编辑在连接窗口内就地完成。此前连接列表是主窗口左侧一个可切换的停靠侧边栏，与终端争抢左侧空间。
- **服务器信息成为左侧停靠面板，工具栏顺序随之调整** — 工具栏新增服务器信息按钮并排在文件管理之前，顺序为 连接 → 服务器信息 → 文件管理 → 新建终端（后两个只在该会话可用时出现）。面板停靠最左、把终端挤向右侧，可拖分隔条调宽（沿用原有侧边栏宽度设置），每 5 秒刷新一次并跟随活动会话切换，与文件侧边栏互斥。面板不自建连接：复用该会话既有的服务器信息通道，响应归属方仍是原来的接收方，面板只负责渲染与轮询。抽屉不再自带服务器信息侧边栏与分屏手柄。
- **服务器信息面板可直接看 swap、负载与进程** — 内存监控下方新增 swap（远端脚本采集 `/proc/meminfo` 或 `vm.swapusage`，按「已用 / 总量」显示并带进度条，完全没有 swap 的主机显示 0/0），运行天数下方新增 1 / 5 / 15 分钟负载（取不到就整行不渲染）。文件管理抽屉里的进程表搬进面板，成为内存与网络图之间的固定高度小窗，只留命令 / 内存% / CPU% 三列 —— 面板默认 280px，再放 PID、用户与运行时间会把命令列挤到只剩几个字符 —— 超过一半的数值标红。抽屉的「进程」标签页与刷新按钮随之取消，进程与系统信息现在由面板同一拍拉取，不会各刷各的。
- **网络监控优先展示物理网卡** — 网卡选择器按 物理（`en*` / `eth*` / `em*` / `wl*` / `ww*` / `bond*` / `team*`）→ 未识别 → 虚拟与隧道（`docker0`、`veth*`、`br-*`、`cni`、`tun`、`utun` …）排序，默认选中排第一的那块。此前直接取内核列出的第一块，在跑容器的宿主机上那常常是 `docker0`。用户手动选过的网卡只要还在就继续胜出。

### 问题修复 / 优化

- **服务器信息面板限定为 SSH 会话** — 本机会话没有远端，堡垒机会话的 Koko 连接没有 exec 通道（其文件浏览器走的是同一条已认证终端连接上复用的 SFTP 子系统），两者此前都会看到一份没有意义的数据。现在这两种会话的工具栏不再出现入口，面板自身也隐藏并停止轮询，而不是在面板里显示一句「仅对 SSH 会话可用」。
- **服务器信息面板重新打开后不再刷新** — 面板是单例，关闭时停掉定时器却不清会话 id，重开时落在同一个会话、被判定为「没有变化」，定时器就再也不启动，面板从此冻结在关闭那一刻的数据上（只有切换标签才会恢复）。现在改为无条件启动，而启动函数本身在定时器已运行时直接返回，重复调用不会叠加定时器。
- **堡垒机会话不再拿到本机数据冒充远端** — 后端原先以 `exec_type != "ssh"` 判断，会把堡垒机会话送进本机信息分支，用 MeTerm 自己机器的 hostname、系统与架构冒充远端资产。现在堡垒机单独返回 `SERVER_INFO_UNSUPPORTED`，只有本机会话走本机分支。
- **连接列表窗口不再弹出 WebView 自带的右键菜单** — 只有主窗口会用应用自己的菜单替换系统菜单，其他窗口什么都没注册，于是右键弹窗留白、空列表、底栏都会弹出 WKWebView 的英文菜单（Reload / Inspect Element），其中「Reload」还会丢掉用户正在操作的列表。现在这类窗口各自装一个文档级抑制器；列表行的右键不受影响，它们本来就弹出应用菜单。
- **文本输入框右键改用应用自己的菜单** — 「添加 JumpServer」对话框的服务器地址框右键会弹出 WebKit 的系统菜单（Look Up / Translate / Search with Bing / Inspect Element / AutoFill 等，无论界面语言始终是英文）。原因是上一版给辅助窗口装菜单抑制器时显式豁免了 input / textarea / select 以保住复制粘贴，而主窗口有同一处一模一样的豁免 —— 输入框成了最后一块漏出浏览器菜单的地方。现在文本框统一弹出应用自己的四项菜单（剪切 / 复制 / 粘贴 / 全选），主窗口与各辅助窗口共用同一套判定。下拉框仍走系统原生菜单（应用无可加项），终端区域完全不受影响。编辑按打开菜单那一刻快照的选区执行（菜单按钮会抢走焦点），写值后会主动通知输入框，因此 SSH / JumpServer 端口框的数字清洗与「有未保存改动」检查照常生效。
- **编辑连接不再把连接列表窗口顶掉** — 编辑弹窗原本在主窗口里渲染：连接窗口只发一个请求，主窗口收到后显示并聚焦自己，再打开弹窗。而主窗口常处于全屏（独占一个 macOS Space），聚焦会切走 Space，连接列表窗口随之整个消失。现在编辑在连接窗口内就地执行，只有弹窗里点「连接」这一步才委托回主窗口 —— 会话仍然只属于主窗口，跨窗口只传连接类型与 key，永不传凭据。
- **删除连接失败时给出可见提示** — 此前失败只写控制台，界面毫无反应，在没有可见控制台的独立连接窗口里尤其像「按钮坏了」。现在失败弹出提示条；同时保留原有契约：失败后不重绘视图、不通知监听方，因为凭据还在、什么都没变，分组写入失败也不会再把列表留在旧状态。
- **堡垒机资产窗口「连接」不再失败** — 在堡垒机窗口里选好账户点连接会登录不上，而侧边栏同一入口正常：同一件事两条路，只有走事件的那条被拦。窗口把连接请求转发给主窗口时，校验器要求 `account.privileged` 必须是布尔，而后端账户对象根本没有这个字段，序列化时该键被丢掉，转发命令直接返回错误，窗口底栏只剩一句 `invalid JumpServer browser connection request`。现在校验器接受该字段缺失、出现时仍必须是布尔，窗口侧则固定发送布尔值；未知字段依旧被拒，载荷长不出新字段。（账户列表里的 root 徽章仍不显示 —— 给后端加上这个字段，会让账户解析在字段类型意外时整批失败，不值得冒这个险。）

### 验证

- **空会话页「最近活跃」与上方按钮列对齐** — 该列表此前撑满整张卡片且左对齐，相对上方居中的按钮列每边外扩 50px，整体读起来偏左。现在复刻按钮列的几何并由自动外边距居中，两块共用同一条左右边界；列表项内容与标题也改读同一个缩进变量，不再各自漂移。
- **弹窗不再压暗窗口底色** — SSH、远程、JumpServer 三类弹窗的遮罩层去掉底色（连同 vibrancy 主题下的模糊），弹出时后面的窗口保持原本亮度。遮罩元素本身保留 —— 点击弹窗外关闭与 Escape 处理都依赖它。
- **删除会话历史后不再退回对话区** — 删除确认弹层挂在 body 上，面板的文档级点击监听把它判为「点了面板外」，于是确认一次删除就把历史列表关掉、面板退回对话区。现在该弹层在监听里豁免，只有对话真的删空才回到对话区。会话行的删除按钮默认不可见、鼠标移到该行才显示（键盘仍可聚焦，不可见时不接收指针事件，避免点行时误触）。
- **分组排序按钮改用三横图标** — 不再渲染裸字形「↕」（读起来像「上下传输」而非「排序」），改用共享图标集里的排序图标，画在 14 单位网格上按 1:1 渲染，边缘不糊；排序模式与当前选中项由它弹出的菜单承担。
- **抽屉侧栏移除后的残留清理** — 侧边栏宽度设置已无读取方，而保存布局的代码仍在按已不存在的元素查询宽度，于是每次拖拽抽屉高度都往本地存储写一次恒为 0 的值；分屏手柄函数也早已没有调用方。两者连同失效的样式规则一并移除。
- **开发签名身份改为构建期注入** — 此前硬编码在源码里：Team ID 是 Rust 常量、也是构建脚本里的字面量，而签名证书的通用名必然带着个人 Apple ID。现在两者都改为构建时从本机钥匙串解析并注入，发布的源码树里不再包含任何账号相关信息；缺失时仍可编译，但会在执行任何高权限操作前直接失败关闭并给出指引。安全闸门（codesign 的多路校验与 TeamIdentifier 断言）原样保留，改的只是值的来源。
- 前端单测 310 项全通过（v0.2.16 为 253 项，本版新增 57 项）、`npx tsc --noEmit` 无错误、`npm run build` 通过、`cargo check --lib` 通过
- 守卫测试均以「改回问题形态、确认确实失败」验证过，之后逐字节还原；Rust 侧新增的 `connect_asset_accepts_an_account_without_a_privileged_flag` 实测通过，把校验器改回旧写法后如期失败
- 本版 17 个功能提交各自单独跑过类型检查与全量测试（253 → 310，逐提交递增，无失败），确保每一棵中间树都可编译可测
- 尚未实测：真实 SSH 会话上面板的 swap / 负载 / 进程小窗（本机无法构造远端），以及堡垒机资产窗口的实际登录（需要可用的堡垒机账号）

---

## Changelog (English)

### What's New

- **Startup no longer opens a local session on its own** — The "auto-create local session on startup" setting already existed (off by default, with its checkbox and both language strings), but the startup path never read it and opened a local terminal on every launch whatever the checkbox said. It takes effect now: off (the default) lands on the home view, on behaves as before. An explicit "open this folder" launch still wins regardless, since that is a deliberate user action.
- **The home view lists recently connected servers** — With startup landing on the home view, that view needs a one-click way back to a previous server. The empty-state card used to carry a horizontally scrolling "recent activity" strip: it read the same history but listed only SSH and remote entries, was filtered by the search box, and its wide cards fit only a few per screen. It is a compact vertical list now, SSH first then remote, each row an icon plus the connection name and `user@host[:port]` (the port only when it is not the default); clicking a row connects straight away and a × appears on hover to drop that entry from the history and re-render in place. With no history at all the block is not rendered, so the home view keeps just its empty-state card.
- **The connection list moves to its own window** — The toolbar button now opens a resizable 400×640 window with a search box, the new-connection button row (local / SSH / remote / JumpServer / phone) and the grouped connection list. Picking a row opens the session in the main window; the context menu still moves groups, ungroups, deletes and edits, but the main window no longer renders that dialog — editing happens in place in the connections window. The list used to be a toggleable docked sidebar competing with the terminal for the left edge.
- **Server info becomes a docked left panel, and the toolbar order changes** — A new toolbar button, placed before the file manager, gives the order connections → server info → file manager → new terminal (the last two only while that session can use them). The panel docks on the far left and pushes the terminal aside, a drag handle shares the existing sidebar-width setting, it refreshes every 5s and follows the active session, and it is mutually exclusive with the file sidebar. It opens no socket of its own: it reuses the session's existing server-info channel, with the original owner still receiving the response and the panel only rendering and polling. The drawer no longer carries a server-info sidebar or a split handle.
- **The server-info panel now shows swap, load and processes** — Swap sits under memory (the remote script reads `/proc/meminfo` or `vm.swapusage`, shown as used/total with a progress bar, and 0/0 on a host with no swap) and the 1/5/15-minute load averages sit under uptime, dropped entirely when a host reports none. The file drawer's process table moved into the panel as a fixed-height box between the memory rows and the network chart, keeping three columns (command / mem% / CPU%) — the panel is 280px by default and PID, user and elapsed time would leave the command column a few characters wide — with anything over half shown in red. The drawer's Processes tab and refresh button are gone, and the panel now polls processes and system info on the same tick instead of the two drifting apart.
- **The network chart prefers the physical adapter** — The selector orders names physical (`en*` / `eth*` / `em*` / `wl*` / `ww*` / `bond*` / `team*`) → unclassified → virtual and tunnel (`docker0`, `veth*`, `br-*`, `cni`, `tun`, `utun` …) and defaults to the first of those. It used to take whatever the kernel listed first, which on a container host is often `docker0`. A NIC the user picked by hand keeps winning while it still exists.

### Bug Fixes

- **The server-info panel is SSH-only** — A local session has no remote side, and a JumpServer session's Koko connection carries no exec channel (its file browser multiplexes an SFTP subsystem on the authenticated terminal connection instead), yet both used to show a panel of numbers that meant nothing. Neither now gets a toolbar entry, and the panel itself hides and stops polling rather than rendering an "SSH sessions only" line inside it.
- **The server-info panel refreshes again after being reopened** — The panel is a singleton: closing it stopped the timer without clearing the session id, so reopening landed on the same session and was judged "unchanged", leaving the timer unstarted — the panel stayed frozen on the data from the moment it was closed (only switching tabs revived it). The start call is unconditional now, which is safe because it returns early while the timer is already running.
- **A JumpServer session no longer receives local data dressed up as the remote asset** — The backend branched on `exec_type != "ssh"`, which routed a JumpServer session into the local-information path and labelled MeTerm's own hostname, OS and architecture as the remote asset's. JumpServer now answers `SERVER_INFO_UNSUPPORTED`, and only a local session takes the local branch.
- **The connection window no longer pops the WebView's own context menu** — Only the main window replaces the system menu with the app's own; every other window registered nothing, so right-clicking dialog padding, empty list space or the footer showed WKWebView's English menu (Reload / Inspect Element), and "Reload" would discard the list being worked in. Such windows now install a document-level suppressor; the rows are unaffected because they already show the app menu.
- **Text fields get the app's own right-click menu** — Right-clicking the server-address box in the 添加 JumpServer dialog popped WebKit's system menu (Look Up / Translate / Search with Bing / Inspect Element / AutoFill, all in English whatever the UI language). The cause was the previous window-wide suppressor exempting input / textarea / select to keep copy-paste working, with the main window carrying the very same exemption — text fields were the last place the browser menu leaked through. The main window and the utility windows now share one rule and show the app's own four entries (cut / copy / paste / select all). A dropdown keeps the platform menu (the app has nothing to add) and the terminal is entirely unaffected. Edits apply to the selection snapshotted when the menu opened (the menu button steals focus) and announce themselves to the field, so the SSH/JumpServer port boxes still sanitise digits and the unsaved-changes check still fires.
- **Editing a connection no longer takes the list window down with it** — The edit dialog used to render in the main window: the list only emitted a request, and the main window answered by showing and focusing itself before opening the dialog. A full-screen main window owns its own macOS Space, so focusing it switched Spaces and the connections window vanished. Editing now runs in the connections window itself; only a dialog's "connect" outcome is delegated back, because a session belongs to the main window — and only the connection type and key cross the boundary, never credentials.
- **A failed connection deletion is now visible** — It used to log to the console and do nothing else, which reads as a dead button in the standalone connections window with no visible console; a toast reports it now. The existing contract is kept: nothing re-renders and no listener hears about a mutation that never happened, and a failing group write no longer leaves the list on stale state.
- **Connecting from the JumpServer asset window works again** — Picking an account and connecting in the asset window failed to log in while the same entry point in the sidebar worked: one action, two paths, and only the event path was blocked. When the window forwards the request to the main window, the validator demanded a boolean `account.privileged`, but the backend's account object has no such field — JSON dropped the key, the forward command returned an error, and the status bar showed nothing but `invalid JumpServer browser connection request`. The validator now accepts a missing flag and still requires a boolean when present, and the window always sends a boolean. Unknown keys stay refused, so the payload cannot grow fields. (The root badge in the account list still does not show: adding that field to the backend would make account parsing fail wholesale if an endpoint ever typed it differently, which is not worth the risk.)

### Validation

- **The home view's recent-activity list lines up with the buttons above it** — It filled the whole card and stayed left-aligned, sticking out 50px on each side of the centred button grid above and reading as shifted left. It now mirrors that grid's geometry and is centred by auto margins, so both share the same left and right edges, and the row content reads the same inset variable as the label instead of drifting.
- **The dialogs no longer dim the window behind them** — The SSH, remote and JumpServer overlays no longer paint a scrim, including the backdrop blur they applied under the vibrancy theme, so the window behind stays at its own brightness. The overlay elements stay — clicking outside to dismiss and the Escape handler both rely on them.
- **Deleting a conversation keeps the history view** — The confirmation is appended to `body`, so the panel's document-level click listener read it as a click outside and closed the history list the moment a deletion was confirmed; the overlay is now exempt and the panel falls back to the chat pane only when nothing is left. The per-row delete button is hidden until its row is hovered, stays keyboard-reachable, and is not hit-testable while invisible so a click aimed at the row cannot land on it.
- **The group sort control uses a three-bar icon** — The bare "↕" glyph read as "up/down transfer" rather than "sort"; it is the shared `sort` icon now, drawn on a 14-unit grid and rendered 1:1 so the edges stay sharp, with the modes and the active one carried by the menu it opens.
- **Leftovers of the removed drawer sidebar are gone** — Nothing read the sidebar-width setting any more, yet the layout saver still measured an element that no longer exists and wrote a constant 0 to local storage on every height drag; the split-handle helper had no caller left either. Both are gone, along with their dead style rules.
- **The development signing identity is injected at build time** — It used to be hardcoded in the source: the team ID was a Rust constant and a literal in the build scripts, and the signing certificate's common name necessarily carries a personal Apple ID. Both are now resolved from the local keychain at build time, so the published source tree carries no account-specific value; a build without them still compiles but fails closed before any privileged operation with guidance. The security gate (the codesign checks and the TeamIdentifier assertion) is unchanged — only where the values come from.
- Front-end unit tests: 310 passing (253 at v0.2.16, so 57 new in this release), `npx tsc --noEmit` clean, `npm run build` succeeded, `cargo check --lib` clean
- Every guard was validated by restoring the problem form and watching it fail, then restored byte-for-byte; the new Rust test `connect_asset_accepts_an_account_without_a_privileged_flag` passes and fails as expected when the validator is put back
- Each of the 17 feature commits was type-checked and tested on its own (253 → 310, rising monotonically, no failures), so every intermediate tree builds
- Not yet verified on real hardware: the panel's swap / load / process box against a live SSH host (no remote available here), and an actual login from the JumpServer asset window (needs a working JumpServer account)

---

## v0.2.16

### 新功能

- **编辑器窗口自带右键菜单** — 此前在任何位置右键都会弹出 WebKit 的系统默认菜单（Reload / Share / Inspect Element / AutoFill），文字由系统提供、不随界面语言变化，一直是英文。现在由应用接管：在编辑正文或状态栏弹出文档菜单（剪切 / 复制 / 粘贴 / 全选 / 保存 / 关闭标签 / 换行 / Markdown 预览 / 格式化），在标签上弹出标签菜单（关闭此标签 / 关闭其他标签 / 关闭左侧标签 / 关闭右侧标签 / 关闭所有标签），标题栏空白处作用于当前活动标签。菜单样式复用主窗口那套，视觉一致。
- **编辑器标签栏优先完整显示路径** — 标签此前继承了主窗口为工具栏调的 340px 上限，长路径必然被截断，跟这一行还剩多少空间无关；改用主窗口那套水位法分配（`planTabWidths`）：放得下就全部完整显示，不够时只收窄最长的那些，连地板都放不下才横向滚动。
- **图片粘贴/拖入接入统一的体积预算** — 五条入口（document 粘贴、原生剪切板桥、两处拖放、文件选择器）统一走同一道闸门；超预算先用 canvas 按阶梯重编码、每步以真实编码长度重过闸，PNG 保持 PNG 以保文字清晰，GIF 不重编码以免丢帧。此前剪切板路径完全没有校验，且前端允许的 4×5MB 经 base64 膨胀后必然撞上后端 16MB 请求体上限，报错却只说 "AI request body is too large"。
- **AI 上下文行数、历史预算与思考预算真正生效** — 「上下文行数」此前是个死设置（六处引用全是类型与文案，没有任何业务代码读它），Agent 固定抓 80 行、渲染层又二次截成每面板 3 行；现在抓取与渲染同源读设置值。新增「历史预算」（此前压缩阈值恒按 128k 窗口 / 4k 输出硬编码，"最大 Token"设置对压缩时机毫无影响）与「思考预算」三档（默认"跟随模型"= 不发参数，零行为变更）。
- **上下文压缩提示带数量并可见** — 提示早已存在，只是被 10px 字号 + 0.6 透明度 + 次要色三重弱化基本藏住；现在文案为「上下文已压缩以适应模型限制 (42 → 8)」，并区分主动压缩与溢出后重试。

### 问题修复 / 优化

- **编辑器窗口无法关闭** — `capabilities/editor.json` 给了 `core:window:allow-close` 却没给 `core:window:allow-destroy`，而 Tauri 的 `close()` 流程末尾会走 `destroy()`，请求被窗口自己的权限白名单拒绝：点 × 纹丝不动、也不弹框。该文件出自上游 v0.2.12，属上游漏配。
- **编辑器视图重建后同一文件永久卡在"加载中"** — 编辑器标签的事实源在主窗口（`file-editor-bridge.ts`），而 `EDITOR_WINDOW_CLOSED_EVENT` 只在真正关窗时发出；视图被重建（reload、webview 进程重启）时主窗口毫不知情，再点同一文件会走"已存在标签"分支、只重发打开事件而不排队读取。现在编辑器在握手里带上「视图实例 id」，主窗口发现 id 变了就清掉陈旧记录，重新打开即正常加载。
- **标签菜单批量关闭尊重用户的否决** — `closeTab` 对未保存改动弹确认、取消时只是安静返回；批量关闭现在每次之后都重新确认标签确实关掉了，一旦被否决立刻中止整批，而不是把剩下的标签在用户说"不"之后继续关掉。
- **剪切先写剪贴板再删文字** — 依赖已废弃的 `execCommand` 改为直接改 CodeMirror state；写入失败时不能先把内容弄丢。
- **状态栏「格式化」按钮写死中文** — 英文界面下也显示中文，改为走 i18n。
- **工具确认对可选的 abort signal 改判空** — 原先 `toolCtx.abortSignal!` 非空断言把可选字段当成必填；无头与测试驱动未必挂 signal，改为显式分支。

### 验证

- 前端单测 253 项全通过（新增 55 项：菜单模型 23、标签宽度守卫 8、视图身份判定 9、图片体积预算 15）、`npx tsc --noEmit` 无错误、`npm run build` 通过
- 编辑器右键菜单、标签完整显示路径、视图自愈均在 macOS 实机验收；标签宽度改动附带读源码的守卫测试，并把 `flex: 0 0 auto` 故意改坏验证过守卫确实会失败
- 阿里云 Token Plan 是否透传 `thinking_budget` 尚未实测（第三方网关文档称 `deepseek-v4.1-flash` 支持、默认 32768，大于本项目 `max_tokens`，是长回答被截断的可疑根因）
- 图片降采样的真机表现（Retina 全屏截图粘贴）尚未实测

---

## Changelog (English)

### What's New

- **The editor window owns its context menu** — Right-clicking anywhere used to produce WebKit's default menu (Reload / Share / Inspect Element / AutoFill); those labels come from the system, follow the localisations the app declares (this bundle declares none), and so stayed English whatever the UI language was. The app now takes over: the editor body and status bar get a document menu (cut / copy / paste / select all / save / close tab / word wrap / Markdown preview / format), a tab gets a tab menu (close tab / close others / close left / close right / close all), and the bare title bar acts on the active tab. The chrome is the same one the main window uses, so the two look alike.
- **Editor tabs show a full path rather than clipping one** — Tabs inherited the toolbar's 340px cap, so a long path was always clipped no matter how much room the row had. They now use the same water-filling allocation as the window strip (`planTabWidths`): show every path in full when the row can hold them, trim only the longest when it cannot, and scroll only when even the floors do not fit.
- **Image paste and drop go through one size budget** — All five entry points (document paste, the native clipboard bridge, both drag-and-drop surfaces, the file picker) share a single gate; over-budget images are re-encoded down a ladder with each step re-checked on its real encoded length, PNG stays PNG to keep terminal text crisp, and GIF is never re-encoded so the animation survives. The clipboard path previously had no check at all, and the 4×5MB the front end allowed grew past the backend's 16MB request-body cap once base64-expanded, surfacing only as "AI request body is too large".
- **AI context lines, history budget and thinking budget now take effect** — "Context lines" was a dead setting (six references, all type/label/default; no consumer), with the Agent hardcoded to fetch 80 lines and the renderer cutting that to 3 lines per pane; capture and rendering now read the same value. A new "history budget" replaces the hardcoded 128k window / 4k output reservation that made the max-tokens setting irrelevant to compaction, and a three-tier "thinking budget" defaults to "follow the model", which sends no parameter at all.
- **The compaction notice carries counts and is actually visible** — The notice already existed but was hidden by 10px type at 0.6 opacity in a secondary colour; it now reads "context compressed to fit model limits (42 → 8)" and distinguishes proactive compaction from overflow rescue.

### Bug Fixes

- **The editor window could not be closed** — `capabilities/editor.json` granted `core:window:allow-close` but not `core:window:allow-destroy`, and Tauri's `close()` flow ends in `destroy()`, so the request was rejected by the window's own allow-list: the × did nothing and no dialog appeared. The file dates from upstream v0.2.12 and is an upstream omission.
- **Reopening a file after the editor view was rebuilt stuck on "Loading…" forever** — The open-tab record lives in the main window (`file-editor-bridge.ts`), while `EDITOR_WINDOW_CLOSED_EVENT` only fires on a real close, so a rebuilt view (reload, webview restart) went unnoticed and the same file took the already-open shortcut without queueing a read. The editor now stamps a view-instance id on every handshake; when the id changes the owner drops its stale record and the file loads normally.
- **Batch tab closing respects a veto** — `closeTab` prompts before discarding unsaved edits and silently returns on cancel; batch closing now re-checks after each await that the tab really went away and stops the whole batch the moment one is refused, instead of closing the rest behind the user's back.
- **Cut writes to the clipboard before removing the text** — The deprecated `execCommand` path is replaced with direct CodeMirror state edits, so a failed clipboard write cannot lose the content first.
- **The status bar's format button had a hardcoded Chinese label** — It read Chinese even in the English UI; it now goes through i18n.
- **Tool confirmation branches on the optional abort signal** — `toolCtx.abortSignal!` treated an optional field as required; headless and test drivers need not attach one, so the call now branches explicitly.

### Validation

- Front-end unit tests: 253 passing (55 new: 23 menu model, 8 tab-width guards, 9 view-identity, 15 image budget), `npx tsc --noEmit` clean, `npm run build` succeeded
- The editor context menu, full-path tab strip and view recovery were verified on macOS; the tab-width change ships source-reading guard tests, and the guards were validated by deliberately breaking `flex: 0 0 auto` and watching them fail
- Whether Alibaba Cloud's Token Plan forwards `thinking_budget` is unverified (third-party gateway docs say `deepseek-v4.1-flash` supports it with a default of 32768, larger than this project's `max_tokens`, making it the prime suspect for truncated long answers)
- Image downscaling on a real Mac (pasting a Retina full-screen shot) is not yet verified

---

## v0.2.15

### 新功能

- **标签栏按连接名完整显示** — 每个标签按自身连接名的实测宽度分配空间：短名称不再被无谓压扁，只有确实过长的才收窄，整排装不下时才降级为横向滚动。同时修复图标区宽度被漏算、导致末尾字符被关闭按钮压住的老问题。
- **未签名分发改为拖放安装** — dmg 内只放 `MeTerm.app` 与 `Applications` 快捷方式，接收方拖进「应用程序」，首次打开由接收方在「系统设置 → 隐私与安全性」放行（或执行 `xattr -cr`）。dmg 组装改为本地与 CI 共用的脚本，打包后会挂载回读核对内容与签名完整性。

### 问题修复 / 优化

- **横向滚动的标签栏不再被压回 CSS 地板** — 标签栏降级为横向滚动后，JS 算好的宽度曾被 flex 收缩压回 CSS 的 `min-width: 84px`：带图标的标签计划 108px、实际只画 84px，名字只剩三四个字。更隐蔽的是压回后内容恰好填满容器，`scrollWidth` 等于 `clientWidth`，滚动箭头、滚轮横滚与「切标签自动滚入视野」**一并失效**。现在窗口标签栏的标签宽度只由 JS 决定，放不下就滚动而不是压扁。
- **访达扩展嵌入后包签名残缺** — 未签名路径下不再产出签名与内容不匹配的 `.app`，避免接收方看到「已损坏，无法打开」；那种状态下清除隔离属性无效，任何放行方式都救不回来。
- **dmg 打包失败不再被吞掉** — 三处 CI 重建 dmg 的步骤在 `create-dmg` 失败时不再留下空目录却报告成功。
- **移除不成立的首次打开助手** — 曾在 dmg 内附带 `Open-MeTerm.command`，设想「在映像窗口里双击即可放行」。真机实测失败：双击弹出「Apple 无法验证」且没有可用的放行选项。这条路径在出货前无法验证（本机无 GUI 交互），因此不再出货任何需要双击的脚本，改回 macOS 标准的拖放安装。
- **检查更新改为打开发布页** — 不再向外部更新服务器查询版本，启动后的静默自检已移除；菜单栏、托盘与关于页的「检查更新」统一用浏览器打开本仓库的 Releases 页面，已安装的版本因此不会被上游发布静默替换。

### 验证

- 前端单测 166 项全通过、`npx tsc --noEmit` 无错误、Rust `cargo check` 通过
- 不设置更新签名密钥时 release 打包成功，且不再产出 `.tar.gz` / `.sig`
- 本地分发构建端到端跑通，dmg 挂载核对通过（映像内为 `.app` 与 `Applications` 快捷方式）；签名残缺的包会被打包脚本拦下
- 标签栏按连接名分配宽度已在 macOS 实机验收
- 未签名分发的放行路径在真机实测后改版：原「映像内放行助手」被 Gatekeeper 拦下，改为拖放安装 + 系统设置放行
- CI（`Build macOS`，tag `v0.2.15`）两架构均通过并发布 dmg；下载产物核对通过：映像内含 `.app` 与 `Applications` 链接，`codesign --verify` 报 `valid on disk`，嵌套的 `.appex` 一并校验
- CI（`Build Windows`，tag `v0.2.15`）首次运行即通过，产出 NSIS 安装包并追加进同一发布页

---

## Changelog (English)

### What's New

- **Title-bar tabs sized to their own names** — Each tab is sized to its own measured connection name, so short names are no longer squeezed and only genuinely over-long ones are trimmed, with horizontal scrolling as the last resort. Also fixes the omitted icon area that let the close button clip the last glyph.
- **Unsigned distribution now installs by drag and drop** — The DMG now holds only `MeTerm.app` and an `Applications` shortcut: recipients drag it in and allow the first launch from System Settings (or run `xattr -cr`). DMG assembly moved to a script shared by local builds and CI that mounts the image back and verifies its contents and signature integrity.

### Bug Fixes

- **A scrolling tab strip is no longer squashed back to the CSS floor** — Once the strip fell back to horizontal scrolling, the flex container shrank the JS-planned width back to the CSS `min-width: 84px`: an icon tab planned at 108px was drawn at 84px, leaving three or four characters of its name visible. The knock-on effect was worse — the row then fit its container exactly, so `scrollWidth` equalled `clientWidth` and the scroll arrows, wheel scrolling and scroll-active-tab-into-view all went dead together. Tabs in the window toolbar now take their width from JS alone: the row scrolls instead of squashing.
- **Broken bundle signature after embedding the Finder extension** — The unsigned path no longer produces a bundle whose signature does not match its contents, which recipients would see as "damaged" — a state that stripping the quarantine attribute cannot repair.
- **DMG failures are no longer swallowed** — The three CI DMG rebuild steps no longer report success while leaving an empty directory behind after a failed `create-dmg`.
- **Dropped the first-launch helper that does not work** — The image used to ship `Open-MeTerm.command` to be double-clicked from the mounted window. On a real Mac that fails: the dialog offers no way through. The path cannot be verified before shipping either (no GUI interaction available locally), so no double-clickable script is shipped any more and installation is the standard drag and drop.
- **Check for Updates opens the releases page** — The app no longer queries an external update server and the silent startup check is gone; all three "Check for Updates" entries open this repository's Releases page in a browser, so an installed build cannot be silently replaced by an upstream release.

### Validation

- 166 frontend unit tests pass, `npx tsc --noEmit` is clean, `cargo check` passes
- release build succeeds without the updater signing key and no longer emits `.tar.gz` / `.sig`
- end-to-end local distribution build passes and the mounted image verifies (the app plus the Applications shortcut); a bundle with a broken signature is rejected by the packaging script
- the name-sized title-bar tabs are verified on a real Mac
- after testing on a real Mac the unsigned path changed: the in-image helper is rejected by Gatekeeper, so installation is drag and drop plus a System Settings release
- CI (Build macOS, tag v0.2.15) passes on both architectures and publishes the DMGs; the downloaded artifact checks out — the image holds the app and the Applications link, and `codesign --verify` reports "valid on disk" with the nested appex validated
- CI (Build Windows, tag v0.2.15) passes on its first run and publishes the NSIS installer to the same release page

---

## v0.2.14

### 新功能

- **连接后自动打开 AI** — 新增两个默认关闭的设置：连接成功后自动打开 AI 面板，以及自动恢复当前主机最近的非空历史；后台连接不抢占当前面板，跨主机或未绑定历史不自动恢复，已有任务或对话不被覆盖。
- **Agent 回答复制** — 回答新增复制按钮，复制成功或失败提供反馈。
- **主机历史与全部对话** — 新对话按首次发送窗格绑定本机或 SSH 地址和端口；两个历史入口默认显示当前主机，可切换全部对话并按标题、内容和主机搜索。跨主机继续发送会被阻止。
- **只读侧栏预览与旧历史绑定** — 跨主机与未绑定历史仅供预览和复制，不执行代码或覆盖当前任务；旧历史可确认后绑定当前主机，保留内容并备份原文件，重新打开后继续。

### 问题修复 / 优化

- **摘要与审批取消** — 摘要请求可及时取消并有 30 秒截止时间；停止待审批任务时清理确认卡、计时器和监听，补齐未执行工具结果，防止历史工具配对缺失。
- **历史展示与搜索** — 只读历史采用正常对话气泡、推理折叠与工具卡样式，保留只读限制；搜索复用输入控件，避免输入法组合输入被列表刷新打断，并完善双语提示。
- **设置与连接面板** — 设置面板仅将本次修改合并到最新设置，减少陈旧快照覆盖；隐藏连接面板不重复刷新，SSH 标签默认使用终端动态标题。
- **终端观察有界与可取消** — 取消时释放监听、定时器和锁；观察默认 60 秒，可设置 3–300 秒，持续输出也按时返回；仅保留最近 64 KiB 字符并标注截断。观察超时不会中止实际进程。
- **Agent 中断与任务状态** — 修复模型提供方吞掉取消错误导致停止无效的问题；命令手动中断后停止 Agent 继续执行，并将进行中的计划标为已中断，保留已完成和待办项。
- **压缩目标保留** — 摘要优先保留目标、授权、约束、证据和未完成事项；本地裁剪或摘要失败时保留首条请求、已有摘要和最近补充，总预算 6000 字符，头尾截取并标注遗漏，保持工具调用配对且不修改原始聊天记录。保留记录可能不完整，后续用户纠正优先。
- **历史切换与预览配色** — 修复全部对话切换被误判为外部点击而关闭的问题；预览使用不透明主题背景，侧栏返回保留搜索与列表位置，异步保存携带主机归属。
- **历史操作与文件清理** — 修复历史视图中“新对话”和“清空对话”无效的问题，并将返回入口移到预览左上角；显式删除对话时同步清理其主机绑定备份与临时文件，失败时保留可恢复副本且不影响其他历史。
- **设置按字段保存** — 将运行时设置写入统一收口为基于最新值的字段补丁，避免旧窗口快照覆盖其他窗口刚保存的设置；字号快捷键和主题切换同步使用最新状态，并增加回归保护。
- **命令补全恢复** — 修复 xterm 5.5 私有字段变化导致灰色补全文字始终被隐藏的问题；补全不再等待异步索引加载，已打开、设置切换及跨窗口转移的终端都会正确挂载和释放监听。

---

## Changelog (English)

### What's New

- **Automatically open AI on connection** — Add two opt-in settings to open AI after connecting and restore the current host's latest nonempty conversation; background connections do not steal focus, unrelated or unbound history is excluded, and active tasks or conversations are preserved.
- **Copy Agent responses** — Add response copy buttons with success and failure feedback.
- **Host-scoped history and all conversations** — Bind new conversations to the first sending pane's local or SSH host and port; both history surfaces default to the current host, support all conversations and search by title, content and host, and block cross-host continuation.
- **Read-only side previews and legacy binding** — Preview and copy cross-host or unbound history without executing code or replacing the active task; explicitly confirm legacy ownership to bind to the current host, preserving content and backing up the original before reopening to continue.

### Bug Fixes

- **Summary and approval cancellation** — Bound summary requests to 30 seconds and settle cancellation promptly; stopping pending approvals cleans cards, timers and listeners and fills missing tool results to preserve complete history pairs.
- **History rendering and search** — Render read-only history with normal chat bubbles, collapsible reasoning and tool cards without execution controls; reuse search inputs to preserve IME composition and improve bilingual feedback.
- **Settings and connection panel** — Merge only the current panel edit into fresh settings to reduce stale overwrites; avoid refreshing hidden connection panels and default SSH tabs to dynamic terminal titles.
- **Bounded, cancellable terminal watching** — Release listeners, timers and locks on cancellation; default to 60 seconds with a 3–300 second range even for continuous output, retain the latest 64 KiB characters and flag truncation. Observation timeout does not stop the process.
- **Agent cancellation and plan state** — Settle cancellation even when providers suppress abort errors; stop Agent continuation after manually interrupted commands and mark active plan items interrupted while retaining completed and pending items.
- **Task retention during compaction** — Prioritize goals, authority, constraints, evidence and pending work in summaries; local trimming or failed summarization retains the original request, existing summary and recent additions within 6,000 characters, with marked head/tail truncation and complete tool pairs, without changing original history. Retention may be incomplete and later user corrections take priority.
- **History switching and preview colors** — Prevent all-conversation switching from being mistaken for an outside click; use opaque themed preview surfaces, preserve side-list search and scroll on return, and carry host ownership in asynchronous saves.
- **History actions and file cleanup** — Fix New Conversation and Clear Conversation actions while history is open and move Back to the preview's upper-left; explicit deletion now removes the matching host-binding backup and temporary file while preserving recoverable copies on failure and leaving other history untouched.
- **Field-level settings updates** — Route runtime settings writes through field patches merged into the latest persisted value, preventing stale window snapshots from overwriting recent changes; font shortcuts and theme changes now use fresh state with regression coverage.
- **Command completion restored** — Fix ghost text being hidden by an obsolete xterm 5.5 private-field check; completion no longer races asynchronous index loading, and listeners are attached and released correctly for existing, settings-toggled and transferred terminals.

---

## v0.2.13

### 新功能

- **组内连接排序** — 分组与“最近 / 未分组”标题的数量旁新增排序按钮，支持默认顺序、IP 升降序、名称升降序，各组分别保存偏好；排序不改写原始连接顺序。
- **SSH 标签名称** — 设置 → 通用可选择连接名称或终端动态标题，默认连接名称；切换立即更新已打开的标签和提示，分屏跟随聚焦会话。

### 问题修复 / 优化

- **连接面板实时刷新** — 新增、编辑后立即刷新连接面板，SSH 删除等待完成后再刷新，避免继续显示旧内容。
- **AI 历史上下文恢复** — 重开历史对话时恢复 Agent 的消息上下文，保留工具调用前的正文与推理，恢复工具返回的图片和错误标记，并为中断的工具调用补齐结果占位。
- **主窗口状态记忆** — 保存与恢复主窗口尺寸、位置及最大化状态；辅助窗口不覆盖主窗口记录。
- **设置回写修复** — 设置面板与窗口几何保存基于最新设置合并，减少陈旧快照覆盖其他设置的问题。
- **窗口保存请求顺序** — 新保存请求使较早的异步读取失效，避免旧尺寸和位置覆盖最新记录；退出前等待当前保存完成。
- **多屏恢复** — 按历史窗口位置选择仍连接的显示器，原显示器不可用时回退到当前屏幕并限制恢复尺寸。

---

## Changelog (English)

### What's New

- **Connection sorting within groups** — Add sorting beside each group count, including recent / ungrouped connections, with default, IP and name ascending or descending order; persist preferences per group without changing saved connection order.
- **SSH tab titles** — General settings let SSH tabs use connection names (default) or dynamic terminal titles; changes immediately update existing labels and tooltips, following the focused session in split panes.

### Bug Fixes

- **Live connection panel refresh** — Refresh the connection panel after additions and edits, and await SSH deletion before refreshing to avoid stale entries.
- **AI conversation context restoration** — Restore the Agent message context when reopening a conversation, retain assistant text and reasoning before tool calls, restore tool images and error markers, and supply placeholder results for interrupted calls.
- **Main window state persistence** — Save and restore the main window size, position and maximized state; utility windows do not overwrite the main window record.
- **Settings persistence fix** — Merge panel edits and geometry updates into the latest settings to reduce stale snapshot overwrites.
- **Geometry save ordering** — Invalidate earlier asynchronous reads when a newer geometry save starts, preventing stale dimensions and positions from overwriting the latest record; await the current save before exit.
- **Multi-monitor restoration** — Select an attached monitor using the saved window position, and fall back to the current screen with bounded window dimensions when the original monitor is unavailable.

---

## v0.2.12

### Agent 双形态(原生 TUI + 手机聊天镜像)

- **审批桥(手机可批)** — claude 弹权限确认时,手机 Agent 页直接出审批卡(允许/拒绝),点了即回投给 claude,**终端不再弹窗**;手机 90 秒未决/离线自动回落原生 TUI 弹窗,审批永不被吞。local TUI 模式手机可批,这是 Happy 做不到的
- **对话实时展示** — assistant 正文改走 MessageDisplay hook 实时流式下行(markdown 原文行批),不再等整轮结束 transcript 落盘才一次性冒出;hook 失联轮自动回落 transcript 全文兜底,历史回放不受影响
- **工具进行中态** — PreToolUse hook 实时合成工具卡(执行开始瞬间出现「运行中」spinner 徽章),轮末 transcript 的重复卡由手机归约器幂等吸收(同 id 就地合并,不重复建卡、不打断流式气泡)
- **Agent 页状态条** — 顶部实时显示 claude 在做什么:思考中(紫)/ 执行 <工具>(蓝)/ 等待你的确认(橙);idle 自动隐藏。由 hook 事件流驱动(UserPromptSubmit/PreToolUse/PostToolUse/Stop/Notification),零 token
- **启动模式** — 欢迎页新增启动模式选择:标准 / 继续上次对话(--continue)/ 计划模式(--permission-mode plan)/ 跳过权限确认(--dangerously-skip-permissions,红色警示);对当前目录与选目录启动均生效
- **通知去重** — 审批卡在手机上时不再同时弹「去终端确认」的 attention 卡;任务完成后的空闲提醒不再误报成审批提示(状态条置 idle)
- **Agent 页 statusline(对齐 ccstatusline)** — 输入框下方状态行:模型(展示名,可点切换 /model)· 思考等级(可点切换 /effort)· git 分支 · 上下文占用百分比(分级着色,接近 compact 阈值转橙/红);数据零侵入取自 transcript(model/usage/gitBranch/cwd)与 hook 的 CLAUDE_EFFORT,不注入 statusLine 配置、不影响用户终端里自己的 statusline
- **模型/思考等级菜单动态化(告别硬编码漂移)** — 新增 `GET /api/agent-options`:桌面运行时从本机 claude 二进制提取 /model 别名全集与 /effort 档位全集(claude 升级增删模型后自动跟随,含 ultracode 第 6 档),带进程级缓存与结构校验;提取失败逐级回落(内置快照,UI 可标注);手机菜单 label 按规则生成,未知新别名自动可读
- **状态指示器归位** — 从页面左上角移进对话流,跟在最新消息下方(思考中/执行工具/等待确认小胶囊),出现自动滚入视野
- **工具卡合并 + 紧凑化** — 同批连续工具调用合并为一张组卡(每工具一行、独立展开、独立运行中/完成徽章);卡片留白减半、不再占满全宽
- **Agent 页标题** — 跟随会话标签名(与终端页一致),不再固定显示 "Agent"
- **审批卡对齐终端语义** — 选项 = 允许 / 总是允许(claude 建议的 don't-ask-again,回 updatedPermissions)/ 拒绝(可附"告诉 Claude 该怎么做"反馈);已决后收缩为一行结果摘要
- **AskUserQuestion 选择题** — claude 问选择题时手机出问题卡:单选点即提交、多选、自定义文本回答;答案经 updatedInput.answers 回传(masko-code 同款机制)
- **对话体验** — 气泡长按复制;列表底部锚定(新内容自动追随、键盘弹出内容跟随上推);右上角操作菜单(打断 / /compact / 复制全部对话 / /clear)
- **新增底部 tab:任务** — claude 任务清单(TodoWrite)实时展示:进度条 + pending/进行中/已完成状态,claude 退出自动清空
- **新增底部 tab:Git(GitHub 图标)** — 会话目录的仓库面板:分支与 ahead/behind、变更文件列表(点开逐行着色 diff,支持 untracked)、提交说明输入 + 全部暂存提交、pull(--ff-only)/push、提交历史;桌面新增 5 个会话级 git REST 端点(仅本机会话,cwd 由 shell integration OSC 上报实时跟踪)
- **Git tab 完善(fix14)** — 右上角操作菜单:切换分支(sheet 列表,当前打勾)/ 新建分支 / Fetch / Stash 暂存与恢复 / 丢弃全部改动(双确认);文件行右滑暂存/取消暂存(带绿勾反馈)、左滑丢弃(确认);提交历史点开看完整提交 diff(git show,超长截断)、长按复制 hash;桌面再增 6 个 git 端点(branches/show/checkout/stage/discard/stash),分支名防 flag 注入、hash 严格校验
- **Git tab 图标** — GitHub mark 换 SF Symbol 分支符号(arrow.triangle.branch),自动跟随 tab 高亮着色,删自定义资源

### 主页「文件」tab(配对电脑文件管理)

- **文件浏览** — 主页第 2 个 tab 从占位实现为配对桌面本机文件浏览器:从家目录逐级进入(系统返回/右滑),图标/大小/修改时间与会话页一致,下拉刷新、搜索过滤当前目录、显示隐藏文件;不依赖终端会话、不需要接管;桌面新增 4 个会话无关文件 REST 端点(list/download/upload/op,Bearer 鉴权,上传临时文件+原子落位、同名自动加 (N) 后缀)
- **传输队列** — 右上角队列按钮(进行中数量角标):多任务上传/下载并发 2,进度条、取消、失败重试、清除已完成;下载落系统文件 app 可见的 MeTerm/Downloads(完成项点开预览、可分享);上传支持文件多选与相册照片
- **预览分流** — 点文件:图片/音视频/PDF/Office 走 QuickLook;小文本原生预览可编辑保存;可执行/库/压缩包等不可预览类型直接弹操作菜单(下载到文件/复制路径),不再下载后弹无意义占位页;下载后再过一遍 canPreview 兜底(损坏/伪装扩展名)
- **多桌面 + 冷启动** — 顶部多桌面切换器(会话页同款,0/1 台自动隐藏);冷启动三态:离线橙条 / 首载「连接中…」占位 / 失败内联通知卡带重试,桌面回连自动重载,不闪空态不弹错
- **切换桌面传输保护** — 有进行中的传输任务时,切换桌面(切换器/桌面管理页任一入口)先弹确认「中断传输并切换」,确认后干净取消在飞任务再切换;无任务直切零打扰
- **系统分享接入(用 MeTerm 打开)** — 注册为通用文档处理 app:文件 app 分享菜单与任何应用的「用其他应用打开」里出现 MeTerm,选中后进「上传到电脑」引导——选目标电脑(多台可选,默认当前活跃)→ 逐级浏览选目标文件夹 → 逐文件进度上传(失败单个重试);多文件连续分享合并一次引导;冷启动预热窗口静默重试 3 发(显示"连接中…",不闪假错),回连自动重载

### 问题修复 / 优化

- **连接 JumpServer 堡垒机报「No common algorithm」** — SSH 算法偏好不再隐式继承 russh 的默认表。上游默认表在版本间会漂移，而漂移会静默改变「能连上哪些服务器」：russh 0.46 不提供 `ssh-rsa` 主机密钥算法，而 JumpServer Koko 的 RSA 主机密钥恰恰只以这一个名字宣告，两边交集为空导致密钥交换直接失败，且旧版错误信息不含任何算法类别、无从诊断。现改为在上游表基础上**只做追加**（上游新增的 mlkem768 等仍自动获得）：补 `ssh-rsa` 主机密钥、补 OpenSSH/Go 标配但 russh 至今不默认提供的 `ecdh-sha2-nistp256/384/521` 密钥交换、补 `aes128-gcm@openssh.com`；追加项一律排在末尾，现代服务器的协商结果不变。桌面端的终端会话与 SFTP 两条连接、移动端 SSH 核心一处，共三处保持同一套偏好，并由两侧同构的单元测试锚定——今后升级 russh 若收窄可连服务器集合，由 CI 而不是用户在堡垒机前发现。同时补回上游 0.61 移出默认的 SHA-1 HMAC（`hmac-sha1` / `hmac-sha1-etm`），但严格排在全部 SHA-2 MAC 之后——只支持 SHA-1 MAC 的老堡垒机与网络设备恢复可连（这是升级 russh 相对 v0.2.11 的回退），而现代对端不受任何影响：它们要么提供 SHA-2 MAC，要么协商到 AEAD 密码从而根本不进行 MAC 协商。该排序由单元测试锚定，防止今后被无意提前
- **macOS 开发版钥匙串弹窗收口** — SSH、Remote、JumpServer 与 Settings 启动均不再逐条自动扫描/重试旧 Keychain：主窗口只检查 Web Storage 并记录脱敏 pending/manual/complete 状态或非敏感 presence cache，辅助窗口只读 cache；明文来源保留，只允许由显式连接、设置或后续正式 recovery UI 处理。原生 Release 服务启动也不再扫描 registry 对应 SSH 项或整库删除 legacy service。签名 `MeTerm Dev` 的单连接 v2 恢复永不读取正式 v3，桌面私钥路径必须本机重选，key-ladder 只写新 authority marker。SSH、Remote、JumpServer、Settings、Relay 与 TLS 的 macOS 新 account 均采用 add-only 创建；SSH 不凭公开 binding 自动提升 v2，Relay 孤儿/legacy current item 不会被覆盖。SSH registry 双写使用 before-image、延迟删源及 post-rename 可见提交语义。Relay 禁用状态启动不读取/删除 vault。真实签名升级、包括 SSH/Remote/JumpServer/Settings/Relay 在内的 deterministic current-item ACL provenance/随机 generation、持久崩溃恢复 journal、正式 recovery UI 与孤儿审计等事项仍按发布清单阻断
- **macOS 终端从后台恢复后低频字形错乱** — 窗口重新聚焦时仅重建 xterm 渲染纹理并全量重绘；WebGL context 无法恢复时自动回退默认 renderer。保留锁屏/休眠与 PiP 退出原有的 SIGWINCH 尺寸抖动逻辑，普通聚焦不改变 PTY 尺寸
- **移动端与中继安全加固** — 中继参数不再出现在 Android/iOS 界面或普通日志；移动端改用设备级可撤销凭据与固定证书，桌面端按精确凭据代次断开连接/推送，慢请求在正文读取期间持续复验撤销状态；本机 Agent Hook 在读取正文前校验可信入口和会话密钥，并限制为 64 KiB/30 秒空闲超时。完整威胁模型与正式分发阻断项见 `docs/SECURITY.md`
- **分发安全基线与供应链闸门** — 标准桌面 Release 的移动控制 scope 默认全空并由编译期/36 路由矩阵共同锁定；Android 改为直接使用 AndroidKeyStore 与有界 RFC 6455 reader，正式 AAB 强制 upload key 签名校验；iOS 加入 privacy manifest、Keychain group 隔离与 production APNs entitlement，FFI 原生依赖固定最低系统 18.0。新增依赖锁定、含 Control Broker 与更新服务 Worker 的 9 份 CycloneDX SBOM、统一审计脚本、Relay 最小权限 systemd 样例及 `docs/RELEASE_CHECKLIST.md`；9 份 SBOM 本机已成功生成，OSV/审计门禁对 RSA、`quick-xml` 与 allowed/unmaintained 残余持续失败关闭
- **正式签名隔离拆分** — 针对旧工作流“同 runner 构建后再注入长期密钥”的风险，macOS、Windows、Linux、Android、iOS 已全部改为新鲜 build → 唯一生产 signer → 新鲜 public-only verifier；所有 `v*` 仍在 checkout/Environment/secret 前阻断，直到真实签名演练、源码证据单一编排、密钥迁移和仓库外保护闭环
- **独立 Control Broker 第一阶段** — 新增第四个独立 Rust workspace，落地严格长度前缀 CBOR、transport peer 认证门、固定只读 `status.get`、版本/deadline/大小/in-flight/replay 失败关闭及跨进程负向测试；生产 binary 从不自行创建 listener，继续返回 `blocked`/空 scope，不迁移或暴露任何现有 secret
- **Linux Control Broker 第二阶段** — 增加只接受 systemd fd 3 的固定 Unix socket adapter，校验 `SO_PEERCRED`、PID/start-time/UID/GID、root-owned App inode 与 SHA-256 manifest，并加入连接限额、hash 单调时钟预算/I/O deadline、hardened service/socket/sysusers/tmpfiles 及负向测试；仍为 status-only，跨 UID `/proc` 发行矩阵未验收时失败关闭，不授予 root/`CAP_SYS_PTRACE`，不启用任何 scope
- **Windows/macOS Control Broker 第二阶段** — Windows 落地 restricted service SID、固定 pipe、token/file ID/ACL/Authenticode 验证；macOS 落地 XPC audit-token/Developer ID requirement、root manifest/file ID/SHA-256/CDHash 验证与 `_meterm-control`/SMAppService 部署输入。两者仍只返回 `blocked`/空 scope，不持有 secret 或联网；当前 macOS App 的动态库/可执行内存例外会被新 peer policy 故意拒绝，三平台仍需完成 clean-machine 安装/升级/回滚、secret/scope/业务 operation 迁移
- **依赖残余风险收口** — 桌面 `plist` 升至 1.10.0 并移除一组易受攻击的 `quick-xml 0.38`；剩余 Windows 通知/Linux 构建期 XML 路径与 RSA SSH advisory 已记录可达性和发布签字要求

---

## v0.2.11

### 新功能

- **macOS 代码签名 + 公证** — 使用 Apple Developer ID 对 App 与 DMG 签名并公证、装订（staple），下载后**双击即可打开**，不再需要手动解除隔离（`xattr -cr`）
- **访达右键「Open in MeTerm」** — macOS Finder 右键菜单可直接用 MeTerm 打开所选目录/文件所在目录（Finder Sync 扩展，签名后自动生效）
- **主页改为连接侧边栏** — 取消独立主页，连接管理改为停靠式左侧侧边栏（鼠标悬浮工具栏按钮可浮出菜单，不遮挡终端）；应用启动默认打开一个本地终端
- **标签拖出独立窗口** — 标签可拖到窗口外新建独立应用窗口，拖动时有跟随预览
- **AI 对话侧栏化** — AI 对话改为仅在侧边栏，agent 按钮移到工具栏（分享按钮左侧），底部命令输入框默认折叠
- **文件侧栏递归搜索** — 文件树新增搜索按钮，支持本地与 SFTP/JumpServer 递归搜索
- **面板增强** — 右键可将面板抽取为独立标签；面板可拖动重排（拖到中间替换、靠边插入）；移动手柄激活时向左滑出显示该面板标题
- **文件树「在访达/资源管理器中打开」** — 本地会话右键菜单新增（macOS 访达 / Windows 资源管理器）

### 问题修复 / 优化

- **工具栏图标体系统一** — 按钮纯图标化（激活高亮），AI 改文字图标、文件管理器改侧边栏式图标，左右两侧图标大小与间距统一；标签栏与终端之间留出呼吸间距且无接缝
- **面板区分更清晰** — 去掉激活面板外高亮框，改为未激活面板内容暗化 + 面板间可见分隔线（悬浮/拖动高亮）
- **状态栏自动隐藏** — 空闲时收起并回收占位空间，连接/传输/AI 活动时再显示
- **连接侧边栏跟随毛玻璃设置** — 关闭毛玻璃后侧边栏显示为实色，不再固定半透明
- **Windows 本地搜索结果定位** — 修复本地搜索命中路径分隔符与文件树不一致，导致点击结果无法定位、目录列错位
- **Linux 拖拽预览透明** — 修复拖拽预览窗口在 GTK 下透明边距被渲染成不透明方块

---

## v0.2.9

### 新功能

- **Plan 面板浮在对话框输入栏上方** — 任务计划从聊天消息流里拿出来作为独立悬浮卡片，贴在 AI 对话面板底部、紧靠输入框。Apple 风丝滑动画：入场从底部滑起 + 淡入；进度条 cubic-bezier 平滑填充；项目状态 icon 跳变（pending→in_progress→completed）；运行中项有横向 shimmer；全部完成后高亮 3 秒再滑回。视觉与对话面板 liquid-glass 风格一致，两侧 inset、四角圆角

### 问题修复

- **错误分类器误将「模型不存在」当作「工具不支持」永久降级** — 之前只要错误消息含「not supported」就把 agent 标记为 `toolsSupported=false`，结果一次「Not supported model X」之后所有模型都被切到 chat-only。改为必须同时出现「tool/function」+「not supported/unsupported/unrecognized」才归类为工具不支持
- **切换模型后仍卡在「无工具」模式** — `ToolAgent` 新增 `lastResolvedModel`，runLoop 检测到模型变了就重置 `toolsSupported`。让换模型能恢复
- **Plan UI 任务执行中看不到、做完才突然出现** — 老逻辑里 board 跟 tool card 都 append 到 chat-messages 末尾，每个 tool card 都把 board 顶上去；最后一次 todo_write 才重新拉回底部，所以「任务完成才看到」。新设计把 board 移出 messages 流，作为 chat panel 直接子元素位于消息区与输入框之间

---

## v0.2.8

### 新功能

- **AI 思考模式开关** — 设置面板新增「思考模式」总开关，AI Bar / 侧面板新增脑图标快速切换；启用时向请求体注入 `thinking.type` / `enable_thinking` / `chat_template_kwargs.enable_thinking` 三种字段，覆盖 DeepSeek V4 / Qwen3 / GLM / MiMo / vLLM 等思考模型；本轮对话中途切换无须重连，未知字段被 OpenAI / Anthropic / Gemini 忽略
- **SSH 无凭据连接** — 选「密钥」认证、密钥路径留空时走 OpenSSH 风格梯子：先 `$SSH_AUTH_SOCK` (ssh-agent) 轮询所有 identities，再按 `id_ed25519 → id_ecdsa → id_rsa → id_dsa` 顺序试默认密钥。成功后底部 toast 提示实际走的路径
- **SSH 私钥文件选择器** — 密钥输入框旁新增浏览按钮，原生文件对话框，默认起始 `~/.ssh/`
- **SSH 动态提示** — 切到密钥模式时检测默认密钥与 ssh-agent 状态：placeholder 显示「留空将自动使用 ~/.ssh/id_ed25519」或「留空将通过 ssh-agent 认证」；agent 有身份时显示 `agent: N` 徽章
- **JumpServer 连接反馈即时化** — 点击资产后 tab + 占位符**立即出现**（之前要等 token API 返回才出，资产慢时会等 1-3 秒）；占位符按阶段更新文案：正在认证 → 正在获取连接令牌 → 正在连接 user@host

### 问题修复

- **AI 调用 400「reasoning_content must be passed back」** — Qwen3 / DeepSeek V4 等思考模型要求带 tool_calls 的 assistant 必须回传 reasoning_content。前端在流式累积 reasoning、序列化时强制带回（空也带空串），符合官方文档要求
- **SSH 私钥路径无法连接** — 前端发的是路径但 Rust 后端直接当 PEM 解析必败；补回 Go 后端迁移漏掉的 `~` 展开 + HOME 沙箱 + 文件读取逻辑，russh 终端 / ssh2 SFTP 两条路径都修
- **JumpServer SFTP 无法初始化** — Koko 的连接 token 按 protocol 隔离且常为单次使用，第二条独立 SSH 连接被拒。改为在已认证的终端 session 上起 sftp 子通道（multiplex），普通 SSH 仍走独立连接保留传输性能；SFTP 初始化失败时把具体原因带回前端，不再只是「retry」
- **JumpServer 侧边栏文件树加载慢** — 多个原因叠加：
  - `loadDirectoryRaw` 没加 `soft_limit:5000` 软上限，大目录通过复用通道一次性拉数万条
  - 没用上现有的目录缓存，drawer 刚拉过的目录 sidebar 又走网络
  - `fm.currentPath==='/'` 被误判为「未加载」，导致根目录就是 home 的资产（如多数 JumpServer 资产）侧边栏一直等一个不会再来的事件
- **JumpServer 侧边栏不跟随 auto-cd** — `FileManager.onPathChanged` 从单回调改成订阅者集合，sidebar 长期 follower 跟随 FM 的路径变化（auto-cd / 终端 cd），面包栏手动输入或锁定时停止跟随
- **重命名报「Invalid filename」** — `renameFile(oldPath, newName)` API 改了支持绝对路径但校验没跟着改，必拒；改为只校验 basename
- **侧边栏树重命名 1-2 秒空白** — sidebar 模式下 drawer 的「重命名中...」overlay 被隐藏，用户无反馈；新增乐观更新：按 Enter 立刻在树里改名 + 服务端响应回来 refreshAll 自然吻合；失败时也派发 file-op-done 自动回滚
- **树移动文件后展开节点闭合** — `refreshAll` 把 expansion 快照捕获放在第一个 await 之后，并发 refresh 时读到的是被另一个调用清掉的空 nodeMap；快照挪到 await 之前 + 删除 `onMove` 里冗余的 setTimeout refreshAll

---

## v0.2.7

### 新功能

- **JumpServer 会话过期处理** — 全链路会话过期识别与恢复：资产面板 banner、pop-out 窗口引导回主窗口、面板 header 右键菜单（重新登录 / 退出登录）、toolbar 下拉项右键菜单、掉线重连前置过期/登出检查
- **JumpServer SFTP 认证自愈** — 凭据失效时自动刷新并恢复传输；新增 SFTP 凭据刷新 HTTP 端点；错误分类细化（`SFTP_AUTH_FAILED` / `SESSION_EXPIRED`），分类器覆盖上传/下载嵌套 error 字段
- **AI Agent 中文化** — 工具卡名称中文显示（`run_command` → 运行命令、`read_terminal` → 读取终端、`todo_write` → 更新计划等 19 项），任务计划状态中文化（待办 / 进行中 / 已完成），`wait_for_user_input` 状态文案中文化
- **任务计划 UI 优化** — 宽度对齐工具卡片，padding/字号/边距收紧，去掉状态徽章 uppercase 防中文挤压
- **文件管理器右键菜单优化** — "刷新"提到一级菜单；自定义右键菜单（Tab/Shell/文件链接）补齐高斯模糊样式
- **文件名校验放宽** — 支持 Linux/SFTP 合法字符（含括号、空格等 POSIX 文件系统允许的字符）

### 问题修复

- **更新重启被退出确认对话框拦截** — 修复点击"立即重启"后被退出确认弹窗拦截导致更新不生效
- **终端粘贴图片被 AI Bar 全局捕获** — 修复在终端 Cmd/Ctrl+V 粘贴时,AI Bar 错误地从系统剪贴板拉取图片附加到聊天
- **任务计划 UI 被挤压消失** — 修复长聊天中 plan board 被后续消息挤压到 0 高
- **思考块泄漏 XML 标签碎片** — 过滤 `</think>` / `</arg_value>` 等流式残片,历史压缩切到换行边界减少 dangling 片段
- **树视图右键新建文件夹路径错乱** — 修复对话框停留过久后 contextPath 5 秒超时漂移导致目录创建到错误位置;新建后自动展开父目录立即显示

---

## v0.2.6

### 新功能

- **Neo-Brutalism 可选主题** — 含圆角变体 + 11 套预设配色（赛博朋克/深渊/薰衣草/午夜/糖果/复古/极光/德古拉/曝光/纯黑系列）+ 自定义调色板，支持跨窗口实时同步

### 问题修复

- **SSH 锁屏恢复后 OSC 响应回显为可见文本** — 修复 OSC 10/11/12 颜色查询在锁屏恢复后泄漏到终端输出
- **锁屏恢复后 TUI 鼠标模式丢失及内容不完整** — 恢复鼠标跟踪状态并重绘 TUI 界面
- **JumpServer v2 资产浏览器平台字段未显示** — 修复 v2 API 响应字段解析
- **分屏切换时命令高亮闪烁 + 分割面板虚假滚动条** — 修复跨面板高亮闪烁及多余滚动条
- **窗口缩小时滚动区域高度计算错误** — 修复缩小窗口后出现异常滚动条的问题

---

## v0.2.5

### 新功能

- **AI Agent 系统** — 多面板感知、跨面板操作；任务规划、文件传输、结构化搜索、会话 PTY 锁；复用 SFTP 链路实现通用文件附件；传输进度可视化、文件管理器同步、智能超时检测
- **内置编辑器增强** — Markdown 渲染预览、图片预览、自动换行
- **SFTP 高速传输** — 双通道 WebSocket + 文件传输并行化 + 内存优化；下载路径修复
- **文件管理器大目录性能优化** — 虚拟滚动渲染、详情弹窗、符号链接修复；文件管理侧边栏、上传下载全面优化
- **终端字体大小快捷键** — Ctrl/Cmd +/- 实时调整终端字号
- **审计日志** — 改用系统默认文本编辑器打开

### 问题修复

- **上传冲突/取消卡片显示正确状态** — 区分用户主动取消与被动冲突的卡片状态
- **upload_file 重名文件拦截** — 不再静默覆盖，正确弹出冲突确认
- **Agent 传输四项修复** — 重名检测、取消感知、文件列表刷新、引导消息竞态

---

## v0.2.4

### 新功能

- **文件管理器全面升级**
  - 面包屑导航 + 键盘导航 + 文件搜索 + 多选操作
  - 远程文件复制/移动、状态栏、文件属性弹窗、符号链接支持
  - chmod 权限修改、书签收藏、限速控制、传输完成通知
  - 右键菜单增强（空白区域支持 + 显示隐藏文件切换）
  - 缩略图开关（关闭可节省内存并隐藏总览按钮）
  - 删除确认弹窗显示 rm 命令并提供复制按钮；批量上传冲突支持全部覆盖/全部跳过
- **内置编辑器格式化** — 一键格式化 JSON/XML/HTML/CSS
- **终端字体增强** — 新增字体选项、字重控制、文字锐化
- **AI 对话框侧栏模式** — 可切换为侧边栏，液态玻璃 UI 风格，Markdown 渲染增强
- **Shell Hook 回退模式** — 无 Shell Hook 时，鼠标点击依然可定位光标、拖拽依然可选中编辑
- **服务器信息紧凑卡片** — 工具栏图标化、AI bar 动态占位提示

### 问题修复

- 多个文件管理相关细节修复（拖拽上传防抖、路径重复拼接、UI 遮挡等）

---

## v0.2.3

### 新功能

- **Linux 平台支持** — 新增 Linux x64 / arm64 CI 构建（已测试 Ubuntu 24.04），发布 `.deb` / `.AppImage` / `.rpm` 包
- **README 下载入口更新** — 新增 Linux 平台下载链接和安装说明

---

## v0.2.2

### 新功能

- **OSC 序列全面增强**
  - OSC 52 剪贴板穿透（支持远程程序向本地剪贴板写入）
  - OSC 8 超链接（终端内可点击 URL）
  - OSC 133 语义提示符拦截
  - 图片显示协议支持
  - Unicode 11 字符宽度更新
- **Shell Hook 注入**
  - 点击移动光标（基于 OSC 7768 语义提示符，支持精确定位）
  - 命令区拖拽选中编辑（删除/替换/剪切/复制）
- **Linux UI 完善** — 多轮适配 GTK CSD/圆角/透明窗口，修复顶部透明条、下拉框主题化等问题

---

## v0.2.1

### 新功能

- **本地终端 IPC Channel** — 替代 WebSocket，本地会话连接延迟更低
- **SSH 代理支持** — SOCKS5 / HTTP CONNECT 代理，JumpServer 可独立配置代理
- **窗口置顶按钮** — 快速将当前窗口固定在最前
- **Chrome 风格标签切换快捷键** — Ctrl/Cmd 1-9 直接跳转对应标签
- **自定义设备名 + 远程设备别名** — 局域网共享时可自定义显示名称
- **可配置代理模式** — 本地终端与远程终端可分别配置连接方式

### 问题修复

- **开发版与安装版单实例冲突** — 修复使用相同 identifier 导致无法同时运行的问题

---

## v0.2.0

### 架构迁移

- **纯 Rust 进程内后端** — 从 Go sidecar 架构迁移至 Rust in-process，消除外部进程管理和 IPC 开销
- 后端基于 Axum + Tokio，支持 WebSocket 二进制协议
- 跨平台 PTY：统一抽象 Unix PTY、Windows ConPTY、WSL、SSH
- 会话状态机：Created → Running → Draining（环形缓冲区）→ Closed，支持无缝重连
- SFTP 自适应流水线：基于 RTT 动态调整窗口（2→64），实现高吞吐传输
