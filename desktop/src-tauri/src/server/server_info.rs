//! Server info handler — mirrors Go `api/server_info.go`.
//!
//! For SSH sessions: runs sysinfo/process scripts via SSH exec channel.
//! For local sessions: returns local system info via sysinfo crate.

use std::sync::Arc;

use super::protocol;
use super::session::Session;
use super::terminal::ssh;

/// Cross-platform sysinfo shell script (matches Go's sysinfoScript).
const SYSINFO_SCRIPT: &str = r#"
echo "HOSTNAME=$(hostname 2>/dev/null || echo unknown)"
echo "OS_TYPE=$(uname -s 2>/dev/null || echo unknown)"
echo "KERNEL=$(uname -r 2>/dev/null || echo unknown)"
echo "ARCH=$(uname -m 2>/dev/null || echo unknown)"
if [ -f /etc/os-release ]; then . /etc/os-release 2>/dev/null; echo "OS_NAME=$PRETTY_NAME"; elif command -v sw_vers >/dev/null 2>&1; then echo "OS_NAME=$(sw_vers -productName 2>/dev/null) $(sw_vers -productVersion 2>/dev/null)"; else echo "OS_NAME=$(uname -s 2>/dev/null)"; fi
echo "CPU_CORES=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1)"
cm=$(grep 'model name' /proc/cpuinfo 2>/dev/null | head -1 | sed 's/.*: //'); [ -z "$cm" ] && cm=$(sysctl -n machdep.cpu.brand_string 2>/dev/null); [ -z "$cm" ] && cm="unknown"; echo "CPU_MODEL=$cm"
if [ -f /proc/stat ]; then c1=$(awk '/^cpu /{print $2,$3,$4,$5,$6,$7,$8}' /proc/stat); sleep 1; c2=$(awk '/^cpu /{print $2,$3,$4,$5,$6,$7,$8}' /proc/stat); echo "$c1" "$c2" | awk '{u1=$1+$3;t1=$1+$2+$3+$4+$5+$6+$7;u2=$8+$10;t2=$8+$9+$10+$11+$12+$13+$14;dt=t2-t1;if(dt>0)printf "CPU_USAGE=%.1f\n",(u2-u1)/dt*100;else print "CPU_USAGE=0"}'; elif command -v top >/dev/null 2>&1; then top -l1 -n0 -s0 2>/dev/null | awk '/CPU usage/{gsub(/%/,"",$7);printf "CPU_USAGE=%.1f\n",100-$7}'; else echo "CPU_USAGE=0"; fi
if [ -f /proc/meminfo ]; then awk '/^MemTotal:/{t=$2}/^MemAvailable:/{a=$2}/^MemFree:/{f=$2}/^Buffers:/{b=$2}/^Cached:/{c=$2}END{if(a>0){u=t-a}else{u=t-f-b-c};printf "MEM_TOTAL=%.0f\nMEM_USED=%.0f\n",t*1024,u*1024}' /proc/meminfo; elif command -v sysctl >/dev/null 2>&1; then t=$(sysctl -n hw.memsize 2>/dev/null||echo 0);echo "MEM_TOTAL=$t";p=$(vm_stat 2>/dev/null|awk '/Pages active/{a=$3}/Pages wired/{w=$3}/Pages occupied by compressor/{c=$3}END{gsub(/\./,"",a);gsub(/\./,"",w);gsub(/\./,"",c);printf "%.0f\n",(a+w+c)*4096}');echo "MEM_USED=${p:-0}"; fi
if [ -f /proc/meminfo ]; then awk '/^SwapTotal:/{t=$2}/^SwapFree:/{f=$2}END{printf "SWAP_TOTAL=%.0f\nSWAP_USED=%.0f\n",t*1024,(t-f)*1024}' /proc/meminfo; elif command -v sysctl >/dev/null 2>&1; then sysctl -n vm.swapusage 2>/dev/null | awk '{t="";u="";for(i=1;i<=NF;i++){if($i=="total")t=$(i+2);if($i=="used")u=$(i+2)};sub(/M$/,"",t);sub(/M$/,"",u);if(t!="")printf "SWAP_TOTAL=%.0f\nSWAP_USED=%.0f\n",t*1048576,u*1048576}'; fi
if [ -f /proc/loadavg ]; then echo "LOADAVG=$(awk '{printf "%s|%s|%s",$1,$2,$3}' /proc/loadavg)"; elif command -v sysctl >/dev/null 2>&1; then echo "LOADAVG=$(sysctl -n vm.loadavg 2>/dev/null | sed 's/[{}]//g' | awk '{printf "%s|%s|%s",$1,$2,$3}')"; fi
df -kP 2>/dev/null | awk 'NR>1 && $1 ~ /^\// {printf "DISK=%s|%.0f|%.0f|%.0f\n",$6,$2*1024,$3*1024,$4*1024}'
if [ -f /proc/net/dev ]; then awk '/^ *[a-z]/ && !/^ *lo:/ {gsub(/:/, " "); printf "NET=%s|%.0f|%.0f\n",$1,$2,$10}' /proc/net/dev 2>/dev/null; fi
if [ -f /proc/uptime ]; then echo "UPTIME_SECS=$(cut -d. -f1 /proc/uptime 2>/dev/null)"; elif command -v sysctl >/dev/null 2>&1; then bt=$(sysctl -n kern.boottime 2>/dev/null|sed 's/.*sec = \([0-9]*\).*/\1/');now=$(date +%s);echo "UPTIME_SECS=$((now-bt))"; else echo "UPTIME_SECS=0"; fi
"#;

/// Process list command — raw rows only; the self/transient filtering lives in
/// `parse_process_output` where it can be unit tested.
///
/// Two fixes over the inherited Go shape:
///
/// 1. The old tail was `| head -30 || ps … -r | tail -n +2 | head -30`. That
///    fallback was dead code — a pipeline's exit status is its LAST command's,
///    and `head` always exits 0, so the first `ps` failing never reached it. A
///    BusyBox host (Alpine/containers: no `--sort`, no BSD `-r`) silently got an
///    empty list. Probing with `if` asks `ps` directly, so the portable branch
///    actually runs.
/// 2. `head -30` moved to `head -40`: the two guard filters in
///    `parse_process_output` drop a few rows, and the box should still get 30.
const PROCESS_LIST_CMD: &str = r#"if ps -eo pid,user,%cpu,%mem,etime,comm --sort=-%cpu --no-headers >/dev/null 2>&1; then ps -eo pid,user,%cpu,%mem,etime,comm --sort=-%cpu --no-headers 2>/dev/null; else ps aux 2>/dev/null | awk 'NR>1 {c=$11; sub(/.*\//,"",c); printf "%s %s %s %s - %s\n", $2, $1, $3, $4, c}'; fi | head -40"#;

/// Names this very poll spawns itself — see `parse_process_output`.
const SELF_SPAWNED_NAMES: [&str; 3] = ["ps", "awk", "head"];

/// Rows kept for the panel's process box (after filtering).
const PROCESS_ROW_LIMIT: usize = 30;

/// Handle MsgServerInfo request. Returns the response as a protocol message.
pub async fn handle_server_info(session: &Session, payload: &[u8]) -> Vec<u8> {
    // Parse request type
    let req_type = serde_json::from_slice::<serde_json::Value>(payload)
        .ok()
        .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(String::from))
        .unwrap_or_else(|| "sysinfo".to_string());

    let exec_type = session.executor_type.lock().unwrap().clone();
    if exec_type != "ssh" {
        // A JumpServer session is a real SSH connection, but to Koko, and Koko
        // never granted us an exec channel (the file browser multiplexes an SFTP
        // subsystem on the authenticated connection instead). Answering with
        // handle_local_server_info() here would label THIS machine's hostname and
        // OS as the remote asset's — say so instead.
        if exec_type == "jumpserver" {
            let err = serde_json::json!({
                "type": "error",
                "code": "SERVER_INFO_UNSUPPORTED",
                "message": "server info is not available over a JumpServer session",
            });
            return protocol::encode_message(
                protocol::MSG_SERVER_INFO,
                serde_json::to_vec(&err).unwrap_or_default().as_slice(),
            );
        }
        // Local session — return local info
        return handle_local_server_info(&req_type);
    }

    // SSH session — run commands via exec channel
    let handle_guard = session.ssh_exec_handle.lock().await;
    let handle = match handle_guard.as_ref() {
        Some(h) => h,
        None => {
            let err = serde_json::json!({"type": "error", "code": "SSH_NOT_AVAILABLE", "message": "SSH exec not available"});
            return protocol::encode_message(
                protocol::MSG_SERVER_INFO,
                serde_json::to_vec(&err).unwrap_or_default().as_slice(),
            );
        }
    };

    // Downcast to the actual type
    let ssh_handle = match handle
        .downcast_ref::<Arc<tokio::sync::Mutex<Option<russh::client::Handle<ssh::SshHandler>>>>>()
    {
        Some(h) => h,
        None => {
            let err = serde_json::json!({"type": "error", "code": "INTERNAL", "message": "invalid SSH handle type"});
            return protocol::encode_message(
                protocol::MSG_SERVER_INFO,
                serde_json::to_vec(&err).unwrap_or_default().as_slice(),
            );
        }
    };

    match req_type.as_str() {
        "processes" => match ssh::ssh_exec(ssh_handle, PROCESS_LIST_CMD, 5).await {
            Ok(output) => {
                let processes = parse_process_output(&output);
                let resp = serde_json::json!({"type": "processes", "processes": processes});
                protocol::encode_message(
                    protocol::MSG_SERVER_INFO,
                    serde_json::to_vec(&resp).unwrap_or_default().as_slice(),
                )
            }
            Err(e) => {
                let err = serde_json::json!({"type": "error", "code": "EXEC_FAILED", "message": e});
                protocol::encode_message(
                    protocol::MSG_SERVER_INFO,
                    serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                )
            }
        },
        _ => {
            // sysinfo
            match ssh::ssh_exec(ssh_handle, SYSINFO_SCRIPT, 10).await {
                Ok(output) => {
                    let info = parse_sysinfo_output(&output);
                    protocol::encode_message(
                        protocol::MSG_SERVER_INFO,
                        serde_json::to_vec(&info).unwrap_or_default().as_slice(),
                    )
                }
                Err(e) => {
                    let err =
                        serde_json::json!({"type": "error", "code": "EXEC_FAILED", "message": e});
                    protocol::encode_message(
                        protocol::MSG_SERVER_INFO,
                        serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                    )
                }
            }
        }
    }
}

fn handle_local_server_info(req_type: &str) -> Vec<u8> {
    let resp = serde_json::json!({
        "type": req_type,
        "hostname": hostname::get().map(|h| h.to_string_lossy().to_string()).unwrap_or_default(),
        "os_type": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    });
    protocol::encode_message(
        protocol::MSG_SERVER_INFO,
        serde_json::to_vec(&resp).unwrap_or_default().as_slice(),
    )
}

/// Parse sysinfo script output (key=value lines) — matches Go parseSysinfoOutput.
fn parse_sysinfo_output(output: &str) -> serde_json::Value {
    let mut info = serde_json::json!({"type": "sysinfo"});
    let mut disks = Vec::new();
    let mut net_ifaces = Vec::new();

    for line in output.lines() {
        let line = line.trim();
        let Some(idx) = line.find('=') else { continue };
        let key = &line[..idx];
        let val = &line[idx + 1..];
        match key {
            "HOSTNAME" => {
                info["hostname"] = val.into();
            }
            "OS_TYPE" => {
                info["os_type"] = val.into();
            }
            "OS_NAME" => {
                info["os_name"] = val.into();
            }
            "KERNEL" => {
                info["kernel"] = val.into();
            }
            "ARCH" => {
                info["arch"] = val.into();
            }
            "CPU_CORES" => {
                info["cpu_cores"] = val.parse::<i64>().unwrap_or(1).into();
            }
            "CPU_MODEL" => {
                info["cpu_model"] = val.into();
            }
            "CPU_USAGE" => {
                info["cpu_usage"] = val.parse::<f64>().unwrap_or(0.0).into();
            }
            "MEM_TOTAL" => {
                info["mem_total"] = val.parse::<i64>().unwrap_or(0).into();
            }
            "MEM_USED" => {
                info["mem_used"] = val.parse::<i64>().unwrap_or(0).into();
            }
            "SWAP_TOTAL" => {
                info["swap_total"] = val.parse::<i64>().unwrap_or(0).into();
            }
            "SWAP_USED" => {
                info["swap_used"] = val.parse::<i64>().unwrap_or(0).into();
            }
            "LOADAVG" => {
                // 1/5/15-minute load averages, pipe-separated.
                let loads: Vec<f64> = val
                    .split('|')
                    .filter_map(|v| v.trim().parse::<f64>().ok())
                    .collect();
                if !loads.is_empty() {
                    info["load_avg"] = loads.into();
                }
            }
            "UPTIME_SECS" => {
                info["uptime_seconds"] = val.parse::<i64>().unwrap_or(0).into();
            }
            "DISK" => {
                let parts: Vec<&str> = val.splitn(4, '|').collect();
                if parts.len() == 4 {
                    disks.push(serde_json::json!({
                        "mount": parts[0],
                        "total": parts[1].parse::<i64>().unwrap_or(0),
                        "used": parts[2].parse::<i64>().unwrap_or(0),
                        "available": parts[3].parse::<i64>().unwrap_or(0),
                    }));
                }
            }
            "NET" => {
                let parts: Vec<&str> = val.splitn(3, '|').collect();
                if parts.len() == 3 {
                    net_ifaces.push(serde_json::json!({
                        "name": parts[0],
                        "rx_bytes": parts[1].parse::<i64>().unwrap_or(0),
                        "tx_bytes": parts[2].parse::<i64>().unwrap_or(0),
                    }));
                }
            }
            _ => {}
        }
    }

    info["disks"] = disks.into();
    info["net_ifaces"] = net_ifaces.into();
    info
}

/// `ps -o etime` renders an age under one second as `00:00` (some builds emit
/// `0:00`) — i.e. "this process was born for the snapshot", which is exactly the
/// set whose `%CPU` is meaningless. Covers the shell running the pipeline, whose
/// name we cannot filter without hiding real long-running shells.
fn is_sub_second_age(etime: &str) -> bool {
    matches!(etime, "00:00" | "0:00")
}

/// Parse process list output — matches Go parseProcessOutput, plus a guard that
/// drops the poll's own processes.
///
/// `ps` reports `%CPU` as (utime+stime)/elapsed, so a process that has been alive
/// for a few milliseconds scores whatever fraction of that time it burned. This
/// poll spawns `ps` (which scans every /proc entry), `awk` and `head`, and the
/// shell running the pipeline: all of them are born milliseconds before the
/// snapshot, so they scored ~100% and — with `--sort=-%cpu` — took the top of the
/// list. The panel showed a red `ps 100.0` every 5s poll. A sub-second `etime`
/// (`00:00`) is the same artifact for any process, and the three helper names are
/// dropped by name too, because the BusyBox fallback has no usable `etime` and
/// reports `-`.
fn parse_process_output(output: &str) -> Vec<serde_json::Value> {
    output
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 6 {
                return None;
            }
            // Deliberate tradeoff: a genuinely long-running `ps`/`awk`/`head` is
            // hidden too. They are transient helpers in practice, and a visible
            // false 100% costs the panel far more credibility than a hidden one.
            if is_sub_second_age(fields[4]) || SELF_SPAWNED_NAMES.contains(&fields[5]) {
                return None;
            }
            Some(serde_json::json!({
                "pid": fields[0].parse::<i32>().unwrap_or(0),
                "user": fields[1],
                "cpu": fields[2].parse::<f64>().unwrap_or(0.0),
                "mem": fields[3].parse::<f64>().unwrap_or(0.0),
                "time": fields[4],
                "command": fields[5..].join(" "),
            }))
        })
        .take(PROCESS_ROW_LIMIT)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 面板每 5s 轮询一次「进程」，若不排除自身，`ps` 会以约 100% 假 CPU 稳居第一行
    /// （截图里的红色 `ps 100.0`）。这三行就是那次轮询自己 spawn 的 ps/awk/head。
    #[test]
    fn parse_process_output_drops_the_polls_own_helpers() {
        let out = "\
  1234 root 100.0  0.0 00:00 ps\n\
  1235 root  40.0  0.0 00:00 awk\n\
  1236 root  20.0  0.0 00:00 head\n";
        assert!(
            parse_process_output(out).is_empty(),
            "轮询自身 spawn 的 ps/awk/head 不得进入面板"
        );
    }

    /// 名字黑名单优先于时长：跑了 10 分钟的 `ps` 也照样丢掉。
    /// 这是刻意的取舍（真·长跑 ps/awk 被一起藏掉），在此固化契约。
    #[test]
    fn parse_process_output_drops_even_a_long_running_ps() {
        let out = "  1234 root 99.0  0.0 10:23 ps\n";
        assert!(
            parse_process_output(out).is_empty(),
            "ps 按名字过滤，与 etime 长短无关"
        );
    }

    /// 跑这条命令的父 shell 不能进名字黑名单（那会连真实的忙 shell 一起藏掉），
    /// 它靠「不足 1 秒的 etime」被滤掉；两种零填充写法都要认。
    #[test]
    fn parse_process_output_drops_sub_second_helpers_by_age_not_by_name() {
        let out = "\
  1234 root 60.0  0.0 00:00 bash\n\
  1235 root 30.0  0.0  0:00 sh\n\
  1236 root  0.1  0.2 00:01 bash\n";
        let rows = parse_process_output(out);
        assert_eq!(rows.len(), 1, "只该留下活过 1 秒的那个 bash");
        assert_eq!(rows[0]["command"], "bash");
        assert_eq!(rows[0]["time"], "00:01");
    }

    /// 真实进程要完整留下，且列映射不能错位（comm 含空格时 command 须保留全名）。
    #[test]
    fn parse_process_output_keeps_real_processes_with_correct_columns() {
        let out = "\
  900 root 12.5  3.2 01:02:03 nginx: worker\n\
  901 www   0.0  0.5 00:20 bash\n";
        let rows = parse_process_output(out);
        assert_eq!(rows.len(), 2, "真实进程不得被过滤");
        assert_eq!(rows[0]["pid"], 900);
        assert_eq!(rows[0]["cpu"], 12.5);
        assert_eq!(rows[0]["mem"], 3.2);
        assert_eq!(rows[0]["time"], "01:02:03");
        assert_eq!(rows[0]["command"], "nginx: worker");
        assert_eq!(rows[1]["command"], "bash");
    }

    /// BusyBox/Alpine 回退分支没有 etime（占位 `-`），不能因此被当成瞬时进程丢掉。
    #[test]
    fn parse_process_output_accepts_busybox_fallback_rows() {
        let out = "     42 root  3.0  1.0 - nginx\n";
        let rows = parse_process_output(out);
        assert_eq!(rows.len(), 1, "回退格式（etime=-）须被接受");
        assert_eq!(rows[0]["command"], "nginx");
        assert_eq!(rows[0]["time"], "-");
    }

    /// 面板只展示 30 行；命令侧多取 10 行（head -40）供过滤后仍凑满。
    #[test]
    fn parse_process_output_caps_rows_at_the_panel_limit() {
        let out: String = (0..45)
            .map(|i| format!("  {} root 0.1 0.1 10:00 svc{}\n", 1000 + i, i))
            .collect();
        assert_eq!(parse_process_output(&out).len(), PROCESS_ROW_LIMIT);
    }

    /// 命令形状守卫：`||` 回退是死代码（管道退出码取 head 的 0，永远走不到），
    /// 必须用 `if` 直接问 `ps`；多取到 40 行。
    #[test]
    fn process_list_cmd_probes_ps_instead_of_piping_a_dead_fallback() {
        assert!(
            PROCESS_LIST_CMD.starts_with("if ps "),
            "须用 if 探测 ps 能力，不能靠管道 || 回退"
        );
        assert!(
            PROCESS_LIST_CMD.contains(" else "),
            "BusyBox 回退分支须保留"
        );
        assert!(
            !PROCESS_LIST_CMD.contains("||"),
            "管道 || 回退是死代码：退出码取自 head，恒为 0"
        );
        assert!(
            PROCESS_LIST_CMD.trim_end().ends_with("head -40"),
            "过滤会吃掉几行，命令侧须多取"
        );
    }
}
