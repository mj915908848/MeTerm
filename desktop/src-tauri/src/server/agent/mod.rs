//! Agent 聊天(方案甲 / Mirror)子模块。
//!
//! 镜像用户在 PTY 里自己运行的 claude CLI:经 Claude Code hooks(`POST /api/agent-hook`)
//! 与 transcript JSONL tailer 拿到结构化对话流,归一成内部 `AgentEvent`,经 WS 下行给手机端;
//! 手机端上行输入注入底层 PTY,审批经审批桥回投阻塞中的 hook。
//!
//! - `events` —— 内部归一化事件 `AgentEvent`。
//! - `upstream` —— 上行 dispatch(手机→桌面:发消息 / 审批 / 打断)。
//! - `mirror` —— 方案甲 M4:transcript JSONL tailer + 行→AgentEvent 纯映射(镜像内容主源)。
//! - `hook` —— 方案甲 M3:`POST /api/agent-hook` 端点 + SessionStart 升格镜像(接线层)。
//! - `permission_bridge` —— 方案甲 P2:PermissionRequest hook 与手机审批决策的桥。
//! - `manager` —— `AgentManager`(会话注册表 / fan-out / attach 回放)。

pub mod events;
pub mod hook;
pub(crate) mod hook_guard;
pub mod manager;
pub mod mirror;
pub mod permission_bridge;
pub mod upstream;

pub use events::{AgentEvent, PermissionOption};
pub use hook::MirrorRegistry;
pub use manager::{AgentEntry, AgentManager};
pub use mirror::{spawn_transcript_tailer, TailerHandle};
pub use permission_bridge::{PermissionBridge, PermissionReply};
