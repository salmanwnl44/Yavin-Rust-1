//! A language server as a process: stdin for requests, stdout for framed messages, stderr for
//! its log, and an exit to report. Everything protocol-level above the framing (JSON-RPC,
//! initialization, shutdown) is the renderer's; this only moves bytes and ends processes.

use crate::lsp_framing::{frame, FrameReader};
use crate::process::{kill_tree, poll_interval};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// What a server process reports, as it happens, from its own threads.
pub trait ServerEvents: Send + Sync + 'static {
    /// One whole message body from stdout.
    fn message(&self, body: String);
    /// One line of stderr (the server's log).
    fn log(&self, line: String);
    /// The process ended: its exit code if it has one, and why the session ended if it was not
    /// the process's own doing (a broken stream).
    fn exit(&self, code: Option<i32>, error: Option<String>);
}

/// A running server. Dropping it does not stop the process; `stop` does.
pub struct ServerProcess {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
}

/// The longest a stderr line is kept; a server printing a megabyte on one line is truncated.
const MAX_LOG_LINE: usize = 16 * 1024;

impl ServerProcess {
    /// Starts `program` with `args` in `cwd`. Nothing about the command comes from the caller
    /// beyond these three, which the caller has already resolved from its allow-list.
    pub fn spawn(
        program: &Path,
        args: &[&str],
        cwd: &Path,
        events: Arc<dyn ServerEvents>,
    ) -> Result<ServerProcess, String> {
        let mut command = Command::new(program);
        command
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // No console window for a background process.
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => format!("{} was not found.", program.display()),
            std::io::ErrorKind::PermissionDenied => {
                format!("{} could not be run: permission denied.", program.display())
            }
            _ => format!("{} could not be started: {error}", program.display()),
        })?;
        let stdout = child.stdout.take().ok_or("The server has no output")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("The server has no error output")?;
        let stdin = child.stdin.take();
        let child = Arc::new(Mutex::new(child));

        let log = events.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut line = Vec::new();
            loop {
                line.clear();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        line.truncate(MAX_LOG_LINE);
                        let text = String::from_utf8_lossy(&line);
                        log.log(text.trim_end_matches(['\r', '\n']).to_string());
                    }
                }
            }
        });

        let watched = child.clone();
        std::thread::spawn(move || {
            let mut stdout = stdout;
            let mut reader = FrameReader::default();
            let mut buffer = vec![0u8; 64 * 1024];
            let mut broken = None;
            loop {
                match stdout.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => match reader.push(&buffer[..count]) {
                        Ok(messages) => {
                            for message in messages {
                                events.message(message);
                            }
                        }
                        Err(error) => {
                            // The stream cannot be resynchronized: the session is over.
                            broken = Some(error.to_string());
                            if let Ok(mut child) = watched.lock() {
                                kill_tree(&mut child);
                            }
                            break;
                        }
                    },
                }
            }
            if broken.is_none() && reader.pending() > 0 {
                broken = Some("The server's output ended in the middle of a message.".into());
            }
            events.exit(wait_for_exit(&watched), broken);
        });

        Ok(ServerProcess {
            child,
            stdin: Arc::new(Mutex::new(stdin)),
        })
    }

    /// Writes one message, framed. Fails once the server has gone.
    pub fn send(&self, body: &str) -> Result<(), String> {
        let mut stdin = self.stdin.lock().map_err(|e| e.to_string())?;
        let pipe = stdin.as_mut().ok_or("The language server has stopped.")?;
        pipe.write_all(&frame(body))
            .and_then(|()| pipe.flush())
            .map_err(|e| format!("The language server has stopped: {e}"))
    }

    /// Ends the process and everything it started. The exit is still reported, once, by the
    /// reader thread when the output closes.
    pub fn stop(&self) {
        if let Ok(mut stdin) = self.stdin.lock() {
            stdin.take();
        }
        if let Ok(mut child) = self.child.lock() {
            kill_tree(&mut child);
        }
    }

    pub fn id(&self) -> Option<u32> {
        self.child.lock().ok().map(|child| child.id())
    }
}

/// The exit code once the process has ended, waiting a little for a process whose output has
/// closed but which has not quite exited, and ending it if it lingers.
fn wait_for_exit(child: &Arc<Mutex<Child>>) -> Option<i32> {
    let start = Instant::now();
    loop {
        if let Ok(mut guard) = child.lock() {
            match guard.try_wait() {
                Ok(Some(status)) => return status.code(),
                Ok(None) if start.elapsed() > Duration::from_secs(5) => {
                    kill_tree(&mut guard);
                }
                Ok(None) => {}
                Err(_) => return None,
            }
        }
        std::thread::sleep(poll_interval(start.elapsed()));
    }
}

/// Where `program` is: in the project's own `node_modules/.bin` first when `node_package` (a
/// project pins its own TypeScript server, say), then on `PATH`. On Windows the executable
/// suffixes are tried in `PATHEXT` order, since npm installs `name.cmd` shims.
pub fn resolve_program(
    program: &str,
    node_package: bool,
    project: &Path,
    path_var: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        [".exe", ".cmd", ".bat", ""]
            .iter()
            .map(|suffix| format!("{program}{suffix}"))
            .collect()
    } else {
        vec![program.to_string()]
    };
    let mut folders = Vec::new();
    if node_package {
        folders.push(project.join("node_modules").join(".bin"));
    }
    if let Some(path) = path_var {
        folders.extend(std::env::split_paths(&path));
    }
    folders.iter().find_map(|folder| {
        names
            .iter()
            .map(|name| folder.join(name))
            .find(|candidate| candidate.is_file())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yavin-lsp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_program_is_found_in_the_project_before_the_path_and_only_if_it_exists() {
        let project = temp("resolve-project");
        let elsewhere = temp("resolve-path");
        let name = if cfg!(windows) { "srv.cmd" } else { "srv" };
        std::fs::write(elsewhere.join(name), "").unwrap();
        let path_var = Some(std::env::join_paths([&elsewhere]).unwrap());
        assert_eq!(
            resolve_program("srv", true, &project, path_var.clone()),
            Some(elsewhere.join(name))
        );
        let local = project.join("node_modules").join(".bin");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::write(local.join(name), "").unwrap();
        assert_eq!(
            resolve_program("srv", true, &project, path_var.clone()),
            Some(local.join(name))
        );
        // Not a Node package: the project's folder is never looked in.
        assert_eq!(
            resolve_program("srv", false, &project, path_var.clone()),
            Some(elsewhere.join(name))
        );
        assert_eq!(resolve_program("missing", true, &project, path_var), None);
        let _ = std::fs::remove_dir_all(project);
        let _ = std::fs::remove_dir_all(elsewhere);
    }

    struct Recorder(Mutex<mpsc::Sender<String>>);
    impl ServerEvents for Recorder {
        fn message(&self, body: String) {
            let _ = self.0.lock().unwrap().send(format!("message {body}"));
        }
        fn log(&self, line: String) {
            let _ = self.0.lock().unwrap().send(format!("log {line}"));
        }
        fn exit(&self, code: Option<i32>, error: Option<String>) {
            let _ = self
                .0
                .lock()
                .unwrap()
                .send(format!("exit {code:?} {}", error.unwrap_or_default()));
        }
    }

    fn node() -> Option<PathBuf> {
        resolve_program("node", false, Path::new("."), std::env::var_os("PATH"))
    }

    /// A real process: an echo server written in Node (skipped where Node is not installed).
    /// It answers each framed message with the same body, logs to stderr, and exits on "bye".
    #[test]
    fn a_real_server_process_exchanges_framed_messages_and_reports_its_exit() {
        let Some(node) = node() else { return };
        let script = r#"
let buffer = Buffer.alloc(0);
process.stderr.write("echo ready\n");
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.slice(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const body = buffer.slice(end + 4, end + 4 + length).toString("utf8");
    buffer = buffer.slice(end + 4 + length);
    if (body === '"bye"') process.exit(3);
    const out = Buffer.from(body, "utf8");
    process.stdout.write("Content-Length: " + out.length + "\r\n\r\n");
    process.stdout.write(out);
  }
});
"#;
        let dir = temp("echo");
        std::fs::write(dir.join("echo.js"), script).unwrap();
        let (sender, received) = mpsc::channel();
        let events = Arc::new(Recorder(Mutex::new(sender)));
        let server = ServerProcess::spawn(&node, &["echo.js"], &dir, events).unwrap();
        let next = || received.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(next(), "log echo ready");
        server.send(r#"{"id":1,"text":"ünïcode ✓"}"#).unwrap();
        assert_eq!(next(), r#"message {"id":1,"text":"ünïcode ✓"}"#);
        server.send(r#""bye""#).unwrap();
        assert_eq!(next(), "exit Some(3) ");
        assert!(server.send("{}").is_err() || received.try_recv().is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn stopping_a_server_ends_it_and_a_broken_stream_ends_the_session() {
        let Some(node) = node() else { return };
        let dir = temp("broken");
        // Writes garbage instead of framed messages after its first input.
        std::fs::write(
            dir.join("broken.js"),
            r#"process.stdin.on("data", () => process.stdout.write("not a header\r\n\r\n"));
setInterval(() => {}, 1000);"#,
        )
        .unwrap();
        std::fs::write(dir.join("idle.js"), "setInterval(() => {}, 1000);").unwrap();

        let (sender, received) = mpsc::channel();
        let broken = ServerProcess::spawn(
            &node,
            &["broken.js"],
            &dir,
            Arc::new(Recorder(Mutex::new(sender))),
        )
        .unwrap();
        broken.send("{}").unwrap();
        let exit = received.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(
            exit.starts_with("exit ") && exit.contains("Malformed"),
            "{exit}"
        );

        let (sender, received) = mpsc::channel();
        let idle = ServerProcess::spawn(
            &node,
            &["idle.js"],
            &dir,
            Arc::new(Recorder(Mutex::new(sender))),
        )
        .unwrap();
        let started = Instant::now();
        idle.stop();
        let exit = received.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(exit.starts_with("exit "), "{exit}");
        assert!(started.elapsed() < Duration::from_secs(8));
        assert!(idle.send("{}").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_program_that_does_not_exist_says_so() {
        let (sender, _) = mpsc::channel();
        let error = ServerProcess::spawn(
            Path::new("definitely-not-a-language-server-xyz"),
            &[],
            &std::env::temp_dir(),
            Arc::new(Recorder(Mutex::new(sender))),
        )
        .err()
        .unwrap();
        assert!(error.contains("was not found"), "{error}");
    }
}
