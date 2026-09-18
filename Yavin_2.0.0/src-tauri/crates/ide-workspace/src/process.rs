use serde::Serialize;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

#[derive(Serialize, Debug)]
pub struct ToolOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
    pub truncated: bool,
}

pub fn capture(
    mut command: Command,
    input: Option<String>,
    cancel: Arc<AtomicBool>,
) -> Result<ToolOutput, String> {
    const LIMIT: u64 = 16 * 1024 * 1024;
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Cannot start tool: {e}"))?;
    let stdout = child.stdout.take().ok_or("Missing tool output")?;
    let stderr = child.stderr.take().ok_or("Missing tool errors")?;
    let overflow = Arc::new(AtomicBool::new(false));
    let too_large = overflow.clone();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(LIMIT + 1).read_to_end(&mut bytes);
        if bytes.len() as u64 > LIMIT {
            too_large.store(true, Ordering::Relaxed);
        }
        result.map(|_| bytes)
    });
    let error_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        // Drain stderr even after the display limit to avoid blocking the process.
        let mut stderr = stderr;
        let mut buffer = [0; 4096];
        loop {
            let count = stderr.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            if bytes.len() < 65536 {
                bytes.extend_from_slice(&buffer[..count]);
            }
        }
        Ok::<_, std::io::Error>(bytes)
    });
    let writer = child.stdin.take().map(|mut stdin| {
        std::thread::spawn(move || stdin.write_all(input.unwrap_or_default().as_bytes()))
    });
    let start = Instant::now();
    // Decided once per tick, and only once the process is confirmed still running --
    // `try_wait()` is checked first every iteration (see the loop below) so a process
    // that finishes naturally always wins the race against a cancel/overflow/timeout
    // observed in that same tick: killing an already-exited child is a harmless
    // no-op, but reporting a real, successful exit as "Cancelled" would not be.
    let mut kill_reason: Option<&'static str> = None;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        kill_reason = stop_reason(
            cancel.load(Ordering::Relaxed),
            overflow.load(Ordering::Relaxed),
            start.elapsed() > Duration::from_secs(120),
        );
        if kill_reason.is_some() {
            let _ = child.kill();
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let bytes = reader
        .join()
        .map_err(|_| "Output reader failed")?
        .map_err(|e| e.to_string())?;
    let errors = error_reader
        .join()
        .map_err(|_| "Error reader failed")?
        .map_err(|e| e.to_string())?;
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    let truncated = overflow.load(Ordering::Relaxed);
    // `outcome` only ever sees `kill_reason` -- a value already fixed during the loop
    // above -- never the live `cancel`/`overflow` flags directly. That is what makes
    // it structurally impossible for a cancel flag flipping true *after* the process
    // already finished (while these reader threads above are still being joined) to
    // turn an otherwise-successful result into a reported cancellation: there is no
    // code path left that re-reads the flag at this point.
    outcome(kill_reason, truncated)?;
    Ok(ToolOutput {
        stdout: String::from_utf8(bytes)
            .map_err(|_| "Tool returned unsupported non-UTF-8 output")?,
        stderr: String::from_utf8_lossy(&errors).into_owned(),
        code: status.code().unwrap_or(-1),
        truncated,
    })
}

/// Which reason (if any) the still-running process should be killed for, given the
/// three independent conditions the poll loop watches. Pulled out as a pure function
/// so the priority order between them is exhaustively unit-testable without spawning
/// a real process; the loop above only calls this once it already knows (via
/// `try_wait()`) the process hasn't exited on its own this tick.
fn stop_reason(cancelled: bool, overflowed: bool, timed_out: bool) -> Option<&'static str> {
    if cancelled {
        Some("cancelled")
    } else if overflowed {
        Some("truncated")
    } else if timed_out {
        Some("timed out")
    } else {
        None
    }
}

/// Turns the loop's fixed `kill_reason` (never the live flags) into the final
/// success/failure classification. Taking `kill_reason` -- a plain value decided
/// once, while the process was confirmed still running -- rather than reading
/// `cancel`/`overflow` directly is what makes it structurally impossible for a
/// cancel flag that flips true only after the process already exited (e.g. while
/// `capture()` is still joining its reader threads) to turn an already-successful
/// result into a reported cancellation: this function has no way to observe that
/// later flip at all.
fn outcome(kill_reason: Option<&'static str>, truncated: bool) -> Result<(), String> {
    if kill_reason == Some("cancelled") {
        return Err("Cancelled".into());
    }
    if kill_reason == Some("timed out") && !truncated {
        return Err("Tool timed out. Refresh before retrying a Git operation.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn stop_reason_prefers_cancellation_over_every_other_condition() {
        assert_eq!(stop_reason(true, false, false), Some("cancelled"));
        assert_eq!(stop_reason(true, true, true), Some("cancelled"));
    }

    #[test]
    fn stop_reason_prefers_truncation_over_timeout_when_not_cancelled() {
        assert_eq!(stop_reason(false, true, false), Some("truncated"));
        assert_eq!(stop_reason(false, true, true), Some("truncated"));
    }

    #[test]
    fn stop_reason_reports_timeout_only_once_nothing_else_applies() {
        assert_eq!(stop_reason(false, false, true), Some("timed out"));
    }

    #[test]
    fn stop_reason_is_none_when_nothing_applies() {
        assert_eq!(stop_reason(false, false, false), None);
    }

    /// The actual regression test for the bug this module's revision fixes: the
    /// pre-fix code's post-loop check (`if cancel.load() { return Err("Cancelled") }`)
    /// re-read the *live* flag whenever the function happened to reach that line --
    /// so a cancel request arriving after the process had already exited (while
    /// `capture()` was still joining its reader threads, a real if narrow window)
    /// would still discard a genuinely successful result. `outcome` closes this by
    /// construction: it only ever sees `kill_reason`, a value already fixed while the
    /// process was still confirmed running, never the flags themselves -- so there is
    /// no code path left for a later flip to reach. These cases are exhaustive over
    /// every `(kill_reason, truncated)` combination `capture()` can actually produce.
    #[test]
    fn outcome_is_ok_when_nothing_stopped_the_process() {
        assert!(outcome(None, false).is_ok());
        assert!(
            outcome(None, true).is_ok(),
            "truncated alone is not an error"
        );
    }

    #[test]
    fn outcome_reports_cancellation_regardless_of_truncation() {
        assert_eq!(outcome(Some("cancelled"), false), Err("Cancelled".into()));
        assert_eq!(outcome(Some("cancelled"), true), Err("Cancelled".into()));
    }

    #[test]
    fn outcome_reports_timeout_only_when_not_also_truncated() {
        assert!(outcome(Some("timed out"), false).is_err());
        assert!(
            outcome(Some("timed out"), true).is_ok(),
            "a truncated timeout is reported as truncated output, not a timeout error"
        );
    }

    #[test]
    fn outcome_never_errors_for_the_truncated_kill_reason_alone() {
        // kill_reason == "truncated" only ever arises together with truncated == true
        // (see stop_reason), but outcome makes no such assumption -- proving it stays
        // Ok either way keeps the two functions independently correct.
        assert!(outcome(Some("truncated"), true).is_ok());
        assert!(outcome(Some("truncated"), false).is_ok());
    }

    /// A real, end-to-end proof that cancellation still actually terminates a
    /// genuinely still-running process (not just that `outcome`'s classification is
    /// pure) -- a long-lived `git`-shaped command, cancelled shortly after it starts,
    /// must be killed and reported as cancelled within a small bound, not run to
    /// completion or hang until the 120s timeout.
    #[test]
    fn a_genuinely_running_process_is_actually_killed_on_cancellation() {
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            flag.store(true, Ordering::Relaxed);
        });

        let mut command = Command::new("cmd");
        command.args(["/C", "timeout", "/t", "30"]);
        let start = Instant::now();
        let result = capture(command, None, cancel);
        assert_eq!(result.unwrap_err(), "Cancelled");
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "cancellation should stop the process almost immediately, not wait for it \
             to run its full 30s course"
        );
    }
}
