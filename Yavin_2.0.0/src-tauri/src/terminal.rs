use crate::{with_workspace, Workspace};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    env,
    io::{Read, Write},
    path::PathBuf,
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, State};

/// Every live shell, keyed by the identifier the panel gave it.
#[derive(Default)]
pub struct Terminals(pub Mutex<HashMap<String, Session>>);

pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl Session {
    /// Ends the shell. The reader thread then sees EOF and reports the exit.
    fn kill(&mut self) {
        let _ = self.killer.kill();
    }
}

/// A shell the user can actually start, as offered in the New Terminal menu.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Shell {
    pub name: String,
    pub path: String,
}

#[derive(Clone, Serialize)]
struct Output {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct Exit {
    id: String,
    code: Option<i32>,
}

/// Whether two paths name the same program, ignoring separator style and case.
/// Windows is case-insensitive and the panel may echo a path back in either form.
fn same_path(one: &str, other: &str) -> bool {
    one.replace(char::from(92), "/")
        .eq_ignore_ascii_case(&other.replace(char::from(92), "/"))
}

/// The first entry of `PATH` that holds `program`, if any.
fn find_on_path(program: &str) -> Option<PathBuf> {
    env::var_os("PATH").and_then(|paths| {
        env::split_paths(&paths)
            .map(|directory| directory.join(program))
            .find(|candidate| candidate.is_file())
    })
}

fn push_shell(shells: &mut Vec<Shell>, name: &str, path: Option<PathBuf>) {
    let Some(path) = path.filter(|path| path.is_file()) else {
        return;
    };
    let path = path.to_string_lossy().into_owned();
    // The same shell can be reached by several names; offer it once.
    if shells.iter().any(|shell| same_path(&shell.path, &path)) {
        return;
    }
    shells.push(Shell {
        name: name.to_string(),
        path,
    });
}

/// The shells present on this machine, best first. The list is also the allowlist:
/// a terminal can only be started with a program that appears here.
pub fn available_shells() -> Vec<Shell> {
    let mut shells = Vec::new();
    if cfg!(windows) {
        let system = env::var_os("SystemRoot").map(PathBuf::from);
        push_shell(
            &mut shells,
            "Command Prompt",
            env::var_os("COMSPEC").map(PathBuf::from).or_else(|| {
                system
                    .as_ref()
                    .map(|root| root.join("System32").join("cmd.exe"))
            }),
        );
        push_shell(&mut shells, "PowerShell", find_on_path("pwsh.exe"));
        push_shell(
            &mut shells,
            "Windows PowerShell",
            system.as_ref().map(|root| {
                root.join("System32")
                    .join("WindowsPowerShell")
                    .join("v1.0")
                    .join("powershell.exe")
            }),
        );
        for program_files in ["ProgramFiles", "ProgramFiles(x86)"] {
            push_shell(
                &mut shells,
                "Git Bash",
                env::var_os(program_files)
                    .map(|root| PathBuf::from(root).join("Git").join("bin").join("bash.exe")),
            );
        }
    } else {
        push_shell(
            &mut shells,
            "Default shell",
            env::var_os("SHELL").map(PathBuf::from),
        );
        for (name, path) in [
            ("zsh", "/bin/zsh"),
            ("bash", "/bin/bash"),
            ("sh", "/bin/sh"),
        ] {
            push_shell(&mut shells, name, Some(PathBuf::from(path)));
        }
    }
    shells
}

/// Accepts only a shell this machine actually offers, so the panel can never ask for
/// an arbitrary program. Without a request, the first detected shell is used.
pub fn resolve_shell(requested: Option<&str>, offered: &[Shell]) -> Result<String, String> {
    let Some(first) = offered.first() else {
        return Err("No shell could be found on this system.".into());
    };
    let Some(requested) = requested.filter(|name| !name.is_empty()) else {
        return Ok(first.path.clone());
    };
    offered
        .iter()
        .find(|shell| same_path(&shell.path, requested))
        .map(|shell| shell.path.clone())
        .ok_or_else(|| "That shell is not available on this system.".into())
}

/// Takes the longest valid UTF-8 prefix of `buffer`, leaving an incomplete trailing
/// character behind for the next read so it is never shown as replacement characters.
pub fn decode_chunk(buffer: &mut Vec<u8>) -> String {
    match std::str::from_utf8(buffer) {
        Ok(text) => {
            let text = text.to_string();
            buffer.clear();
            text
        }
        Err(error) => {
            let valid = error.valid_up_to();
            let mut text = String::from_utf8_lossy(&buffer[..valid]).into_owned();
            match error.error_len() {
                // Genuinely invalid bytes: mark them and move on rather than stall the stream.
                Some(len) => {
                    text.push('\u{fffd}');
                    buffer.drain(..valid + len);
                }
                // A character split across reads: keep the tail for the next chunk.
                None => {
                    buffer.drain(..valid);
                }
            }
            text
        }
    }
}

/// Where a terminal should start when no workspace folder is open: the user's home
/// directory, falling back to the process's own current directory.
fn default_cwd() -> PathBuf {
    let home = if cfg!(windows) {
        env::var_os("USERPROFILE")
    } else {
        env::var_os("HOME")
    };
    home.map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(|| env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn size_of(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[tauri::command]
pub fn terminal_shells() -> Vec<Shell> {
    available_shells()
}

/// A terminal profile's extra launch settings, all optional.
///
/// None of these widen what a terminal can do: whoever can open a terminal can already type
/// any command into it, so arguments, environment and working directory are the same authority
/// expressed up front. They are still validated, because a NUL or a newline smuggled into an
/// argument or a variable name is a way to confuse the process launcher rather than the user.
fn check_launch_text(what: &str, value: &str) -> Result<(), String> {
    if value.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return Err(format!(
            "A terminal {what} cannot contain a line break or NUL."
        ));
    }
    Ok(())
}

/// Where a terminal starts. Must be a directory that exists: a missing or file path would
/// otherwise fail deep inside the spawn with a message that names nothing useful.
fn resolve_cwd(requested: Option<&str>, fallback: PathBuf) -> Result<PathBuf, String> {
    let Some(requested) = requested.filter(|path| !path.is_empty()) else {
        // The fallback is usually the workspace root, which is canonical and so, on Windows,
        // in the extended-length form a shell cannot start in (see `process_cwd`).
        return Ok(process_cwd(fallback));
    };
    check_launch_text("working directory", requested)?;
    let path = PathBuf::from(requested);
    if !path.is_dir() {
        return Err(format!(
            "{requested} is not a folder this terminal can start in."
        ));
    }
    // Deliberately NOT canonicalised: that would produce the extended-length form. The path
    // has already been shown to be a real directory, which is what actually needed checking.
    Ok(process_cwd(path))
}

/// `path` in the form a process can be started in.
///
/// On Windows, `canonicalize` -- and so the workspace root -- returns the extended-length
/// `\\?\C:\...` / `\\?\UNC\server\share\...` form. That is the right form for identity and for
/// file I/O, but not for a working directory: `cmd.exe` refuses it with "UNC paths are not
/// supported" and starts in the Windows directory instead, so the terminal silently lands in
/// the wrong folder. The prefix is removed when the plain form names the same folder, and kept
/// when it would not -- a path too long for the plain form, or a component that plain Win32
/// paths cannot express -- so the shell is never quietly given a different folder.
///
/// Anywhere else a path has no such prefix, and this returns it unchanged.
fn process_cwd(path: PathBuf) -> PathBuf {
    use std::path::{Component, Prefix};

    let mut components = path.components();
    let plain = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::VerbatimDisk(drive) => format!("{}:", drive as char),
            Prefix::VerbatimUNC(server, share) => format!(
                r"\\{}\{}",
                server.to_string_lossy(),
                share.to_string_lossy()
            ),
            _ => return path,
        },
        _ => return path,
    };
    let mut result = PathBuf::from(plain);
    for component in components {
        match component {
            Component::RootDir => result.push(component),
            Component::Normal(name) if plain_name_is_safe(&name.to_string_lossy()) => {
                result.push(name)
            }
            // `.`/`..` are literal names under the prefix but not without it, and a name the
            // plain form cannot hold would be read as something else.
            _ => return path,
        }
    }
    // MAX_PATH less the terminator, which is the limit a working directory has to respect.
    if result.as_os_str().len() >= 259 {
        return path;
    }
    result
}

/// Whether `name` means the same thing without the extended-length prefix: plain Win32 paths
/// trim trailing dots and spaces, and treat the reserved device names as devices.
fn plain_name_is_safe(name: &str) -> bool {
    if name.ends_with('.') || name.ends_with(' ') {
        return false;
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    !reserved
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn terminal_open(
    app: AppHandle,
    state: State<'_, Workspace>,
    terminals: State<'_, Terminals>,
    id: String,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    args: Option<Vec<String>>,
    env: Option<Vec<(String, String)>>,
    cwd: Option<String>,
) -> Result<String, String> {
    if id.is_empty() {
        return Err("A terminal needs an identifier.".into());
    }
    // A terminal is useful even with no folder open, the same as any other IDE's
    // integrated terminal -- it just starts in the user's home directory instead.
    let root = with_workspace(&state, |manager| Ok(manager.root().to_path_buf()))
        .unwrap_or_else(|_| default_cwd());
    let root = resolve_cwd(cwd.as_deref(), root)?;
    let shell = resolve_shell(shell.as_deref(), &available_shells())?;

    let args = args.unwrap_or_default();
    for argument in &args {
        check_launch_text("argument", argument)?;
    }
    let env = env.unwrap_or_default();
    for (name, value) in &env {
        if name.is_empty() || name.contains('=') {
            return Err("A terminal environment variable needs a plain name.".into());
        }
        check_launch_text("environment variable", name)?;
        check_launch_text("environment value", value)?;
    }

    let pair = native_pty_system()
        .openpty(size_of(cols, rows))
        .map_err(|e| format!("Cannot open a terminal: {e}"))?;

    // The shell is started as itself. Arguments come only from a terminal profile, never
    // from an interpolated command line, so there is no string for the panel to inject into.
    let mut command = CommandBuilder::new(&shell);
    for argument in &args {
        command.arg(argument);
    }
    command.cwd(&root);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    for (name, value) in &env {
        command.env(name, value);
    }
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| format!("Cannot start {shell}: {e}"))?;
    drop(pair.slave);

    let killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Cannot read from {shell}: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Cannot write to {shell}: {e}"))?;

    // The reader owns the child so the exit is reported only after the last output,
    // never interleaved ahead of it.
    let handle = app.clone();
    let reported = id.clone();
    std::thread::spawn(move || {
        let mut pending = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    pending.extend_from_slice(&buffer[..count]);
                    let data = decode_chunk(&mut pending);
                    if !data.is_empty() {
                        let _ = handle.emit(
                            "terminal-output",
                            Output {
                                id: reported.clone(),
                                data,
                            },
                        );
                    }
                }
            }
        }
        let code = child.wait().ok().map(|status| status.exit_code() as i32);
        let _ = handle.emit("terminal-exit", Exit { id: reported, code });
    });

    let session = Session {
        master: pair.master,
        writer,
        killer,
    };
    if let Some(mut replaced) = terminals
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, session)
    {
        replaced.kill();
    }
    Ok(shell)
}

#[tauri::command]
pub fn terminal_write(
    terminals: State<'_, Terminals>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = terminals.0.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&id)
        .ok_or("That terminal is no longer running.")?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|()| session.writer.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn terminal_resize(
    terminals: State<'_, Terminals>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = terminals.0.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&id)
        .ok_or("That terminal is no longer running.")?;
    session
        .master
        .resize(size_of(cols, rows))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn terminal_close(terminals: State<'_, Terminals>, id: String) -> Result<(), String> {
    if let Some(mut session) = terminals.0.lock().map_err(|e| e.to_string())?.remove(&id) {
        session.kill();
    }
    Ok(())
}

/// Ends every shell, so closing the window never leaves one running.
pub fn close_all(terminals: &Terminals) {
    if let Ok(mut sessions) = terminals.0.lock() {
        for (_, mut session) in sessions.drain() {
            session.kill();
        }
    }
}

#[tauri::command]
pub fn terminal_close_all(terminals: State<'_, Terminals>) -> Result<(), String> {
    close_all(&terminals);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn offered() -> Vec<Shell> {
        vec![
            Shell {
                name: "First".into(),
                path: "C:/Windows/System32/cmd.exe".into(),
            },
            Shell {
                name: "Second".into(),
                path: "C:/Program Files/Git/bin/bash.exe".into(),
            },
        ]
    }

    #[test]
    fn decoding_keeps_a_character_split_across_reads_intact() {
        // "é" is two bytes; the first read ends between them.
        let mut buffer = vec![b'a', 0xC3];
        assert_eq!(decode_chunk(&mut buffer), "a");
        assert_eq!(buffer, vec![0xC3], "the incomplete tail is carried over");

        buffer.push(0xA9);
        buffer.push(b'b');
        assert_eq!(decode_chunk(&mut buffer), "éb");
        assert!(buffer.is_empty());
    }

    #[test]
    fn decoding_reports_invalid_bytes_instead_of_stalling() {
        let mut buffer = vec![b'a', 0xFF, b'b'];
        assert_eq!(decode_chunk(&mut buffer), "a\u{fffd}");
        assert_eq!(decode_chunk(&mut buffer), "b");
        assert!(buffer.is_empty());
    }

    #[test]
    fn only_a_detected_shell_can_be_started() {
        let shells = offered();
        // No request at all takes the first detected shell.
        assert_eq!(resolve_shell(None, &shells).unwrap(), shells[0].path);
        assert_eq!(resolve_shell(Some(""), &shells).unwrap(), shells[0].path);
        // A detected shell is accepted whatever its casing on disk.
        assert_eq!(
            resolve_shell(Some("c:/windows/system32/CMD.EXE"), &shells).unwrap(),
            shells[0].path
        );
        assert_eq!(
            resolve_shell(Some(r"C:\Windows\System32\cmd.exe"), &shells).unwrap(),
            shells[0].path
        );
        // Anything else is refused, including a real program that was never offered.
        for refused in [
            "C:/Windows/System32/calc.exe",
            "/bin/sh",
            "--upload-pack=touch",
        ] {
            assert!(
                resolve_shell(Some(refused), &shells).is_err(),
                "{refused} must be refused"
            );
        }
        assert!(resolve_shell(None, &[]).is_err());
    }

    #[test]
    fn detection_finds_a_usable_shell_and_never_repeats_one() {
        let shells = available_shells();
        assert!(!shells.is_empty(), "this machine must offer a shell");
        for shell in &shells {
            assert!(
                Path::new(&shell.path).is_file(),
                "{} does not exist",
                shell.path
            );
            assert!(!shell.name.is_empty());
        }
        let mut paths: Vec<String> = shells.iter().map(|s| s.path.to_lowercase()).collect();
        paths.sort();
        let count = paths.len();
        paths.dedup();
        assert_eq!(paths.len(), count, "a shell was offered twice");
    }

    /// Exercises the real PTY: the user's own shell must start, accept a command, and
    /// report its output. This is the part that differs most between platforms.
    ///
    /// A terminal has to answer the shell's cursor-position query (ESC[6n) or ConPTY's
    /// cmd.exe never draws a prompt and never reads input. xterm.js answers it in the
    /// application; this test answers it the same way.
    #[test]
    fn a_real_shell_runs_a_command_and_reports_its_output() {
        use std::sync::mpsc::{channel, RecvTimeoutError};
        use std::time::{Duration, Instant};
        const MARKER: &str = "yavin-terminal-works";

        let shell = resolve_shell(None, &available_shells()).unwrap();
        let pair = native_pty_system().openpty(size_of(80, 24)).unwrap();
        let mut command = CommandBuilder::new(&shell);
        command.cwd(env::temp_dir());
        command.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (sender, chunks) = channel();
        std::thread::spawn(move || {
            let mut pending = Vec::new();
            let mut buffer = [0u8; 8192];
            while let Ok(count) = reader.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                pending.extend_from_slice(&buffer[..count]);
                if sender.send(decode_chunk(&mut pending)).is_err() {
                    break;
                }
            }
        });

        let mut seen = String::new();
        let mut answered = false;
        let mut asked = false;
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline && seen.matches(MARKER).count() < 2 {
            match chunks.recv_timeout(Duration::from_millis(250)) {
                Ok(text) => seen.push_str(&text),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            if !answered && seen.contains("\u{1b}[6n") {
                writer.write_all(b"\x1b[1;1R").unwrap();
                writer.flush().unwrap();
                answered = true;
                continue;
            }
            // Type only once the shell has settled, the way a person would.
            if answered && !asked {
                writer
                    .write_all(format!("echo {MARKER}\r\n").as_bytes())
                    .unwrap();
                writer.flush().unwrap();
                asked = true;
            }
        }

        let _ = child.kill();
        let _ = child.wait();
        assert!(
            seen.matches(MARKER).count() >= 2,
            "{shell} did not run the command; saw {seen:?}"
        );
    }

    /// A profile's launch settings are the same authority as typing into the terminal, but a
    /// NUL or line break in one is a way to confuse the launcher rather than the user.
    #[test]
    fn launch_text_refuses_line_breaks_and_nul() {
        assert!(check_launch_text("argument", "-NoLogo").is_ok());
        assert!(check_launch_text("argument", "--flag=value with spaces").is_ok());
        assert!(check_launch_text("argument", "ok\u{0}evil").is_err());
        assert!(check_launch_text("argument", "ok\nevil").is_err());
        assert!(check_launch_text("argument", "ok\revil").is_err());
    }

    #[test]
    fn a_terminal_starts_in_a_real_folder_or_says_why_not() {
        let dir = std::env::temp_dir().join(format!("yavin-cwd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fallback = std::env::current_dir().unwrap();

        // No request: the caller's fallback is used untouched.
        assert_eq!(resolve_cwd(None, fallback.clone()).unwrap(), fallback);
        assert_eq!(resolve_cwd(Some(""), fallback.clone()).unwrap(), fallback);

        // A real folder is accepted as given, not canonicalised. (What happens to a folder
        // that arrives in extended-length form is `a_shell_starts_in_the_workspace_root_...`.)
        let resolved = resolve_cwd(Some(&dir.to_string_lossy()), fallback.clone()).unwrap();
        assert_eq!(resolved, dir);

        // A file, and a folder that is not there, each fail by name rather than deep inside
        // the spawn with a message that identifies nothing.
        let file = dir.join("a.txt");
        std::fs::write(&file, "x").unwrap();
        let as_file = resolve_cwd(Some(&file.to_string_lossy()), fallback.clone());
        assert!(as_file.is_err());
        assert!(as_file.unwrap_err().contains("not a folder"));
        assert!(resolve_cwd(Some("/definitely/not/here/at/all"), fallback.clone()).is_err());
        assert!(resolve_cwd(Some("ok\u{0}evil"), fallback).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn a_shell_starts_in_the_workspace_root_rather_than_its_extended_length_form() {
        let dir = std::env::temp_dir().join(format!("yavin-cwd-root-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // The workspace root, as `terminal_open` falls back to it: canonical, and so in the
        // extended-length form.
        let root = dir.canonicalize().unwrap();
        assert!(
            root.to_string_lossy().starts_with(r"\\?\"),
            "{}",
            root.display()
        );

        let cwd = resolve_cwd(None, root.clone()).unwrap();
        assert!(
            !cwd.to_string_lossy().starts_with(r"\\?\"),
            "{}",
            cwd.display()
        );
        assert!(cwd.is_dir());
        assert_eq!(cwd.canonicalize().unwrap(), root, "still the same folder");
        // A requested folder in that form is handled the same way.
        let requested = resolve_cwd(Some(&root.to_string_lossy()), PathBuf::new()).unwrap();
        assert_eq!(requested, cwd);

        // And a shell started the way `terminal_open` starts one really is in that folder.
        let printed = cmd_cd_in_pty(&cwd).to_lowercase();
        let expected = cwd.to_string_lossy().to_lowercase();
        assert!(
            printed.contains(&expected) && !printed.contains("unc paths are not supported"),
            "cmd.exe did not start in {expected}:\n{printed}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// What `cmd /c cd` prints when started in `cwd` through the same PTY and `CommandBuilder`
    /// the terminal uses -- which, unlike `std::process::Command`, passes the directory to the
    /// OS exactly as given.
    #[cfg(windows)]
    fn cmd_cd_in_pty(cwd: &Path) -> String {
        use std::sync::mpsc::{channel, RecvTimeoutError};
        use std::time::{Duration, Instant};

        let pair = native_pty_system().openpty(size_of(200, 24)).unwrap();
        let mut command = CommandBuilder::new("cmd.exe");
        command.args(["/d", "/c", "cd"]);
        command.cwd(cwd);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (sender, chunks) = channel();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            while let Ok(count) = reader.read(&mut buffer) {
                if count == 0
                    || sender
                        .send(String::from_utf8_lossy(&buffer[..count]).into_owned())
                        .is_err()
                {
                    break;
                }
            }
        });

        let mut seen = String::new();
        let mut answered = false;
        let mut exited_at = None;
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            match chunks.recv_timeout(Duration::from_millis(100)) {
                Ok(text) => seen.push_str(&text),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            // ConPTY asks for the cursor position before it lets output through.
            if !answered && seen.contains("\u{1b}[6n") {
                writer.write_all(b"\x1b[1;1R").unwrap();
                writer.flush().unwrap();
                answered = true;
            }
            if exited_at.is_none() && matches!(child.try_wait(), Ok(Some(_))) {
                exited_at = Some(Instant::now());
            }
            // Output can trail the exit slightly; give it a moment, then stop.
            if exited_at.is_some_and(|at| at.elapsed() > Duration::from_millis(750)) {
                break;
            }
        }
        let _ = child.kill();
        seen
    }

    #[cfg(windows)]
    #[test]
    fn the_extended_length_prefix_is_kept_where_the_plain_form_would_name_something_else() {
        let same = |path: &str| process_cwd(PathBuf::from(path));
        assert_eq!(
            same(r"\\?\C:\Work\Project"),
            PathBuf::from(r"C:\Work\Project")
        );
        assert_eq!(same(r"\\?\C:\"), PathBuf::from(r"C:\"));
        assert_eq!(
            same(r"\\?\UNC\server\share\project"),
            PathBuf::from(r"\\server\share\project")
        );
        // Already plain: untouched.
        assert_eq!(same(r"C:\Work"), PathBuf::from(r"C:\Work"));
        assert_eq!(
            same(r"\\server\share\x"),
            PathBuf::from(r"\\server\share\x")
        );
        // Plain Win32 would trim the dot, or read a device, or overflow MAX_PATH: kept as is.
        for kept in [
            r"\\?\C:\Work\trailing.",
            r"\\?\C:\Work\trailing ",
            r"\\?\C:\Work\CON",
        ] {
            assert_eq!(same(kept), PathBuf::from(kept), "{kept}");
        }
        assert_eq!(
            same(r"\\?\C:\Work\com1.txt"),
            PathBuf::from(r"\\?\C:\Work\com1.txt")
        );
        assert_eq!(same(r"\\?\C:\Work\com0"), PathBuf::from(r"C:\Work\com0"));
        let long = format!(r"\\?\C:\{}", "a".repeat(300));
        assert_eq!(same(&long), PathBuf::from(&long));
    }

    #[cfg(not(windows))]
    #[test]
    fn a_working_directory_elsewhere_is_left_exactly_as_it_is() {
        // Without Windows path prefixes there is nothing to translate, and a name that looks
        // like one is just a (strange) relative file name.
        for path in ["/home/me/project", r"\\?\C:\x", "relative/dir"] {
            assert_eq!(process_cwd(PathBuf::from(path)), PathBuf::from(path));
        }
    }
}
