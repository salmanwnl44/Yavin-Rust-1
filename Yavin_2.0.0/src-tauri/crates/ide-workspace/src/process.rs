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
    let mut stopped = false;
    let status = loop {
        if cancel.load(Ordering::Relaxed)
            || overflow.load(Ordering::Relaxed)
            || start.elapsed() > Duration::from_secs(120)
        {
            let _ = child.kill();
            stopped = true;
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
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
    if cancel.load(Ordering::Relaxed) {
        return Err("Cancelled".into());
    }
    let truncated = overflow.load(Ordering::Relaxed);
    if stopped && !truncated {
        return Err("Tool timed out. Refresh before retrying a Git operation.".into());
    }
    Ok(ToolOutput {
        stdout: String::from_utf8(bytes)
            .map_err(|_| "Tool returned unsupported non-UTF-8 output")?,
        stderr: String::from_utf8_lossy(&errors).into_owned(),
        code: status.code().unwrap_or(-1),
        truncated,
    })
}
