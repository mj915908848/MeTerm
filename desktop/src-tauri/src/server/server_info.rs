//! Server info handler — mirrors Go `api/server_info.go`.
//!
//! For SSH sessions: runs sysinfo/process scripts via SSH exec channel.
//! For local sessions: returns local system info via sysinfo crate.

use std::sync::Arc;

use super::protocol;
use super::session::Session;
use super::terminal::ssh;

/// Cross-platform sysinfo shell script (matches Go's sysinfoScript).
///
/// CPU is reported as raw `/proc/stat` counters (`CPU_TICKS`), not as a
/// percentage: computing one inside the script cost a `sleep 1`, which held the
/// SSH exec channel open for a full second on every 5s poll (a ~20% duty cycle,
/// against a 10s timeout). The panel pairs consecutive samples instead — same
/// two-reading idea, one poll interval apart, and a truer number for it.
/// `CPU_USAGE` still comes straight from `top` on hosts without `/proc/stat`.
const SYSINFO_SCRIPT: &str = r#"
echo "HOSTNAME=$(hostname 2>/dev/null || echo unknown)"
echo "OS_TYPE=$(uname -s 2>/dev/null || echo unknown)"
echo "KERNEL=$(uname -r 2>/dev/null || echo unknown)"
echo "ARCH=$(uname -m 2>/dev/null || echo unknown)"
if [ -f /etc/os-release ]; then . /etc/os-release 2>/dev/null; echo "OS_NAME=$PRETTY_NAME"; elif command -v sw_vers >/dev/null 2>&1; then echo "OS_NAME=$(sw_vers -productName 2>/dev/null) $(sw_vers -productVersion 2>/dev/null)"; else echo "OS_NAME=$(uname -s 2>/dev/null)"; fi
echo "CPU_CORES=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1)"
cm=$(grep 'model name' /proc/cpuinfo 2>/dev/null | head -1 | sed 's/.*: //'); [ -z "$cm" ] && cm=$(sysctl -n machdep.cpu.brand_string 2>/dev/null); [ -z "$cm" ] && cm="unknown"; echo "CPU_MODEL=$cm"
if [ -f /proc/stat ]; then awk '/^cpu /{printf "CPU_TICKS=%s %s %s %s %s %s %s\n",$2,$3,$4,$5,$6,$7,$8}' /proc/stat; elif command -v top >/dev/null 2>&1; then top -l1 -n0 -s0 2>/dev/null | awk '/CPU usage/{gsub(/%/,"",$7);printf "CPU_USAGE=%.1f\n",100-$7}'; else echo "CPU_USAGE=0"; fi
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
/// Three fixes over the inherited Go shape:
///
/// 1. The old tail was `| head -30 || ps … -r | tail -n +2 | head -30`. That
///    fallback was dead code — a pipeline's exit status is its LAST command's,
///    and `head` always exits 0, so the first `ps` failing never reached it. A
///    BusyBox host (Alpine/containers: no `--sort`, no BSD `-r`) silently got an
///    empty list.
/// 2. `head -30` moved to `head -40`: the two guard filters in
///    `parse_process_output` drop a few rows, and the box should still get 30.
/// 3. Asking whether `ps` supports `-eo`/`--sort` used to cost a whole second
///    scan: `if ps -eo … >/dev/null; then ps -eo …` runs `ps` twice, and
///    `--sort` means `ps` cannot stream its output — it reads every `/proc`
///    entry before printing anything. Capturing the output first asks the same
///    question for free: an empty capture is exactly the condition the probe was
///    looking for, so the portable branch still runs and the common path pays
///    for one scan instead of two.
/// 4. The portable branch is not an afterthought: it is what every host without
///    GNU `ps` runs — BusyBox, and BSD/macOS, whose `ps` has no `--sort` at all.
///    It used to carry no cap and no ordering, so those hosts got the *entire*
///    process table piped back over SSH (the `.take(30)` in
///    `parse_process_output` runs after the transfer, not before it) and a
///    "top 30" that was really "the first 30 rows". Both now match the common
///    path. The header has to be dropped *before* the sort — `sort -rn` would
///    otherwise leave the `USER PID %CPU …` line in the middle of the list as a
///    bogus row.
/// 5. That fallback was still one command wearing two hosts' assumptions:
///    `ps aux` with `$3` as `%CPU` is the BSD/procps layout, and BusyBox is
///    neither. Its `ps` documents `-o COL1,COL2=HEADER [-T]` and nothing else —
///    the BSD letter cluster is not part of its interface — so on Alpine and in
///    containers `ps aux` fails outright (stderr is dropped, so the branch
///    returned nothing at all and the panel came back empty), and a host whose
///    `ps aux` happens to print *something* would have had that something read
///    through BSD field positions. The three flavours are now told apart by the
///    shape of what came back, not by the command that produced it:
///
///    - GNU `ps -eo … --sort` answers first and is the only scan on the common
///      path; an empty capture is exactly the "not GNU" signal.
///    - `ps aux` rows are accepted only if `$1` is not a number *and* `$2` is,
///      i.e. `USER PID`. A BusyBox-style `PID USER COMMAND` fails that test on
///      every row (`$1` is the pid), and so does a header, so the branch can no
///      longer misread one layout as the other.
///    - With neither available, the list degrades to `ps -o pid,user,comm`, the
///      one spelling all three flavours share. BusyBox cannot supply `%CPU` or
///      `%MEM` at all, so those columns are sent as `-` — see
///      `parse_process_output`, which turns the marker into `null` and the panel
///      into `—`. A list without a ranking is honest; a ranking built from
///      column 3 of a format that does not have one is not.
/// 6. Both fallback branches rebuild `COMMAND` from every remaining field, not
///    from the first one alone. `ps aux` puts the whole command line in the last
///    column, so `$11` cut `nginx: worker` down to `nginx:` — the panel showed a
///    truncated name for every process with an argument. The exchange format has
///    a space-joined command (`parse_process_output` reads `fields[5..]`), so the
///    tail was being dropped on the way in, not on the way out.
/// 7. …and they take the leading directory off **before** joining, not after.
///    `sub(/.*\//,"",c)` is greedy, so running it on the assembled line eats
///    everything up to the last slash *anywhere* in it: `/usr/bin/python
///    /srv/app.py` became `app.py` and `/usr/bin/java -jar /opt/app/app.jar`
///    became `app.jar` — the guard in §6 traded a truncated *argument* for a
///    truncated *name*, on the very commands that carry a path argument. The
///    strip is therefore applied to the first field of the command only, which
///    is the one field `ps` may print as a path; the rest is verbatim.
///    Only the `ps aux` branch can be caught by a test: `comm` (§5's last
///    branch) carries no arguments, so there the two orders are
///    indistinguishable — that branch is aligned for consistency, not because a
///    mutation would show it. The one that is observable is pinned in
///    `tests/process-list-cmd-portability.test.mts` by running the command
///    against a stub `ps`, not by asserting its text.
const PROCESS_LIST_CMD: &str = r#"out=$(ps -eo pid,user,%cpu,%mem,etime,comm --sort=-%cpu --no-headers 2>/dev/null | head -40); if [ -n "$out" ]; then printf '%s\n' "$out"; else bsd=$(ps aux 2>/dev/null | awk 'NR>1 && $1 !~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]/' | sort -k3 -rn | head -40); if [ -n "$bsd" ]; then printf '%s\n' "$bsd" | awk '{c=$11; sub(/.*\//,"",c); for (i=12;i<=NF;i++) c=c" "$i; printf "%s %s %s %s - %s\n", $2, $1, $3, $4, c}'; else ps -o pid,user,comm 2>/dev/null | awk '$1 ~ /^[0-9]+$/ {c=$3; sub(/.*\//,"",c); for (i=4;i<=NF;i++) c=c" "$i; printf "%s %s - - - %s\n", $1, $2, c}' | head -40; fi; fi"#;

/// Names this very poll spawns itself — see `parse_process_output`. `sort` is
/// here for the BSD branch of the fallback, which pipes through it to order by
/// `%CPU`; the degraded branch that BusyBox takes has no `sort` at all, and the
/// name is kept for the flavour that does.
const SELF_SPAWNED_NAMES: [&str; 4] = ["ps", "awk", "head", "sort"];

/// Rows kept for the panel's process box (after filtering).
const PROCESS_ROW_LIMIT: usize = 30;

/// Identifies the host on the other end of the connection, then prints it.
///
/// The desktop's shell-hook injection needs this for the one case it cannot see
/// for itself. Once the user types `ssh other-host`, the screen shows a bare
/// shell prompt that `injectionBlocked()` reads as *ours*, so the hook gets
/// typed into the nested shell and the session is then marked hooked with the
/// other machine's cwd, exit codes and durations — and `hookInjected` is exactly
/// what switches the screen-tail fallbacks off, so the AI features degrade
/// quietly. The screen cannot tell the two shells apart; the **exec channel**
/// can, because it is a second channel on the connection we dialled: whatever it
/// runs, runs on the host we dialled. Compare its answer with the one the shell
/// gives and the nested case identifies itself.
///
/// The value is `machine-id | hostname | boot_id`: stable within a boot,
/// different between machines, joined into one string so that any single field
/// differing is enough to refuse the injection. Every part is optional and
/// stderr is dropped, so a host with none of them still yields a comparable
/// (if degenerate) `||` rather than an error.
///
/// `ai-tools-shell.ts` carries the identical expression as `HOST_IDENTITY_EXPR`,
/// and `tests/shell-hook-identity.test.mts` compares the two files' text —
/// deliberately, because a drift here would not fail loudly: every injection
/// would simply look like a foreign host and refuse, leaving AI features
/// degraded with nothing in the logs. **If you change one, change the other.**
pub(crate) const HOST_IDENTITY_CMD: &str = "__meterm_id=\"$(cat /etc/machine-id 2>/dev/null||cat /var/lib/dbus/machine-id 2>/dev/null)|$(hostname 2>/dev/null)|$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)\"; printf '%s' \"$__meterm_id\"";

/// Ask the connection, rather than the screen, which host is on the other end.
///
/// `None` means "there is nothing to ask" and is **not** an error. A local or
/// JumpServer session has no exec channel at all, and a probe that fails for any
/// other reason degrades to the same answer, so the caller injects unguarded —
/// exactly the behaviour that shipped before this guard existed. An unavailable
/// guard must never become a missing feature.
pub async fn probe_host_identity(session: &Session) -> Option<String> {
    // Only a real SSH session has an exec channel on the dialled connection; a
    // JumpServer session is SSH to Koko, which never granted us one.
    let exec_type = session.executor_type.lock().unwrap().clone();
    if exec_type != "ssh" {
        return None;
    }

    let handle_guard = session.ssh_exec_handle.lock().await;
    let handle = handle_guard.as_ref()?;
    let ssh_handle = handle
        .downcast_ref::<Arc<tokio::sync::Mutex<Option<russh::client::Handle<ssh::SshHandler>>>>>()?;

    let output = ssh::ssh_exec(ssh_handle, HOST_IDENTITY_CMD, 5).await.ok()?;
    let identity = output.trim();
    // An empty capture means the command did not actually run (a shell that
    // refused it, a channel that closed early). Reporting that as an identity
    // would be worse than reporting nothing: the guard would compare the shell
    // against "" and refuse every injection.
    if identity.is_empty() {
        None
    } else {
        Some(identity.to_string())
    }
}

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
            "CPU_TICKS" => {
                // Raw cumulative counters from /proc/stat, in the kernel's own
                // order: user nice system idle iowait irq softirq. The panel
                // subtracts two consecutive samples (see `cpuUsageFromTicks` in
                // server-info-derive.ts), so that order is the contract between
                // the two sides. Any other arity cannot be mapped onto it —
                // drop the sample and let the panel show a placeholder rather
                // than compute a confident wrong number.
                if let Some(ticks) = parse_cpu_ticks(val) {
                    info["cpu_ticks"] = ticks.into();
                }
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

/// `/proc/stat`'s `cpu` row → its seven cumulative counters, in kernel order.
///
/// All-or-nothing on purpose. Filtering the unparsable fields out and then
/// checking the length *looks* equivalent and is not: one corrupt middle field is
/// dropped, the survivors still number seven, and the sample is accepted with
/// every later counter read one place too far — a confident wrong percentage
/// instead of the placeholder the arity check is there to produce. Seven tokens,
/// seven numbers, or nothing.
fn parse_cpu_ticks(value: &str) -> Option<Vec<u64>> {
    let fields: Vec<&str> = value.split_whitespace().collect();
    if fields.len() != 7 {
        return None;
    }
    fields.iter().map(|v| v.parse::<u64>().ok()).collect()
}

/// One metric column, with "the host could not tell us" kept distinct from zero.
///
/// `-` is what `PROCESS_LIST_CMD`'s degraded branch sends for `%CPU`/`%MEM`, and
/// it becomes JSON `null` so the panel can print `—`. Everything else keeps the
/// long-standing behaviour of an unparseable value scoring `0.0`: that path is
/// reached by a malformed row, where inventing `null` would hide a parse problem
/// behind a rendering decision.
fn optional_metric(raw: &str) -> serde_json::Value {
    if raw == "-" {
        serde_json::Value::Null
    } else {
        serde_json::json!(raw.parse::<f64>().unwrap_or(0.0))
    }
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
///
/// `-` is the interchange format's "this host cannot supply the column" marker,
/// so `time` carries it on both fallback branches and `cpu`/`mem` carry it on the
/// degraded one (see `PROCESS_LIST_CMD`). It must not collapse into `0.0` for the
/// metrics: the panel prints whatever it is given, so a fabricated zero reads as
/// "measured, and idle" on every row. `optional_metric` keeps the two apart.
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
                "cpu": optional_metric(fields[2]),
                "mem": optional_metric(fields[3]),
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
    /// （截图里的红色 `ps 100.0`）。这四行就是那次轮询自己 spawn 的 ps/awk/sort/head
    /// —— `sort` 只出现在回退分支（`ps aux | … | sort -k3 -rn | head -40`）。
    #[test]
    fn parse_process_output_drops_the_polls_own_helpers() {
        let out = "\
  1234 root 100.0  0.0 00:00 ps\n\
  1235 root  40.0  0.0 00:00 awk\n\
  1236 root  30.0  0.0 00:00 sort\n\
  1237 root  20.0  0.0 00:00 head\n";
        assert!(
            parse_process_output(out).is_empty(),
            "轮询自身 spawn 的 ps/awk/sort/head 不得进入面板"
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

    /// 降级分支的 `-` 不能被折叠成 `0.0`。
    ///
    /// 面板会把拿到的数字照原样打印，所以一个凭空造的 0 读起来是"量过了，而且是
    /// 空闲" —— 每一行都这么说，而宿主的 `%CPU` 其实根本拿不到。这正是这次要
    /// 消灭的那类假数据，只不过换了个位置：先是不该有的排名，再是不该有的 0。
    #[test]
    fn parse_process_output_keeps_unknown_metrics_distinct_from_zero() {
        let out = "   42 root - - - nginx\n";
        let rows = parse_process_output(out);
        assert_eq!(rows.len(), 1, "降级格式（cpu/mem/etime 皆为 `-`）须被接受");
        assert_eq!(rows[0]["command"], "nginx");
        assert!(rows[0]["cpu"].is_null(), "拿不到就是 null，不是 0.0");
        assert!(rows[0]["mem"].is_null(), "拿不到就是 null，不是 0.0");
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
    /// 而曾经为了让它真能回退，用 `if ps … ; then ps …` 探测 —— 那会把每个
    /// /proc 条目读两遍（`--sort` 决定 ps 无法流式输出）。改为先取输出再判断，
    /// 于是常见路径只跑一次 ps。
    #[test]
    fn process_list_cmd_scans_proc_once_on_the_common_path() {
        assert_eq!(
            PROCESS_LIST_CMD.matches("ps -eo").count(),
            1,
            "常见路径只该跑一次 ps：探测 + 真跑等于每拍两遍全扫 /proc"
        );
        assert!(
            !PROCESS_LIST_CMD.contains("||"),
            "管道 || 回退是死代码：退出码取自 head，恒为 0"
        );
        assert!(
            PROCESS_LIST_CMD.contains("head -40"),
            "过滤会吃掉几行，命令侧须多取"
        );
        assert!(
            PROCESS_LIST_CMD.contains("ps aux") && PROCESS_LIST_CMD.contains("ps -o pid,user,comm"),
            "两条回退分支都要在：BSD 宿主与 BusyBox 的接口不同，缺一条就有宿主拿不到列表"
        );
    }

    /// BSD 分支只能按**形状**认领 `ps aux`，不能按"我们跑的就是 ps aux"认领。
    ///
    /// `$1` 非数字且 `$2` 是数字 = `USER PID`。BusyBox 的 `ps` 若吐出 `PID USER
    /// COMMAND`，每一行都在第一条上就落榜（`$1` 就是 pid），表头也在第一条上落榜；
    /// 于是同一条命令在两种宿主上不会再互相冒充。
    #[test]
    fn portable_fallback_only_claims_rows_that_really_are_bsd_ps_aux() {
        let bsd = PROCESS_LIST_CMD
            .split("ps aux")
            .nth(1)
            .expect("BSD 分支必须还在");
        assert!(
            bsd.contains("$1 !~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/"),
            "必须按 USER PID 的形状认行，否则 BusyBox 的 PID USER COMMAND 会被按 BSD 列位读"
        );
        assert!(
            bsd.contains("$3 ~ /^[0-9]/"),
            "第 3 列本身也须是数字，否则它就不是 %CPU"
        );
    }

    /// 降级分支：BusyBox 拿不到 `%CPU`/`%MEM`，那就**不要排名**，只给列表。
    ///
    /// 这正是被换掉的那一版最大的问题：它用 `ps aux | … | sort -k3 -rn | head -40`
    /// 顶替，而 BusyBox 的 `ps` 只文档化 `-o COL1,COL2=HEADER [-T]`。于是"坏掉的
    /// 空列表"被换成了"坏掉的假 Top CPU" —— 面板上每一行的第 3 列都是别的进程的
    /// 某个字段。没有排名是诚实，假排名不是。
    #[test]
    fn degraded_branch_offers_a_list_without_pretending_to_rank_it() {
        let degraded = PROCESS_LIST_CMD
            .split("ps -o pid,user,comm")
            .nth(1)
            .expect("降级分支必须还在");
        assert!(
            !degraded.contains("sort -k3 -rn"),
            "拿不到 %CPU 就不能按第 3 列排名"
        );
        assert!(
            degraded.contains("- - -"),
            "缺的三列必须以 `-` 占位，由 parse_process_output 转成 null 而不是 0"
        );
        assert!(
            degraded.contains("| head -40"),
            "降级分支同样要限流：整张进程表不该过 SSH"
        );
    }

    /// 三条分支各自都要有上限（`.take(30)` 在传输之后，拦不住）。
    #[test]
    fn every_process_branch_is_capped_before_it_leaves_the_host() {
        assert_eq!(
            PROCESS_LIST_CMD.matches("head -40").count(),
            3,
            "GNU / BSD / 降级 三条分支各自都要有上限"
        );
    }

    /// 表头必须先剥再排：非数字的表头在 `sort -rn` 下会被排到末尾，进程少的宿主
    /// 上（少于 40 行）它就会留在 head -40 的结果里变成一行假进程。
    #[test]
    fn the_bsd_branch_drops_its_header_before_sorting() {
        let strip_header = PROCESS_LIST_CMD.find("awk 'NR>1").expect("先剥表头");
        let order_by_cpu = PROCESS_LIST_CMD.find("sort -k3 -rn").expect("再排序");
        assert!(strip_header < order_by_cpu, "剥表头必须排在排序之前");
    }

    /// sysinfo 脚本不得再为了采样 CPU 而 sleep：那一秒会把 exec 通道一直占着
    /// （5s 一拍的 ~20% 占空比）。改吐原始计数器，由面板用相邻两拍算差值。
    #[test]
    fn sysinfo_script_samples_cpu_without_sleeping() {
        assert!(
            !SYSINFO_SCRIPT.contains("sleep"),
            "采样 CPU 不得 sleep：每拍白占 1s exec 通道"
        );
        assert!(
            SYSINFO_SCRIPT.contains("CPU_TICKS="),
            "Linux 分支须吐出原始 /proc/stat 计数器"
        );
    }

    /// CPU 计数器必须恰好 7 个（user nice system idle iowait irq softirq）：
    /// 面板按固定字段序算差值，错位会算出看着合理但其实是错的百分比。
    #[test]
    fn parse_sysinfo_output_maps_seven_cpu_counters() {
        assert_eq!(
            parse_sysinfo_output("CPU_TICKS=100 20 30 400 50 6 7\n")["cpu_ticks"],
            serde_json::json!([100, 20, 30, 400, 50, 6, 7])
        );
    }

    /// 残缺/异形的计数器整条丢掉（面板显示占位），绝不把错位的数字当占用率算。
    #[test]
    fn parse_sysinfo_output_drops_malformed_cpu_counters() {
        for bad in [
            "CPU_TICKS=100 20 30 400 50 6\n",
            "CPU_TICKS=\n",
            "CPU_TICKS=a b c d e f g\n",
        ] {
            assert!(
                parse_sysinfo_output(bad).get("cpu_ticks").is_none(),
                "异形 CPU_TICKS 不得进入响应: {bad}"
            );
        }
    }

    /// 没有 /proc/stat 的宿主（macOS）仍走 top 分支直接给百分比 —— 老路径留着。
    #[test]
    fn parse_sysinfo_output_still_accepts_a_direct_cpu_usage() {
        assert_eq!(parse_sysinfo_output("CPU_USAGE=42.5\n")["cpu_usage"], 42.5);
    }

    /// 上面那组用例漏掉的正是最阴的一种：8 个 token 坏一个**中间**字段。旧实现先
    /// `filter_map(parse.ok())` 再查 `len() == 7`，过滤后恰好还剩 7 个 → 被当成合法
    /// 采样，而面板是按位置相减的 → 之后每个计数器都错开一位，算出看着合理的错值。
    /// 现在要求恰好 7 个 token 且逐个解析成功，任一处失败就整条丢掉。
    #[test]
    fn parse_sysinfo_output_rejects_a_sample_that_field_filtering_would_rescue() {
        assert!(
            parse_sysinfo_output("CPU_TICKS=100 bad 20 30 400 50 6 7\n")
                .get("cpu_ticks")
                .is_none(),
            "坏一个中间字段不得靠「过滤后仍剩 7 个」蒙混过关"
        );
        // 直接对着解析器再钉一遍这条规则（含长度不足与空串）。
        assert_eq!(parse_cpu_ticks("100 20 30 400 50 6 7"), Some(vec![100, 20, 30, 400, 50, 6, 7]));
        assert_eq!(parse_cpu_ticks("100 bad 20 30 400 50 6 7"), None);
        assert_eq!(parse_cpu_ticks("100 20 30 400 50 6"), None);
        assert_eq!(parse_cpu_ticks(""), None);
    }
}
