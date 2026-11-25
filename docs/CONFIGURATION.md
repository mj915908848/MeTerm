# 配置参考 / Configuration Reference

## 进程内服务默认值

桌面应用启动时会创建进程内 Rust 服务。HTTP 固定监听 `127.0.0.1`，优先复用应用数据目录中保存的端口，端口不可用时由系统分配。原 Go sidecar 的命令行参数已停用。终端数据走 Tauri IPC，回环 HTTP 接口见 [REST API 参考](API.md)。

| 会话设置 | 内部默认值 | 说明 |
|----------|------------|------|
| 会话存活时间 | 5 分钟 | 最后一个客户端断开后，会话可以等待重连的时间 |
| 重连宽限 | 60 秒 | 断线后保留客户端身份的时间 |
| 环形缓冲区容量 | 256 KiB | 每个会话保留的近期 PTY 输出，供重连时回放 |

## 客户端设置

以下列出部分 `AppSettings` 字段。完整类型及默认值见 [themes.ts](../desktop/src/themes.ts)。

```typescript
interface AppSettings {
  // 外观
  theme: string;                   // 终端主题名称
  colorScheme: ColorScheme;        // 配色方案 (auto/dark/darker/navy/light)
  opacity: number;                 // 窗口透明度 (%)
  fontSize: number;                // 终端字号
  fontFamily: string;              // 字体 key
  enableNerdFont: boolean;         // Nerd Font 开关
  enableLigatures: boolean;        // 编程连字
  fontWeight: number;              // 终端字重 (300/400/500/700)
  encoding: string;                // 编码方式
  language: 'en' | 'zh';           // 界面语言

  // 背景
  backgroundImage: string;         // 背景图片路径
  backgroundImageStrength: number; // 背景图显示强度 (20–100%)

  // 窗口与布局
  sshTabTitleMode: 'connection' | 'terminal'; // SSH 标签名称；默认 'terminal'（终端动态标题），'connection' 为可选 / SSH tab title mode; defaults to 'terminal' (dynamic title), 'connection' is opt-in
  autoOpenAiOnConnect: boolean;    // 连接成功后自动打开 AI 面板，默认 false；不自动发送请求 / Auto-open AI after connecting, default false; never auto-send requests
  autoRestoreAiHistoryOnConnect: boolean; // 自动打开时恢复同主机最近的已绑定对话，默认 false；依赖 autoOpenAiOnConnect，不覆盖现有任务 / Restore latest bound same-host history on auto-open, default false; requires autoOpenAiOnConnect and never replaces an existing task
  rememberWindowSize: boolean;     // 记住窗口尺寸/位置（主窗口）
  windowWidth: number;             // 窗口宽度（逻辑像素）
  windowHeight: number;            // 窗口高度（逻辑像素）
  windowX?: number | null;         // 窗口左上角 X（逻辑像素）；null = 交给系统放置
  windowY?: number | null;         // 窗口左上角 Y（逻辑像素）；null = 交给系统放置
  windowMaximized?: boolean;       // 上次保存时主窗口是否处于最大化
  rememberDrawerLayout: boolean;   // 记住抽屉布局
  drawerHeight: number;            // 抽屉高度
  fileManagerFontSize: number;     // 文件管理器字号

  // AI
  aiProviders: AIProviderEntry[];  // AI 提供商列表
  aiActiveModel: string;           // 当前活跃模型
  aiTemperature: number;           // 模型温度
  aiMaxTokens: number;             // 最大 Token 数
  aiContextLines: number;          // 终端上下文行数
  aiBarOpacity: number;            // AI 胶囊透明度

  // 通知
  enableTerminalNotifications: boolean; // 终端事件桌面通知
  previewRefreshRate: number;      // 预览刷新率
}
```

## 会话生命周期

```
          ┌──────────┐
          │ Created  │  等待首个客户端连接
          └────┬─────┘
               │ 客户端连接
               ▼
          ┌──────────┐
     ┌───>│ Running  │  客户端在线，PTY 输出广播给所有人
     │    └────┬─────┘
     │         │ 最后一个客户端断开
     │         ▼
     │    ┌──────────┐
     │    │ Draining │  无客户端，PTY 输出写入环形缓冲区
     │    └────┬─────┘  TTL 倒计时（默认 5 分钟）
     │         │
     │    ┌────┴────────────┐
     │    │                 │
     │    ▼                 ▼
     └── 重连           ┌──────────┐
                       │  Closed  │  会话关闭，资源释放
                       └──────────┘
```

## 客户端角色系统

| 角色 | 值 | 输入 | 调整大小 | 可提升 | 适用场景 |
|------|-----|------|----------|--------|----------|
| Viewer | 0 | ✗ | ✗ | ✓ | 观察者，可被提升为 Master |
| Master | 1 | ✓ | ✓ | — | 完全控制，同时只有一个 |
| ReadOnly | 2 | ✗ | ✗ | ✗ | AI/机器人，永不提升 |

**角色转移机制：**
- Viewer 可发送 `MsgMasterRequest` 请求成为 Master
- 当前 Master 收到 `MsgMasterRequestNotify` 通知
- Master 可批准/拒绝请求
- 支持主动 `MsgMasterReclaim` 收回控制权

## 历史 macOS 兼容性记录 / Historical macOS compatibility notes

`PROJECT_RULES.md` 规则 1 要求：凡影响 macOS 功能、行为、显示与交互的改动，必须先与项目负责人协商并获得明确同意。v0.2.13 / v0.2.14 涉及的 macOS 侧变化如下，合入前需一并确认。

| 变化 | 默认表现 | 是否改变既有默认 |
|------|----------|------------------|
| SSH 标签名称 `sshTabTitleMode` | `'terminal'`，保持终端动态标题 | 否，连接名称为可选 |
| 主窗口位置与最大化还原 | 随「记住窗口尺寸」开关一并生效 | 是，主窗口恢复到上次位置/最大化，不再由系统放置 |
| 连接侧栏分组排序控件 | 显示在分组标题右侧 | 是，分组标题新增一个按钮 |
| AI 历史搜索入口 | 侧栏内联视图有独立搜索框；AI Bar 弹层复用 AI Bar 输入框 | 否，AI Bar 下仅保留一个搜索入口 |

### v0.2.15 的 macOS 侧变化 / macOS-side changes in v0.2.15

这三项属本 fork 侧决策，按规则 1 需项目负责人确认后合入；前两项分别改变既有显示与既有行为，第三项只影响未签名构建。

| 变化 | 默认表现 | 是否改变既有默认 |
|------|----------|------------------|
| 标题栏标签宽度分配 | 按每个连接名的实测宽度分配；整排放不下时只收窄过长的标签，仍放不下才降级为横向滚动 | 是，不再把单个标签固定为可用宽度的 1/3，也不再在空间不足时把所有标签等宽压扁 |
| 「检查更新」的菜单栏 / 托盘 / 关于页三个入口 | v0.2.15 使用系统浏览器打开 Releases 页面 | 是，这是当时的行为。当前更新方式见 [下载安装](../README_CN.md#下载安装) |
| dmg 的安装方式 | 映像内只有 `MeTerm.app` 与 `Applications` 快捷方式，接收方拖放安装；首次打开由接收方在「系统设置 → 隐私与安全性」放行 | 是，v0.2.15 曾附带 `Open-MeTerm.command` 放行助手，实测会被 Gatekeeper 拦下，已移除 |

尚未在 macOS 实机验收的项（多显示器位置回退、SSH 分屏与重连、正式签名与公证安装包）见 `KNOWN_ISSUES.md` 的 `MAC-001` / `MAC-002`。上表第一项的标签宽度分配，已于 2026-09-20 在 macOS 真机验收通过；未签名分发链路（`MAC-003`）同日改为拖放安装，原先的放行助手方案经真机实测不成立，已废弃。
