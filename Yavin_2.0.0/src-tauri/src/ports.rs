//! Which local ports something is listening on, and which process holds each one.
//!
//! VS Code's Ports view publishes a local service through a dev tunnel, which needs a tunnel
//! host and a sign-in. Yavin does neither. What is reusable is the detection half that VS Code
//! itself uses to decide what to forward (`remote.autoForwardPortsSource: "process"`): list
//! the ports in LISTEN state with the owning process, so a dev server can be opened, copied or
//! stopped without hunting for it in a task manager.
//!
//! The enumeration shells out rather than binding platform APIs: `netstat`/`tasklist` on
//! Windows and `lsof` elsewhere are present on stock installs, and the risk in this feature is
//! entirely in parsing their output -- which is what the tests below cover.

use ide_workspace::process::capture_within;
use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;
use std::sync::{atomic::AtomicBool, Arc};
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ListeningPort {
    pub port: u16,
    /// The address it listens on, e.g. `127.0.0.1` (this machine only) or `0.0.0.0` (any).
    pub address: String,
    pub pid: u32,
    /// Empty when the owning process could not be named, which is normal for ports owned by
    /// another user or by the system.
    pub process: String,
}

/// Splits a `netstat` local-address column into address and port. IPv6 keeps its brackets in
/// the output (`[::1]:5173`), and an address can itself contain colons, so the port is taken
/// from the last one.
pub fn split_address(field: &str) -> Option<(String, u16)> {
    let (address, port) = field.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    let address = address.trim_start_matches('[').trim_end_matches(']');
    Some((address.to_string(), port))
}

/// Parses `netstat -ano -p TCP` (Windows). Only LISTENING rows are of interest; the rest are
/// established connections, which are not something to open or stop.
pub fn parse_netstat(text: &str) -> Vec<ListeningPort> {
    let mut found = Vec::new();
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        // Proto, Local Address, Foreign Address, State, PID
        if fields.len() < 5 || !fields[0].eq_ignore_ascii_case("tcp") {
            continue;
        }
        if !fields[3].eq_ignore_ascii_case("LISTENING") {
            continue;
        }
        let Some((address, port)) = split_address(fields[1]) else {
            continue;
        };
        let Ok(pid) = fields[4].parse::<u32>() else {
            continue;
        };
        found.push(ListeningPort {
            port,
            address,
            pid,
            process: String::new(),
        });
    }
    found
}

/// Parses `tasklist /FO CSV /NH` into pid -> image name.
pub fn parse_tasklist(text: &str) -> HashMap<u32, String> {
    let mut names = HashMap::new();
    for line in text.lines() {
        // "name.exe","1234","Console","1","12,345 K"
        let fields: Vec<&str> = line.split("\",\"").collect();
        if fields.len() < 2 {
            continue;
        }
        let name = fields[0].trim_start_matches('"');
        if let Ok(pid) = fields[1].trim_matches('"').parse::<u32>() {
            names.insert(pid, name.to_string());
        }
    }
    names
}

/// Parses `lsof -nP -iTCP -sTCP:LISTEN` (macOS and Linux).
pub fn parse_lsof(text: &str) -> Vec<ListeningPort> {
    let mut found = Vec::new();
    for line in text.lines() {
        // COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 9 || fields[0] == "COMMAND" {
            continue;
        }
        let Ok(pid) = fields[1].parse::<u32>() else {
            continue;
        };
        // NAME is the ninth column and looks like `127.0.0.1:5173`, but lsof appends
        // `(LISTEN)` after it -- so the address is found by looking for the first field from
        // there that actually parses, not by taking the last one.
        let Some((address, port)) = fields[8..].iter().find_map(|field| split_address(field))
        else {
            continue;
        };
        found.push(ListeningPort {
            port,
            address: if address == "*" {
                "0.0.0.0".into()
            } else {
                address
            },
            pid,
            process: fields[0].to_string(),
        });
    }
    found
}

/// Parses `ss -ltnp` (Linux), the stand-in where `lsof` is not installed:
/// `LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=23188,fd=23))`
pub fn parse_ss(text: &str) -> Vec<ListeningPort> {
    let mut found = Vec::new();
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 4 || !fields[0].eq_ignore_ascii_case("LISTEN") {
            continue;
        }
        let Some((address, port)) = split_address(fields[3]) else {
            continue;
        };
        // `users:(("name",pid=123,fd=4))` -- absent when ss runs without privileges.
        let users = fields.iter().find(|field| field.starts_with("users:("));
        let pid = users
            .and_then(|field| field.split("pid=").nth(1))
            .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
            .and_then(|digits| digits.parse::<u32>().ok())
            .unwrap_or(0);
        let process = users
            .and_then(|field| field.split('"').nth(1))
            .unwrap_or("")
            .to_string();
        found.push(ListeningPort {
            port,
            address: if address == "*" {
                "0.0.0.0".into()
            } else {
                address
            },
            pid,
            process,
        });
    }
    found
}

/// One entry per port, preferring a row that already names its process, then lowest port
/// first. `netstat` reports the same port once per address family, which would otherwise show
/// a dev server twice.
pub fn tidy(mut ports: Vec<ListeningPort>) -> Vec<ListeningPort> {
    ports.sort_by(|a, b| {
        a.port
            .cmp(&b.port)
            // A named row sorts first, and `dedup_by` keeps the first of each run -- so the
            // row that identifies its process is the one that survives.
            .then_with(|| a.process.is_empty().cmp(&b.process.is_empty()))
            .then_with(|| a.address.cmp(&b.address))
    });
    ports.dedup_by(|a, b| a.port == b.port && a.pid == b.pid);
    ports
}

/// Runs a tool and insists it actually worked.
///
/// The exit status is checked, not just the stdout: `taskkill` reports "could not be
/// terminated" on stderr with a nonzero code, and returning only stdout meant a refused kill
/// looked like a success. A failed `netstat` was worse -- an empty list, which the view
/// renders as the cheerful "nothing is listening" rather than an error.
fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(program);
    command.args(args);
    let output = capture_within(
        command,
        None,
        Arc::new(AtomicBool::new(false)),
        Duration::from_secs(10),
    )
    .map_err(|e| format!("Could not run {program}: {e}"))?;
    if output.code != 0 {
        let reason = output.stderr.trim();
        let reason = if reason.is_empty() {
            output.stdout.trim()
        } else {
            reason
        };
        return Err(format!("{program} failed: {reason}"));
    }
    Ok(output.stdout)
}

fn with_names(mut ports: Vec<ListeningPort>) -> Vec<ListeningPort> {
    // Names are a separate call on Windows; a failure there leaves the ports listed without
    // names rather than failing the whole view, which is still useful.
    if let Ok(list) = run("tasklist", &["/FO", "CSV", "/NH"]) {
        let names = parse_tasklist(&list);
        for port in &mut ports {
            if let Some(name) = names.get(&port.pid) {
                port.process = name.clone();
            }
        }
    }
    ports
}

fn detect() -> Result<Vec<ListeningPort>, String> {
    if cfg!(windows) {
        return Ok(tidy(with_names(parse_netstat(&run(
            "netstat",
            &["-ano", "-p", "TCP"],
        )?))));
    }
    // `lsof` is absent from minimal Linux images, where `ss` is the modern equivalent, so
    // whichever is present is used and only a failure of both is reported.
    match run("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN"]) {
        Ok(text) => Ok(tidy(parse_lsof(&text))),
        Err(lsof_error) => match run("ss", &["-ltnp"]) {
            Ok(text) => Ok(tidy(parse_ss(&text))),
            Err(ss_error) => Err(format!(
                "Neither lsof nor ss could list local ports. {lsof_error} {ss_error}"
            )),
        },
    }
}

#[tauri::command]
pub async fn list_listening_ports() -> Result<Vec<ListeningPort>, String> {
    tauri::async_runtime::spawn_blocking(detect)
        .await
        .map_err(|e| e.to_string())?
}

/// Ends the process holding a port.
///
/// Takes the pid as well as the port, and requires both to still match a listening entry.
/// Port alone was wrong: two processes can listen on the same port number on different
/// interfaces -- the view shows a row for each -- and picking "the first with this port"
/// meant Stop on the second row killed the first one's process.
///
/// Re-enumerating is a real check rather than a formality, but it is not atomic: a pid can be
/// recycled between the listing and the kill. That window is why it refuses to touch this
/// process's own tree and the system idle/kernel pids, which are the outcomes that would be
/// unrecoverable rather than merely annoying.
#[tauri::command]
pub async fn stop_listening_process(port: u16, pid: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if pid == 0 || pid == 4 {
            return Err("That port belongs to the operating system and cannot be stopped.".into());
        }
        if pid == std::process::id() {
            return Err("That port belongs to Yavin itself.".into());
        }

        let holder = detect()?
            .into_iter()
            .find(|listening| listening.port == port && listening.pid == pid)
            .ok_or_else(|| {
                format!("Nothing with process {pid} is listening on port {port} any more.")
            })?;

        let target = holder.pid.to_string();
        if cfg!(windows) {
            run("taskkill", &["/PID", &target, "/T", "/F"])
        } else {
            run("kill", &[&target])
        }
        .map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn netstat_listening_rows_become_ports_and_connections_are_ignored() {
        let text = "\r
Active Connections\r
\r
  Proto  Local Address          Foreign Address        State           PID\r
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1084\r
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       23188\r
  TCP    192.168.1.5:52394      52.113.194.132:443     ESTABLISHED     7720\r
  TCP    [::]:445               [::]:0                 LISTENING       4\r
  UDP    0.0.0.0:5353           *:*                                    2260\r
";
        let ports = parse_netstat(text);
        assert_eq!(
            ports
                .iter()
                .map(|p| (p.address.as_str(), p.port, p.pid))
                .collect::<Vec<_>>(),
            vec![
                ("0.0.0.0", 135, 1084),
                ("127.0.0.1", 5173, 23188),
                // IPv6 keeps its address, without the brackets netstat prints.
                ("::", 445, 4),
            ],
            "only TCP rows in LISTENING state, and no UDP"
        );
    }

    #[test]
    fn tasklist_csv_maps_pids_to_names() {
        let text = "\"node.exe\",\"23188\",\"Console\",\"1\",\"142,360 K\"\r
\"svchost.exe\",\"1084\",\"Services\",\"0\",\"12,345 K\"\r
";
        let names = parse_tasklist(text);
        assert_eq!(names.get(&23188).map(String::as_str), Some("node.exe"));
        assert_eq!(names.get(&1084).map(String::as_str), Some("svchost.exe"));
    }

    #[test]
    fn lsof_rows_become_ports_with_their_command_name() {
        let text = "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node    23188 salma   23u  IPv4 0x1234      0t0  TCP 127.0.0.1:5173 (LISTEN)
nginx    9012 root     6u  IPv6 0x5678      0t0  TCP *:8080 (LISTEN)
";
        // lsof appends "(LISTEN)" after the address, so taking the last field finds nothing.
        let ports = parse_lsof(text);
        assert_eq!(
            ports
                .iter()
                .map(|p| (p.process.as_str(), p.address.as_str(), p.port, p.pid))
                .collect::<Vec<_>>(),
            vec![
                ("node", "127.0.0.1", 5173, 23188),
                // `*` means every interface, shown the way netstat spells it.
                ("nginx", "0.0.0.0", 8080, 9012),
            ],
        );
    }

    #[test]
    fn an_address_and_port_are_split_on_the_last_colon() {
        assert_eq!(
            split_address("127.0.0.1:5173"),
            Some(("127.0.0.1".into(), 5173))
        );
        assert_eq!(split_address("[::1]:8080"), Some(("::1".into(), 8080)));
        assert_eq!(split_address("*:80"), Some(("*".into(), 80)));
        assert_eq!(split_address("127.0.0.1"), None);
        assert_eq!(split_address("127.0.0.1:notaport"), None);
    }

    #[test]
    fn the_same_port_reported_for_two_address_families_is_shown_once() {
        // netstat lists a dev server on both 0.0.0.0 and [::], which is one server.
        let ports = tidy(vec![
            ListeningPort {
                port: 5173,
                address: "::".into(),
                pid: 23188,
                process: String::new(),
            },
            ListeningPort {
                port: 5173,
                address: "0.0.0.0".into(),
                pid: 23188,
                process: "node.exe".into(),
            },
            ListeningPort {
                port: 80,
                address: "0.0.0.0".into(),
                pid: 4,
                process: "System".into(),
            },
        ]);
        assert_eq!(ports.len(), 2, "one row per port and process");
        assert_eq!(ports[0].port, 80, "lowest port first");
        assert_eq!(
            ports[1].process, "node.exe",
            "the row that names its process is the one kept"
        );
    }

    #[test]
    fn a_different_process_on_the_same_port_is_kept_separate() {
        // Distinct pids are genuinely distinct listeners; only duplicates of one are merged.
        let ports = tidy(vec![
            ListeningPort {
                port: 8080,
                address: "127.0.0.1".into(),
                pid: 1,
                process: "a".into(),
            },
            ListeningPort {
                port: 8080,
                address: "127.0.0.2".into(),
                pid: 2,
                process: "b".into(),
            },
        ]);
        assert_eq!(ports.len(), 2);
    }
}
