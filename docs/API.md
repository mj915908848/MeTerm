# REST API 参考 / REST API Reference

本文记录当前 Rust 内置服务的安全相关契约。业务帧格式见 `docs/PROTOCOL.md`。

> 分享功能(局域网访问、配对、mDNS 发现、手机中继与推送、自签 TLS)已移除。内置服务只监听
> `127.0.0.1`,并在接受连接时拒绝非 loopback 对端。下文保留的设备凭据与 PoP 说明描述的是
> 仍在代码中的认证框架,当前没有入口可以签发新的设备凭据。

## 认证与传输

- 远程请求必须使用证书指纹固定的 `HTTPS/WSS`。只有进程所在机器的直接 loopback
  连接可继续使用明文 `HTTP/WS`；中继流量不会被当作 loopback。
- `owner token` 只允许直接 loopback 管理请求使用，不能通过 LAN 或中继使用。
- owner token 每次设置/刷新都会轮换运行时代次，旧代次的终端和 presence WebSocket 会立即
  断开；owner 管理写操作会在提交时复验该代次，旧 token 发起的慢请求不能在轮换后重新写回。
  已用新 token 建立的连接与设备连接不受旧代次清理影响。
- 配对成功给每个稳定 `device_id` 签发独立的 `mtd_...` 轮换句柄，并同时绑定配对时验证的
  P-256 公钥。服务端只保存 token 的 SHA-256 摘要与公钥；同一 `device_id` 重新配对会轮换
  token、公钥和运行时代次，并立即断开旧连接。
- 标准 Release 的设备 `supported_scopes` 与默认 scope 均为空；旧文件中的开发授权会在加载时
  被剥离并回写。只有 Debug + `development-mobile-control` feature 可启用移动控制 scope；该
  feature 在 Release profile 下会触发编译错误。此开发包中新配对且绑定 PoP 的设备默认获得
  `desktop.control`、`ssh.desktop-connect`、`ssh.connections-write`、`push.self`，以覆盖完整
  联调链。已经持久化的 v3 设备保留原 scope，v1/v2 迁移也不会静默新增 `desktop.control`；需
  重新配对或由本机 owner 显式授权。
- token 放在 `Authorization: Bearer <token>`；WebSocket 也可用
  `Sec-WebSocket-Protocol: meterm.v1,bearer.<token>`。凭据不得出现在 URL 查询参数中。除
  `/api/auth/challenge` 外，每个设备 HTTP/WSS 请求还必须携带一次性 PoP nonce 与签名；仅复制
  `mtd_` 不能在另一进程或设备上发起请求。
- 配对、`/api/info` 等凭据响应带 `Cache-Control: no-store`。
- 撤销会阻止后续认证并清理已登记长连接；撤销前已通过认证的普通在途 REST/上传请求仍可能
  完成，调用方不能把撤销当作对已经执行副作用的回滚。

## 主要接口

| 权限 | 方法 | 路径 | 说明 |
|---|---|---|---|
| 公开 | `GET` | `/api/ping` | 无凭据健康检查 |
| 设备 bearer bootstrap | `POST` | `/api/auth/challenge` | 签发一个 30 秒、单次、设备代次与 audience 绑定的 PoP nonce |
| 设备（按会话 ACL 过滤） | `GET` | `/api/sessions` | 列出当前设备可访问的会话 |
| 设备（会话 scope + 创建者 ACL） | `GET/DELETE` | `/api/sessions/:id` | 获取/删除会话 |
| 设备（会话 ACL + 当前连接） | `POST` | `/api/sessions/:id/master` | 请求或恢复主控；必须绑定 HELLO 连接代次 |
| `desktop.control` | `POST` | `/api/sessions` | 创建桌面本机 shell/Agent 会话 |
| `ssh.desktop-connect` | `POST` | `/api/sessions/ssh` | 用请求内显式凭据创建 SSH 会话 |
| `ssh.desktop-connect` | `POST` | `/api/sessions/ssh/saved` | 让桌面使用已保存连接（主机密钥只可桌面确认） |
| `ssh.desktop-connect` | `POST` | `/api/sessions/ssh/saved/test` | 按连接 ID 在 Rust 内部测试已保存连接；只返回结果/主机密钥挑战，不返回 secret |
| `ssh.desktop-connect` | `POST` | `/api/sessions/ssh/test` | 测试请求内显式 SSH 连接 |
| `ssh.desktop-connect` | `GET` | `/api/ssh/connections` | 拉取保存连接的非敏感元数据 |
| `ssh.connections-write` | `POST/PUT/DELETE` | `/api/ssh/connections[/:id]` | 写入保存连接及替换 secret |
| 设备 | `DELETE` | `/api/device-credential/self` | 幂等撤销当前设备凭据并清理同代次长连接/推送 |
| 设备 | `GET` | `/ws/:session_id` | 终端 WebSocket |
| owner | `GET` | `/api/device-credentials` | 列出持久设备凭据元数据 |
| owner | `PUT` | `/api/device-credentials/:device_id` | 更新当前构建支持的设备 scope 并断开旧代次 |
| owner | `DELETE` | `/api/device-credentials/:device_id` | 撤销单设备并立即断开 |
| owner | `POST` | `/api/token` | 设置本机 owner token（32–128 位可见 ASCII） |
| owner | `POST` | `/api/token/refresh` | 刷新本机 owner token |
| owner | `POST` | `/api/token/revoke-all` | 撤销所有设备、断开 presence、清推送注册 |
| owner | `POST` | `/api/sessions/:id/refresh-sftp` | Rust 为会话已绑定的 JumpServer 目标创建并消费新凭据；body 不接受 username/password/目标，设备不可调用 |

文件、Git 和本机 Agent 路由属于 `desktop.control`；JumpServer 属于
`ssh.desktop-connect`。无论当前 scope 是否为空，设备 bearer 都应按密码处理，并通过桌面
设置页及时撤销不再使用或疑似被 Hook 的设备。

### 保存连接的凭据来源

`SavedConnection` 用两个独立布尔字段明确 key 的来源：`has_key_path` 与
`uses_desktop_key_ladder`。后者表示桌面 owner 明确授权使用该 Mac 的 ssh-agent 或默认
`~/.ssh/id_*` 查找链；“key 内容为空”绝不能隐式获得这项能力。旧数据缺少该字段时按
`false` 处理，因此缺失 inline PEM 会失败关闭。

| `auth_method` | `has_key_path` | `uses_desktop_key_ladder` | 必须存在的凭据 | 禁止的认证材料 | 可由设备 HTTP 创建/授予 |
|---|---:|---:|---|---|---|
| `password` | `false` | `false` | 非空 password | PEM、key path、passphrase | 是 |
| `key`（inline） | `false` | `false` | 非空 private-key PEM；可选 passphrase | password、key path | 是 |
| `key`（桌面路径） | `true` | `false` | 非空桌面 key path；可选 passphrase | password、PEM | 否 |
| `key`（桌面查找链） | `false` | `true` | 无；由桌面 ssh-agent/默认 key 查找链执行 | password、PEM、key path、passphrase | 否 |

`has_key_path=true` 与 `uses_desktop_key_ladder=true` 的组合无效；password 认证的任一来源标志
为 `true` 也无效。设备调用 raw/test SSH 的 key 认证必须在请求 JSON 内提供 inline PEM，空
key、文件路径、桌面 ssh-agent 与默认 key 查找链都会被拒绝。保存连接按 ID 中转时可以使用
owner 已选择的桌面路径或查找链，因为设备既拿不到凭据，也不能指定路径或改变其 authority。

凭据在 vault 中绑定到 host、port、username、auth method、两个来源标志，以及 proxy type、
host、port、username。设备改变上述任一 authority 字段时，必须在同一事务提供匹配的新
password 或 inline PEM；设备不能创建、重定向或授予桌面路径/查找链连接。仅修改名称等展示
字段不会重绑或清空现有 secret。保存连接的 `trusted_fingerprint` 只能由 owner/桌面本地
提交，设备提交会返回 `403`。SSH session 绑定创建时的 device ID + 凭据 generation，其他
设备及同一设备重配后的新 generation 不继承访问权。

### SSH 会话创建与稳定错误

`POST /api/sessions/ssh` 与 `POST /api/sessions/ssh/saved` 都先完成 SSH 握手、认证与 channel
初始化，再登记并发布 session。失败或请求中途取消不会留下可发现会话，不会触发桌面端失败
标签页；后台 SFTP 初始化不阻断已经可用的终端会话。

SSH 创建/测试接口不会把底层 SSH 库错误、私钥路径、代理细节或其它内部诊断返回给设备。服务端
只在本机日志记录原始错误，网络响应使用稳定 code。创建接口的稳定响应为：

- `201`：SSH 连接成功，会话已登记。
- `400`：`invalid_ssh_config`，raw 请求内 SSH 配置缺失或格式无效。
- `403`：`credential_source_forbidden`，远程设备在 raw 请求中使用了桌面本地 key 来源。
- `403`：`host_key_confirmation_forbidden`，远程设备试图替 saved 连接提交主机密钥信任决定。
- `404`：`connection_not_found`，saved 连接不存在或已删除。
- `409`：`host_key_unknown` 或 `host_key_mismatch`，主机密钥需由桌面本地确认；challenge
  只包含 `error`、`hostname`、`fingerprint`、`key_type`。
- `422`：`credential_unavailable`，来源/绑定无效，或该连接所需凭据不可用。
- `500`：`credential_load_failed`，saved 连接的桌面凭据库读取失败。
- `504`：`credential_load_timeout`，桌面凭据库在服务端时限内未能完成读取；不会继续创建 SSH 会话。
- `502`：`ssh_auth_failed`，上游 SSH 认证失败。
- `502`：`ssh_connect_failed`，其它上游 SSH 建连失败。
- `504`：`ssh_connect_timeout`，SSH 连接在服务端时限内未完成。

两个 `/test` 接口成功时返回 `200 {"ok":true}`；未知或不匹配的主机密钥仍以 `200` 返回经过
筛选的 challenge，且只包含 `error`、`hostname`、`fingerprint`、`key_type`。其它失败使用上表
对应的 HTTP 状态，并返回 `{"ok":false,"error":"<stable_code>"}`，不会回传底层错误文本。

会话建立后的后台 SFTP 初始化失败也不会透传底层诊断：终端 WebSocket 的 `MSG_ERROR` 使用
`code=SFTP_NOT_AVAILABLE` 与固定 `message=sftp_init_failed`，原始 SFTP 错误只写入桌面本机日志。

## 设备 HTTP / WebSocket PoP

设备先通过同一条证书固定的 TLS 连接请求 nonce；这是唯一只需 bearer、不需先有 PoP 的设备
API：

```http
POST /api/auth/challenge
Authorization: Bearer mtd_...
Content-Type: application/json

{"audience":"desktop-http"}
```

`audience` 只能是 `desktop-http` 或 `desktop-ws`。成功响应中的 `nonce` 是 32 字节随机值的无
padding base64url，30 秒到期且最多消费一次。实际请求必须带上原 token，并增加：

```http
X-MeTerm-PoP-Nonce: <nonce>
X-MeTerm-PoP-Signature: <base64url-raw-r||s>
```

签名输入不是 JSON，而是以下有界二进制串：

```text
"MTP1" (4 bytes)
audience (u8: HTTP=1, WebSocket=2)
method_length (u8) || uppercase ASCII method
SHA-256(exact mtd_ token UTF-8) (32 bytes)
nonce (32 bytes)
target_length (u16 big-endian) || exact ASCII origin-form target
```

target 是客户端实际发送的 path 与 query，例如 `/api/info` 或
`/api/files/op?x=%E4%B8%AD`，最多 4096 字节，不含 fragment。服务端先原子消费 nonce，再验证
签名；错误签名不能用同一个 nonce 重试。重复 Authorization、重复 PoP header、多个
`bearer.` WebSocket 子协议或 token/target/audience 不一致均拒绝。

请求 body 没有进入签名输入：它依赖已经固定桌面证书的 TLS 提供完整性。这一设计阻止复制
token 后在另一进程离线重放，但不宣称能抵抗仍控制原 App 进程并实时调用不可导出密钥的 Hook
签名 oracle；此边界见 `docs/SECURITY.md`。

## WebSocket

```text
wss://<desktop>/ws/<session-id>
wss://<desktop>/ws/<session-id>?client_id=<id>
wss://<desktop>/ws/<session-id>?mode=readonly
wss://<desktop>/ws-events?device_id=<authenticated-device-id>
```

`client_id` 只用于连接身份/重连，不是认证凭据；服务端会校验它是否属于当前认证的设备。

终端 WebSocket 建立后，服务端首先发送 `Hello (0x09)`。其 JSON payload 除
`client_id`、`role`、`protocol_version`、`cols`、`rows` 外，还包含非负整数 `conn_gen`。
`client_id` 可以跨重连稳定，`conn_gen` 只代表当前这一次连接；同一客户端重连后，旧代次立即
失效。完整帧和主控审批布局见 `docs/PROTOCOL.md`。

## 主控请求

移动端通过当前终端 WebSocket 的 HELLO 取得 `client_id + conn_gen`，再调用：

```http
POST /api/sessions/<session-id>/master
Content-Type: application/json

{"client_id":"<client-id>","conn_gen":7,"takeover":false}
```

`client_id` 与 `conn_gen` 都是必填项。`takeover=false`（或省略）会把绑定该连接代次的请求转发
给当前 Master 审批；仅在产品允许的恢复流程中使用 `takeover=true` 直接恢复控制。服务端会在
执行时原子复核请求设备身份、凭据代次、会话 ACL、客户端在线状态及连接代次，不接受仅带稳定
`client_id` 的旧协议请求。

- `200`：请求已绑定当前连接并被转发，或允许的直接恢复已经完成。
- `400`：`conn_gen` 缺失或类型无效。
- `403`：设备 scope、会话 ACL 或客户端身份/凭据代次不匹配。
- `404`：会话不存在。
- `409`：客户端已断线、`conn_gen` 已过期，或当前 Master 状态不允许完成请求。

所有缺少代次或代次不匹配的情况都 fail closed；服务端不会回退成按 `client_id` 提升权限。
