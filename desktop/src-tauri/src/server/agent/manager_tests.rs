//! `manager.rs` 的单元测试(经 `#[path]` 挂为 `manager` 的子模块 `tests`)。
//!
//! 抽到 sibling 文件是为把 `manager.rs` 主体控制在 1000 行以内(项目规范):`use super::*`
//! 令 `super` = `manager` 模块,子模块可访问其私有项(`AgentHistory`/`attach_client`/…)。

use super::*; // EventBus / DesktopEvent 经此引入(manager 顶层已 use)。
use crate::server::hook_secret::HookSecretRegistry;
use crate::server::session::client::{Client, WsReceivers};
use crate::server::session::state::ClientRole;
use crate::server::session::{Session, SessionConfig};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

// ── AgentHistory ──

/// push 超上限从最旧丢弃;frames_from 顺序 = 入队顺序;bytes 计数正确;pushed 单调计数。
#[test]
fn history_evicts_oldest_over_max_and_keeps_order() {
    // 上限 10 字节;每帧 4 字节 → 至多容 2 帧(8B),第 3 帧入队后应丢掉第 1 帧。
    let mut h = AgentHistory::with_max_bytes(10);
    h.push(b"aaaa".to_vec());
    h.push(b"bbbb".to_vec());
    assert_eq!(h.frames.len(), 2);
    assert_eq!(h.bytes, 8);

    h.push(b"cccc".to_vec()); // 12 > 10 → 丢最旧 "aaaa" → 剩 bbbb,cccc(8B)
    let snap = h.frames_from(0);
    assert_eq!(
        snap,
        vec![b"bbbb".to_vec(), b"cccc".to_vec()],
        "应丢最旧、保序"
    );
    assert_eq!(h.bytes, 8);
    assert_eq!(h.pushed, 3, "pushed 计所有入队(含已淘汰),单调不回退");
}

/// 单帧就超上限:仍保留该(最新)帧,不至于历史凭空清空。
#[test]
fn history_keeps_single_oversized_frame() {
    let mut h = AgentHistory::with_max_bytes(4);
    h.push(vec![0u8; 100]);
    assert_eq!(h.frames.len(), 1, "最新一帧即使单帧超限也保留");
    assert_eq!(h.bytes, 100);
}

/// frames_from(seq):返回全局序号 ≥ seq 的在缓冲帧后缀;≥ pushed 返回空;pushed 计所有入队。
#[test]
fn frames_from_returns_suffix_and_pushed_counts_all() {
    let mut h = AgentHistory::with_max_bytes(1024);
    for i in 0..5u8 {
        h.push(vec![i]); // 5 帧,全局序号 0..5
    }
    assert_eq!(h.pushed, 5);
    assert_eq!(
        h.frames_from(0),
        vec![vec![0], vec![1], vec![2], vec![3], vec![4]]
    );
    assert_eq!(h.frames_from(3), vec![vec![3], vec![4]], "从序号3起的后缀");
    assert!(h.frames_from(5).is_empty(), "序号 ≥ pushed 无帧");
}

/// 淘汰后 frames_from 对已淘汰段落 saturating 到最旧在缓冲帧(gap,与 2 MiB 截断取舍一致)。
#[test]
fn frames_from_saturates_over_evicted_prefix() {
    let mut h = AgentHistory::with_max_bytes(8); // 每帧 4B → 至多容 2 帧
    h.push(b"aaaa".to_vec()); // seq 0
    h.push(b"bbbb".to_vec()); // seq 1
    h.push(b"cccc".to_vec()); // seq 2 → 淘汰 seq0(aaaa),剩 bbbb(1)、cccc(2)
    assert_eq!(h.pushed, 3);
    // 请求已淘汰的 seq0 → saturating 到最旧在缓冲(seq1)。
    assert_eq!(
        h.frames_from(0),
        vec![b"bbbb".to_vec(), b"cccc".to_vec()],
        "已淘汰前缀 saturating 到最旧在缓冲帧"
    );
    assert_eq!(h.frames_from(2), vec![b"cccc".to_vec()]);
}

// ── encode_agent_event ──

/// AssistantDelta → `[0x50][JSON]`,payload 解析回等价 event(type + text)。
#[test]
fn encode_agent_event_prefixes_0x50_and_roundtrips_payload() {
    let ev = AgentEvent::AssistantDelta {
        text: "你好".into(),
    };
    let frame = encode_agent_event(&ev);
    assert_eq!(frame[0], protocol::MSG_AGENT_EVENT);
    assert_eq!(frame[0], 0x50);

    let v: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
    assert_eq!(v.get("type").unwrap(), "assistant_delta");
    assert_eq!(v.get("text").unwrap(), "你好");
}

// ── fan-out(真实 Session + 真实 Client 通道)──

fn test_session() -> Arc<Session> {
    let config = SessionConfig {
        session_ttl: Duration::from_secs(300),
        reconnect_grace: Duration::from_secs(60),
        ring_buffer_size: 4096,
        log_dir: String::new(),
    };
    Arc::new(Session::new(
        "test-agent-session".into(),
        config,
        EventBus::new(),
    ))
}

/// 建一个真实 Client(带 mpsc 通道)并加入 session,返回 Client + 其接收端。
/// 模拟 handle_ws 步骤2:client 已进 `session.clients` 且 connected,但**尚未 attach**。
fn attached_client(session: &Session, id: &str) -> (Arc<Client>, WsReceivers) {
    let (client, rx) = Client::new(
        id.into(),
        "127.0.0.1".into(),
        ClientRole::Viewer,
        crate::server::session::client::ClientSecurityContext::direct_loopback_owner(),
    );
    let client = Arc::new(client);
    session.add_client(client.clone()).unwrap();
    (client, rx)
}

/// 排空一个 client 的 priority 接收端为帧序列(按到达顺序)。
fn drain(rx: &mut mpsc::Receiver<Vec<u8>>) -> Vec<Vec<u8>> {
    std::iter::from_fn(|| rx.try_recv().ok()).collect()
}

/// 某帧在序列中出现的次数(断言「精确一次」用)。
fn count_of(frames: &[Vec<u8>], target: &[u8]) -> usize {
    frames.iter().filter(|f| f.as_slice() == target).count()
}

/// 测试专用:构造一个不带 fan-out 任务的表条目,供表增删断言。
fn test_entry() -> Arc<AgentEntry> {
    Arc::new(AgentEntry {
        fan: Arc::new(Mutex::new(FanState::new())),
        task: Mutex::new(None),
    })
}

// ── P1-T6:fan-out 额外副作用——通知性事件 publish 到桌面事件总线 ──

/// fan_out_one 处理通知性 agent 事件时,除照常帧下行外还向 `EventBus` publish 对应
/// `DesktopEvent`:`TurnComplete` → `AgentTurnDone`(带 session_id/session_title)、
/// `PermissionRequest{title}` → `AgentNeedsApproval`(title 透传);普通事件(AssistantDelta)
/// 不 publish 任何 DesktopEvent。
#[test]
fn fan_out_publishes_notification_desktop_events() {
    let session = test_session(); // id = "test-agent-session"
    *session.title.lock().unwrap() = "我的会话".to_string();
    let fan = Arc::new(Mutex::new(FanState::new()));
    let bus = EventBus::new();
    let mut rx = bus.subscribe();

    // 1) TurnComplete → AgentTurnDone(session_id / session_title 对,id 非空)。
    let tc = AgentEvent::TurnComplete {
        stop_reason: Some("end_turn".into()),
    };
    fan_out_one(&fan, &session, &bus, &tc);
    match rx
        .try_recv()
        .expect("TurnComplete 应 publish 一条 DesktopEvent")
    {
        DesktopEvent::AgentTurnDone {
            session_id,
            session_title,
            id,
        } => {
            assert_eq!(session_id, "test-agent-session");
            assert_eq!(session_title, "我的会话");
            assert!(!id.is_empty(), "应生成非空 uuid");
        }
        other => panic!("期望 AgentTurnDone,得到 {:?}", other),
    }

    // 2) PermissionRequest{title} → AgentNeedsApproval 且 title 透传。
    let pr = AgentEvent::PermissionRequest {
        request_id: serde_json::json!(0),
        title: "`ls -la`".into(),
        options: Vec::new(),
    };
    fan_out_one(&fan, &session, &bus, &pr);
    match rx
        .try_recv()
        .expect("PermissionRequest 应 publish 一条 DesktopEvent")
    {
        DesktopEvent::AgentNeedsApproval {
            session_id,
            session_title,
            title,
            ..
        } => {
            assert_eq!(session_id, "test-agent-session");
            assert_eq!(session_title, "我的会话");
            assert_eq!(title, "`ls -la`");
        }
        other => panic!("期望 AgentNeedsApproval,得到 {:?}", other),
    }

    // 3) 普通事件不 publish DesktopEvent(总线无新消息)。
    fan_out_one(
        &fan,
        &session,
        &bus,
        &AgentEvent::AssistantDelta { text: "hi".into() },
    );
    assert!(
        matches!(
            rx.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ),
        "普通 agent 事件不应 publish DesktopEvent"
    );
}

// ── attach 回放 ──

/// 历史有 N 帧 → attach 一个 client,恰好收到这 N 帧、顺序一致,且被登记进 attached。
#[tokio::test]
async fn attach_replays_history_frames_in_order() {
    let session = test_session();
    let (client, rx) = attached_client(&session, "late");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;

    let fan = Arc::new(Mutex::new(FanState::new()));
    let f1 = encode_agent_event(&AgentEvent::AssistantDelta { text: "1".into() });
    let f2 = encode_agent_event(&AgentEvent::AssistantDelta { text: "2".into() });
    let f3 = encode_agent_event(&AgentEvent::ReasoningDelta { text: "3".into() });
    {
        let mut f = fan.lock().unwrap();
        f.history.push(f1.clone());
        f.history.push(f2.clone());
        f.history.push(f3.clone());
    }

    attach_client(&fan, &client).await;

    let got = drain(&mut priority_rx);
    assert_eq!(got, vec![f1, f2, f3], "attach 应按序回放全部历史帧");
    assert!(
        fan.lock().unwrap().attached.contains_key("late"),
        "attach 后 client id 应登记进 attached 集合"
    );
}

/// 【CRITICAL 回归锁定】attach 背压回放:历史帧数**远超 priority 通道容量(1024)**时,
/// 只要有并发 drainer(生产上是 WS 的 writer-before-attach)排空通道,回放就:
/// ① 不把 client disconnect(不再 Full → disconnect);② 不截断——全部 N 帧按序送达;
/// ③ client 仍 connected 且被登记进 attached。
/// 旧实现(持锁、非阻塞 `send` 逐帧灌 1024 槽通道)会在第 1025 帧 Full → `disconnect()` +
/// 静默丢弃 1025..N 帧 → socket close → 手机重连再撞 → 永久重连环 + 历史截断。
#[tokio::test]
async fn attach_backpressure_replays_beyond_channel_capacity_without_disconnect_or_truncation() {
    let session = test_session();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers { priority_rx, .. } = rx;

    // 2000 帧 ≫ PRIORITY_SEND_CHANNEL_SIZE(1024),每帧数十字节仍远在 2 MiB 内(不触发淘汰)。
    const N: usize = 2000;
    let mut expected = Vec::with_capacity(N);
    let fan = Arc::new(Mutex::new(FanState::new()));
    {
        let mut f = fan.lock().unwrap();
        for i in 0..N {
            let frame = encode_agent_event(&AgentEvent::AssistantDelta {
                text: format!("d{i}"),
            });
            expected.push(frame.clone());
            f.history.push(frame);
        }
    }

    // 并发 drainer:模拟 writer-before-attach,在回放 send_async 因通道满而背压等待时排空通道。
    let drainer = tokio::spawn(async move {
        let mut prx = priority_rx;
        let mut got = Vec::with_capacity(N);
        while let Some(frame) = prx.recv().await {
            got.push(frame);
        }
        got
    });

    // 背压回放全部 2000 帧(通道满则等 drainer 排空,不丢、不断连)。
    attach_client(&fan, &client).await;

    // ① 未被 disconnect;③ 已登记进 attached。
    assert!(
        client.is_connected(),
        "背压回放不应 disconnect client(旧实现第 1025 帧 Full → disconnect)"
    );
    assert!(
        fan.lock().unwrap().attached.contains_key("phone"),
        "回放完成后 client 应登记进 attached"
    );

    // 关闭发送端:disconnect 置空 downstream → 丢弃唯一的 priority_tx → drainer recv 到 None 收尾。
    client.disconnect();
    let got = tokio::time::timeout(Duration::from_secs(5), drainer)
        .await
        .expect("drainer 应在通道关闭后结束")
        .expect("drainer 任务不应 panic");

    // ② 不截断:恰好收到全部 N 帧、顺序一致。
    assert_eq!(got.len(), N, "应收到全部 {N} 帧,无截断");
    assert_eq!(got, expected, "回放帧应按入队顺序完整送达");
}

// ── FIX-A:attached-set 门控保证「精确一次 + 有序」──

/// 用例1(暴露旧 bug 的生产时序):client 已在 session.clients、connected,但**尚未 attach**;
/// 一条 live 事件 E 先走 fan_out(旧实现会 broadcast 给已注册的 client)→ 再 attach 回放
/// snapshot(含 E)。断言 client 只收到 E **一次**、且 E 落在早期历史帧之后(有序)。
/// 旧实现此处会收到 2 个 E(broadcast 一次 + 回放一次,且乱序);新实现 1 个。
#[tokio::test]
async fn attach_after_fanout_delivers_event_exactly_once_in_order() {
    let session = test_session();
    let (client, rx) = attached_client(&session, "c1");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;

    let fan = Arc::new(Mutex::new(FanState::new()));
    // 早期历史:c1 连接前就已产生的两帧(此时无人 attach)。
    let early0 = encode_agent_event(&AgentEvent::AssistantDelta {
        text: "early0".into(),
    });
    let early1 = encode_agent_event(&AgentEvent::AssistantDelta {
        text: "early1".into(),
    });
    {
        let mut f = fan.lock().unwrap();
        f.history.push(early0.clone());
        f.history.push(early1.clone());
    }

    // 生产时序:c1 已注册进 session.clients、connected,但尚未 attach → live 事件 E 走 fan_out。
    let e = AgentEvent::AssistantDelta { text: "E".into() };
    let ef = encode_agent_event(&e);
    fan_out_one(&fan, &session, &EventBus::new(), &e);
    // 随后 attach:回放 snapshot(此刻已含 E)。
    attach_client(&fan, &client).await;

    let got = drain(&mut priority_rx);
    assert_eq!(count_of(&got, &ef), 1, "E 应恰好一次(旧实现会 2 次)");
    assert_eq!(
        got,
        vec![early0, early1, ef],
        "应只经回放收到 [early0, early1, E],E 在末尾(有序)"
    );
}

/// 用例2(反向时序):先 attach、再 fan_out(E)。client 已在 attached →
/// E 只经 fan_out 投递一次;attach 的 snapshot 不含 E → 不重复。
#[tokio::test]
async fn fanout_after_attach_delivers_event_exactly_once() {
    let session = test_session();
    let (client, rx) = attached_client(&session, "c1");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;

    let fan = Arc::new(Mutex::new(FanState::new()));
    attach_client(&fan, &client).await; // 空历史,回放 0 帧,登记进 attached

    let e = AgentEvent::AssistantDelta { text: "E".into() };
    let ef = encode_agent_event(&e);
    fan_out_one(&fan, &session, &EventBus::new(), &e);

    let got = drain(&mut priority_rx);
    assert_eq!(got, vec![ef], "E 应恰好一次(经 fan-out)");
}

/// 用例3(两 client:一个已 attach、一个 attach 中):事件 E 在 c2 attach **前** fan_out。
/// c1(已 attach)经 fan_out 收到 E 一次;c2 attach 后经回放收到 E 一次——各自恰好一次。
#[tokio::test]
async fn two_clients_one_attached_one_attaching_each_gets_event_once() {
    let session = test_session();
    let (c1, rx1) = attached_client(&session, "c1");
    let (c2, rx2) = attached_client(&session, "c2");
    let WsReceivers {
        priority_rx: mut prx1,
        ..
    } = rx1;
    let WsReceivers {
        priority_rx: mut prx2,
        ..
    } = rx2;

    let fan = Arc::new(Mutex::new(FanState::new()));
    // c1 已完成 attach(空历史)。
    attach_client(&fan, &c1).await;

    // live 事件 E 在 c2 attach 前 fan_out:c1(attached)收到;c2(未 attach)不收到。
    let e = AgentEvent::AssistantDelta { text: "E".into() };
    let ef = encode_agent_event(&e);
    fan_out_one(&fan, &session, &EventBus::new(), &e);

    // c2 现在 attach:snapshot 含 E → 回放一次。
    attach_client(&fan, &c2).await;

    let got1 = drain(&mut prx1);
    let got2 = drain(&mut prx2);
    assert_eq!(got1, vec![ef.clone()], "c1 经 fan-out 恰收到 E 一次");
    assert_eq!(got2, vec![ef], "c2 经回放恰收到 E 一次");
}

// ── FIX-E:attached 惰性剔除失联 client ──

/// attach 两个 client(A、B 都进 attached);令 B 断开(connected=false、通道关闭)后
/// fan_out 一条事件:事件只投给在场的 A,且 B 的死 id 已从 attached 惰性剔除(只剩 A)。
/// 由此 attached 上界 = 当前在场数,不随历史断开连接单调增长。
#[tokio::test]
async fn fan_out_prunes_disconnected_client_from_attached() {
    let session = test_session();
    let (a, rxa) = attached_client(&session, "A");
    let (b, rxb) = attached_client(&session, "B");
    let WsReceivers {
        priority_rx: mut prxa,
        ..
    } = rxa;
    let WsReceivers {
        priority_rx: mut prxb,
        ..
    } = rxb;

    let fan = Arc::new(Mutex::new(FanState::new()));
    attach_client(&fan, &a).await;
    attach_client(&fan, &b).await;
    assert_eq!(
        fan.lock().unwrap().attached.len(),
        2,
        "两个 client attach 后都应在 attached"
    );

    // B 失联:断开连接(connected=false + downstream 置空,后续 send 直接返回 false)。
    b.disconnect();

    let e = AgentEvent::AssistantDelta { text: "E".into() };
    let ef = encode_agent_event(&e);
    fan_out_one(&fan, &session, &EventBus::new(), &e);

    // 在场的 A 收到 E 一次;断开的 B 收不到。
    assert_eq!(drain(&mut prxa), vec![ef], "在场的 A 应收到事件一次");
    assert!(drain(&mut prxb).is_empty(), "断开的 B 不应收到任何帧");

    // B 的死 id 已从 attached 剔除,只剩 A。
    {
        let f = fan.lock().unwrap();
        assert!(f.attached.contains_key("A"), "在场的 A 仍应留在 attached");
        assert!(!f.attached.contains_key("B"), "断开的 B 应被惰性剔除");
        assert_eq!(f.attached.len(), 1, "attached 应只剩在场的 A");
    }
}

// ── reconnect 竞态锁定(BUG-1 陈旧 attached-id / BUG-2 conn_gen 守卫)──

/// 【BUG-1 回归锁定 · reconnect 陈旧 attached-id 竞态】
/// 场景:同 client_id 掉线又在 grace 内重连,attached 只靠 fan_out 惰性剔除、`reconnect` 不碰它,
/// 故重连前的旧 id 可能残留 attached。**预塞** client.id 进 attached 模拟该残留,再 attach:
/// - 起始 remove(修复):回放期间该 id **不在** attached → 回放中途 fan_out 的 live 事件 E 不被
///   fan_out 并发投递,仅由追赶回放送达一次,历史在前、E 在后(有序)。
/// - 不 remove(旧 bug):该 id 仍在 attached → 回放期间的 assert 直接失败(见下),且 E 会既经
///   fan_out 又经回放各投一次 → 重发 + 乱序。
/// 历史帧数 > 通道容量(1024)以制造背压挂起,得以在「回放进行中」观察不变式并注入 live 事件。
/// current-thread 运行时下用 yield 驱动 attach 跑到背压挂起点,再手动分段排空,时序确定。
#[tokio::test]
async fn attach_removes_stale_attached_id_no_dup_on_reconnect() {
    let session = test_session();
    let (client, rx0) = attached_client(&session, "phone");
    let gen0 = client.conn_gen();
    // 真实拓扑:第一条连接(gen0)上完成过 attach,掉线后 grace 内重连——`reconnect` 换新
    // 通道 + conn_gen bump,新 receivers 归新连接;旧 receivers 随旧连接废弃。
    drop(rx0);
    let WsReceivers {
        mut priority_rx, ..
    } = client
        .reconnect(
            "127.0.0.1:2".into(),
            crate::server::session::client::ClientSecurityContext::direct_loopback_owner(),
        )
        .unwrap();

    let fan = Arc::new(Mutex::new(FanState::new()));
    // 模拟 reconnect 陈旧残留:attached 里是**旧 conn_gen(gen0)**的完成条目
    // (disconnect/reconnect 不清它)。同代幂等守卫不拦更旧代次,BUG-1 起始 remove 应清之。
    fan.lock()
        .unwrap()
        .attached
        .insert("phone".to_string(), gen0);

    // 历史 > 1024 → attach 回放会在通道满时背压挂起,便于观察「回放中」状态并注入 live 事件。
    const N: usize = 1100;
    let mut expected = Vec::with_capacity(N + 1);
    {
        let mut f = fan.lock().unwrap();
        for i in 0..N {
            let frame = encode_agent_event(&AgentEvent::AssistantDelta {
                text: format!("h{i}"),
            });
            expected.push(frame.clone());
            f.history.push(frame);
        }
    }

    let fan2 = fan.clone();
    let client2 = client.clone();
    let attach_task = tokio::spawn(async move { attach_client(&fan2, &client2).await });

    // current-thread:让 attach 跑到背压挂起点(填满 1024 槽后 park)。attach 起始的 remove
    // 是同步的(无 await),故此刻若已 park 则 id 必已被清。
    for _ in 0..64 {
        tokio::task::yield_now().await;
    }

    // 【核心断言】回放进行中,陈旧 id 必须已被起始 remove 清掉——旧实现此处仍含 "phone" → 失败。
    assert!(
        !fan.lock().unwrap().attached.contains_key("phone"),
        "attach 起始应清除陈旧 attached id;回放期间不得在 attached(否则 reconnect 重发/乱序)"
    );

    // 手动分段排空:先拉走前 500 帧(制造空档,让并发的 fan_out 有槽位可投),模拟 writer 排空。
    let mut got: Vec<Vec<u8>> = Vec::with_capacity(N + 1);
    for _ in 0..500 {
        match priority_rx.try_recv() {
            Ok(f) => got.push(f),
            Err(_) => break,
        }
    }

    // 回放进行中(attach 仍 park)注入 live 事件 E:
    // - 修复:id 不在 attached → fan_out 跳过投递;E 仅由追赶回放送达一次(末尾)。
    // - 旧 bug:id 在 attached 且此刻通道有空档 → fan_out 立即投 E(插在回放中间)+ 追赶再投 → 2 次。
    let e = AgentEvent::AssistantDelta { text: "E".into() };
    let ef = encode_agent_event(&e);
    expected.push(ef.clone());
    fan_out_one(&fan, &session, &EventBus::new(), &e);

    // 并发排空剩余,放行背压回放至完成。
    let drainer = tokio::spawn(async move {
        let mut rest = Vec::new();
        while let Ok(Some(f)) =
            tokio::time::timeout(Duration::from_millis(200), priority_rx.recv()).await
        {
            rest.push(f);
        }
        rest
    });
    attach_task.await.unwrap();
    let rest = tokio::time::timeout(Duration::from_secs(5), drainer)
        .await
        .expect("drainer 不应 hang")
        .unwrap();
    got.extend(rest);

    // 每帧恰一次:E 只出现一次(旧实现会 2 次);历史在前、E 在末尾(有序);总数 = N + 1(无重发/截断)。
    assert_eq!(count_of(&got, &ef), 1, "live E 应恰好一次(旧实现会 2 次)");
    assert_eq!(got.len(), N + 1, "应收到全部历史 + 1 live,共 {} 帧", N + 1);
    assert_eq!(got, expected, "历史帧在前、E 在末尾,顺序一致");
    // 回放完成后 id 已重新登记(完成代次 = 当前 conn_gen;此后 live 帧改由 fan_out 投递)。
    assert_eq!(
        fan.lock().unwrap().attached.get("phone"),
        Some(&client.conn_gen()),
        "回放完成后 id 应以当前 conn_gen 重新登记进 attached"
    );
}

/// 【BUG-2 回归锁定 · supersession 无 conn_gen 守卫】
/// 场景:手机 A 弱网连上,handler H1 的 attach 背压挂起;手机抖动携同 client_id 重连
/// (`reconnect` 换新通道 + connected=true + conn_gen bump,新 receivers 交给新 handler H2)。
/// 被顶替的旧 attach(H1)必须在下一个 conn_gen 校验点 abort:**停止发送、不插 attached**——
/// 否则它 `send_async` 重读已换成新通道的 downstream,把陈旧历史帧灌进新连接 → 重发/乱序。
#[tokio::test]
async fn attach_aborts_when_conn_gen_bumps_midway() {
    let session = test_session();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers { priority_rx, .. } = rx;

    let fan = Arc::new(Mutex::new(FanState::new()));
    // 历史 > 1024 → attach 回放背压挂起,给「回放中途 reconnect」留出注入点。
    const N: usize = 1100;
    {
        let mut f = fan.lock().unwrap();
        for i in 0..N {
            f.history
                .push(encode_agent_event(&AgentEvent::AssistantDelta {
                    text: format!("h{i}"),
                }));
        }
    }
    let gen0 = client.conn_gen();

    let fan2 = fan.clone();
    let client2 = client.clone();
    let attach_task = tokio::spawn(async move { attach_client(&fan2, &client2).await });

    // 让 attach 跑到背压挂起(填满通道)。
    for _ in 0..64 {
        tokio::task::yield_now().await;
    }

    // 模拟同 client_id 在回放中途 reconnect:换新通道 + connected=true + conn_gen bump。
    // 旧 attach 任务从此被顶替,必须放弃回放。
    let _new_rx = client
        .reconnect(
            "127.0.0.1:9999".into(),
            crate::server::session::client::ClientSecurityContext::direct_loopback_owner(),
        )
        .unwrap();
    assert_ne!(client.conn_gen(), gen0, "reconnect 应 bump conn_gen");

    // 排空旧通道(drainer 持旧 rx,放行 H1 挂起的 send 完成→下一轮 conn_gen 校验触发 abort)。
    let drainer = tokio::spawn(async move {
        let mut prx = priority_rx;
        while let Ok(Some(_)) = tokio::time::timeout(Duration::from_millis(200), prx.recv()).await {
        }
    });

    // attach 应很快 abort 返回,不 hang。
    tokio::time::timeout(Duration::from_secs(5), attach_task)
        .await
        .expect("attach 应在 conn_gen 变化后 abort,不应 hang")
        .unwrap();

    // 被顶替的旧 attach 不得把 id 插入 attached(新 handler H2 会自行 attach 回放);
    // 且其 in-flight 代次登记已清理,不残留。
    {
        let f = fan.lock().unwrap();
        assert!(
            !f.attached.contains_key("phone"),
            "conn_gen 变化(被 reconnect 顶替)后旧 attach 必须 abort,不得登记 attached"
        );
        assert!(
            f.attach_gen.is_empty(),
            "conn_gen abort 路径退出后 attach_gen 不得残留条目"
        );
    }
    drainer.abort();
}

// ── AgentManager 表操作 ──

/// remove 从表移除;get / len 反映真实增删(用测试插入口塞真 entry)。
#[test]
fn manager_remove_updates_table() {
    let mgr = AgentManager::new();
    assert!(mgr.is_empty());
    // 空表移除安全(no-op → false)。
    assert!(!mgr.remove("nope"));

    // 塞入一个真 entry,断言 get/len 反映插入。
    mgr.insert_for_test("s1", test_entry());
    assert_eq!(mgr.len(), 1);
    assert!(mgr.get("s1").is_some());

    // 移除已存在条目:返回 true,且 get/len 反映移除。
    assert!(mgr.remove("s1"), "移除已存在条目应返回 true");
    assert!(mgr.get("s1").is_none());
    assert_eq!(mgr.len(), 0);
}
