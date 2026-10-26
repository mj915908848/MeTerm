# 二进制通信协议 / Binary Protocol

终端与桌面后端之间通过 Tauri IPC 传输二进制帧（下行为 `tauri::ipc::Channel` 原始字节，
上行为 IPC 命令）。分享功能移除后不再有 WebSocket、Relay 或配对握手。

## 帧格式

```
[type: 1 byte][payload: N bytes]
```

## 消息类型

| 消息类型 | Hex | 方向 | 说明 |
|----------|-----|------|------|
| Output | 0x01 | S→C | PTY 输出流 |
| Input | 0x02 | C→S | 键盘输入 |
| Resize | 0x03 | C→S | 终端大小变化 |
| Ping | 0x04 | C→S | 心跳请求 |
| Pong | 0x05 | S→C | 心跳响应 |
| SessionEnd | 0x06 | S→C | 会话结束 |
| Error | 0x07 | S→C | 错误通知 |
| RoleChange | 0x08 | S→C | 角色变更 |
| Hello | 0x09 | S→C | 握手/重连元数据 |
| FileList | 0x0A | C→S | 请求文件列表 |
| FileListResp | 0x0B | S→C | 文件列表响应 |
| FileUploadStart | 0x0C | C→S | 开始上传 |
| FileUploadChunk | 0x0D | C→S | 上传数据块 |
| FileDownloadStart | 0x0E | C→S | 开始下载 |
| FileDownloadChunk | 0x0F | S→C | 下载数据块 |
| FileOperation | 0x10 | C→S | 文件操作（删除/重命名等）|
| FileOperationResp | 0x11 | S→C | 文件操作响应 |
| ServerInfo | 0x12 | C⇄S | 服务器信息 |
| TransferProgress | 0x13 | S→C | 传输进度 |
| UploadResume | 0x14 | C→S | 恢复上传 |
| DownloadResume | 0x15 | C→S | 恢复下载 |
| FileListProgress | 0x16 | S→C | 大目录加载进度 |
| SetEncoding | 0x17 | C→S | 设置终端编码 |
| Nudge | 0x18 | C→S | 请求 PTY SIGWINCH |
| MasterRequest | 0x19 | C→S | 请求成为 Master |
| MasterRequestNotify | 0x1A | S→C | 通知当前 Master |
| MasterApproval | 0x1B | C⇄S | 批准/拒绝请求及结果 |
| MasterReclaim | 0x1C | C→S | Master 收回控制权 |
| MasterRelease | 0x1F | C→S | Master 主动让出控制权 |
| FileDownloadPause | 0x20 | C→S | 暂停下载 |
| FileDownloadContinue | 0x21 | C→S | 恢复已暂停的下载 |
| FileDownloadCancel | 0x22 | C→S | 取消下载 |
| FileReadRequest | 0x30 | C→S | 编辑器读取小文件 |
| FileReadResponse | 0x31 | S→C | 小文件单帧响应 |
| FileSaveRequest | 0x32 | C→S | 编辑器保存小文件 |
| FileSearch | 0x33 | C→S | 递归搜索请求 |
| FileSearchResp | 0x34 | S→C | 流式搜索结果 |

## 小文件读取与消息上限

`FileReadRequest (0x30)` payload 为 JSON：

```json
{"path":"/remote/file","max_bytes":2097152}
```

- `max_bytes` 可选，新客户端必须按实际内存用途传入正整数上限。新服务端取它与服务端上限的较小值；旧服务端会忽略未知字段。
- `FileReadResponse (0x31)` payload 为 `[size:u64 BE][content]`，宣称长度必须与实际内容一致。
- 普通大文件下载必须继续使用 `0x0E/0x0F` 分块协议，不得改用单帧 `0x31`。

## 方向说明

- **S→C**: 服务端发送给客户端
- **C→S**: 客户端发送给服务端
- **C⇄S**: 双向

## 主控连接代次绑定

`Hello (0x09)` payload 是 JSON。`client_id` 是可跨重连复用的逻辑客户端 ID；`conn_gen`
是服务端为该客户端当前这一次连接分配的连接代次：

```json
{
  "client_id": "<client-id>",
  "role": "viewer",
  "protocol_version": 1,
  "cols": 120,
  "rows": 36,
  "conn_gen": 7
}
```

`conn_gen` 是非负整数，每次同一 `client_id` 重连时都会变化。它不是凭据，但所有提升主控权限
的后续请求都必须绑定它；客户端不得仅凭稳定 `client_id` 复用旧请求。

`MasterRequest (0x19)` payload 为空。服务端从发送该帧的当前连接取得代次，并向
当前 Master 发送 `MasterRequestNotify (0x1A)`，其 payload 为：

```json
{"requester_id":"<client-id>","session_id":"<session-id>","conn_gen":7}
```

接收端必须要求 `requester_id`、`session_id` 为字符串，并要求 `conn_gen` 是非负、可精确表示的
整数；字段缺失、类型错误或超出客户端安全整数范围时不得显示审批或发送结果。

`MasterApproval (0x1B)` 在两个方向使用相同 payload：

```text
[approved: u8][requester_conn_gen: u64 big-endian][requester_id: UTF-8]
```

完整线上帧为：

```text
[0x1B][approved: u8][requester_conn_gen: u64 big-endian][requester_id: UTF-8]
```

`approved` 只能取 `0`（拒绝）或 `1`（批准）。服务端只接受当前 Master 的精确连接代次发出的
审批，并在批准时原子复核 `requester_id + requester_conn_gen` 仍对应同一条在线、非只读连接；
审批结果也只投递给该代次。每个业务帧在服务端持有连接表锁、完成精确代次和角色快照时线性化：
重连取得该锁并递增代次前已经合法接收的帧可以按旧权限完成；递增后才进入鉴权的旧代次帧必须
fail closed，且旧帧不能借用相同 `client_id` 新连接后来取得的角色。主控批准、释放和收回还会在
状态提交时原子复核发起者代次与当前 Master/Owner，防止并发换主覆盖。
