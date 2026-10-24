# REST API 参考 / REST API Reference

本文记录当前 Rust 内置服务的接口契约。终端数据走 Tauri IPC，帧格式见 `docs/PROTOCOL.md`。

> 分享功能（局域网访问、配对、设备凭据、mDNS 发现、手机中继与推送、终端 WebSocket）已移除。
> 内置服务只监听 `127.0.0.1`，接受连接时拒绝非 loopback 对端，只为本应用自己的窗口服务。

## 认证与传输

- 所有业务接口都需要本机 `owner token`：`Authorization: Bearer <token>`。凭据不得出现在 URL
  查询参数中。
- owner token 只接受直接 loopback 连接；带 `Origin` 的浏览器请求只接受内嵌 Tauri/Vite 来源。
- owner token 轮换会更新运行时代次，旧代次发起的慢请求 body 会在读取时被拒绝。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/ping` | 无凭据健康检查 |
| `POST` | `/api/sessions/ssh/saved` | 用已保存连接创建 SSH 会话（凭据在 Rust 内部读取） |
| `POST` | `/api/sessions/ssh/saved/test` | 按连接 ID 测试已保存连接；只返回结果/主机密钥挑战，不返回 secret |
| `POST` | `/api/jumpserver/auth` | JumpServer 密码登录 |
| `POST` | `/api/jumpserver/mfa` | JumpServer MFA |
| `POST` | `/api/jumpserver/token-auth` | JumpServer API token 登录 |
| `GET` | `/api/jumpserver/assets` | 资产列表 |
| `GET` | `/api/jumpserver/nodes` | 节点树 |
| `GET` | `/api/jumpserver/accounts` | 资产账号 |
| `POST` | `/api/jumpserver/test` | 测试 JumpServer 连接 |
| `POST` | `/api/jumpserver/ssh-session` | Rust 创建并消费 Koko 连接凭据，打开 SSH 会话 |
| `POST` | `/api/sessions/:id/refresh-sftp` | 为会话已绑定的 JumpServer 目标创建新凭据并重建 SFTP；body 不接受 username/password/目标 |

本机 shell 会话、会话列表/删除、终端读写、文件与传输都走 Tauri 命令，不经过 HTTP。

### 保存连接的凭据来源

`SavedConnection` 用两个独立布尔字段明确 key 的来源：`has_key_path` 与
`uses_desktop_key_ladder`。后者表示明确授权使用本机 ssh-agent 或默认 `~/.ssh/id_*` 查找链；
“key 内容为空”绝不能隐式获得这项能力。旧数据缺少该字段时按 `false` 处理，因此缺失 inline
PEM 会失败关闭。

| `auth_method` | `has_key_path` | `uses_desktop_key_ladder` | 必须存在的凭据 | 禁止的认证材料 |
|---|---:|---:|---|---|
| `password` | `false` | `false` | 非空 password | PEM、key path、passphrase |
| `key`（inline） | `false` | `false` | 非空 private-key PEM；可选 passphrase | password、key path |
| `key`（本机路径） | `true` | `false` | 非空 key path；可选 passphrase | password、PEM |
| `key`（本机查找链） | `false` | `true` | 无；由 ssh-agent/默认 key 查找链执行 | password、PEM、key path、passphrase |

`has_key_path=true` 与 `uses_desktop_key_ladder=true` 的组合无效；password 认证的任一来源标志
为 `true` 也无效。

### SSH 会话创建与稳定错误

`POST /api/sessions/ssh/saved` 先完成 SSH 握手、认证与 channel 初始化，再登记并发布 session。
失败或请求中途取消不会留下可发现会话；后台 SFTP 初始化不阻断已经可用的终端会话。

服务端只在本机日志记录原始错误，网络响应使用稳定 code：

- `201`：SSH 连接成功，会话已登记。
- `404`：`connection_not_found`，saved 连接不存在或已删除。
- `409`：`host_key_unknown` 或 `host_key_mismatch`，主机密钥需确认；challenge 只包含
  `error`、`hostname`、`fingerprint`、`key_type`。
- `422`：`credential_unavailable`，来源/绑定无效，或该连接所需凭据不可用。
- `500`：`credential_load_failed`，凭据库读取失败。
- `504`：`credential_load_timeout`，凭据库在时限内未能完成读取。
- `502`：`ssh_auth_failed`，上游 SSH 认证失败。
- `502`：`ssh_connect_failed`，其它上游 SSH 建连失败。
- `504`：`ssh_connect_timeout`，SSH 连接在时限内未完成。

`/test` 接口成功时返回 `200 {"ok":true}`；未知或不匹配的主机密钥仍以 `200` 返回经过筛选的
challenge。其它失败使用上表对应的 HTTP 状态，并返回 `{"ok":false,"error":"<stable_code>"}`。

后台 SFTP 初始化失败也不会透传底层诊断：终端通道的 `MSG_ERROR` 使用
`code=SFTP_NOT_AVAILABLE` 与固定 `message=sftp_init_failed`，原始错误只写入本机日志。
