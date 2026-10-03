//! Shell integration (TERMINAL-05A): the OSC 7 and OSC 133 sequences a shell writes about itself,
//! found in its output exactly once, where the output enters the stream.
//!
//! The scanner sees every byte of a generation's output, in order, across reads (a sequence may
//! be split anywhere). It never changes, removes or holds back a byte -- the sequences stay in the
//! output, and xterm ignores them -- it only notes, after each sequence ends, what it said.
//!
//! - `ESC ] 7 ; <url> BEL|ST` -> `Cwd { uri, local }`. The URL is kept as text (the renderer
//!   reads it with the workspace's own resource rules); the scanner only decides whether its host
//!   is this machine: empty, `localhost`, or this machine's name.
//! - `ESC ] 133 ; A|B|C|D[;exit] ... BEL|ST` -> `Prompt`, `Input`, `Executing`, `Finished`. A `D`
//!   with an exit status that is not a number is still a `Finished`, without a status.
//! - Anything else that starts `7;` or `133;` but cannot be read -> `Invalid`. Every other OSC
//!   (titles, hyperlinks, colours) is not shell integration and passes unnoticed.
//!
//! A payload longer than `MAX_PAYLOAD` is abandoned: the scanner goes back to looking for the
//! next sequence rather than buffering without bound.

use ide_terminal_protocol::ShellSignal;

/// The longest OSC payload read; longer ones are not shell integration.
pub const MAX_PAYLOAD: usize = 4096;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scan {
    Text,
    /// Saw ESC.
    Escape,
    /// Inside `ESC ]`, collecting the payload.
    Osc,
    /// Saw ESC inside an OSC: `\` ends it (ST).
    OscEscape,
    /// An OSC too long to be ours: skipped to its end.
    Skip,
    SkipEscape,
}

/// What one sequence said.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    pub signal: ShellSignal,
    pub uri: Option<String>,
    pub local: Option<bool>,
    pub exit_code: Option<i32>,
}

pub struct OscScanner {
    scan: Scan,
    payload: Vec<u8>,
    host: Option<String>,
}

impl OscScanner {
    /// `host` is this machine's name, for telling a local OSC 7 URL from a remote one.
    pub fn new(host: Option<String>) -> Self {
        Self {
            scan: Scan::Text,
            payload: Vec::new(),
            host,
        }
    }

    /// Reads `bytes`, answering each shell-integration sequence that ended in them with the
    /// offset just past its last byte, in order.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<(usize, Found)> {
        let mut found = Vec::new();
        for (at, &byte) in bytes.iter().enumerate() {
            self.scan = match (self.scan, byte) {
                (Scan::Text, ESC) => Scan::Escape,
                (Scan::Text, _) => Scan::Text,
                (Scan::Escape, b']') => {
                    self.payload.clear();
                    Scan::Osc
                }
                (Scan::Escape, ESC) => Scan::Escape,
                (Scan::Escape, _) => Scan::Text,
                (Scan::Osc, BEL) => {
                    self.finish(at + 1, &mut found);
                    Scan::Text
                }
                (Scan::Osc, ESC) => Scan::OscEscape,
                (Scan::Osc, _) if self.payload.len() >= MAX_PAYLOAD => {
                    self.payload.clear();
                    Scan::Skip
                }
                (Scan::Osc, _) => {
                    self.payload.push(byte);
                    Scan::Osc
                }
                (Scan::OscEscape, b'\\') => {
                    self.finish(at + 1, &mut found);
                    Scan::Text
                }
                // ESC then anything else ends the OSC unread (another sequence began).
                (Scan::OscEscape, b']') => {
                    self.payload.clear();
                    Scan::Osc
                }
                (Scan::OscEscape, _) => Scan::Text,
                (Scan::Skip, BEL) => Scan::Text,
                (Scan::Skip, ESC) => Scan::SkipEscape,
                (Scan::Skip, _) => Scan::Skip,
                (Scan::SkipEscape, _) => Scan::Text,
            };
        }
        found
    }

    fn finish(&mut self, end: usize, found: &mut Vec<(usize, Found)>) {
        let payload = std::mem::take(&mut self.payload);
        if let Some(signal) = self.read(&payload) {
            found.push((end, signal));
        }
    }

    fn read(&self, payload: &[u8]) -> Option<Found> {
        let text = std::str::from_utf8(payload).ok();
        let invalid = Found {
            signal: ShellSignal::Invalid,
            uri: None,
            local: None,
            exit_code: None,
        };
        if let Some(uri) = payload.strip_prefix(b"7;") {
            let Some(uri) = std::str::from_utf8(uri).ok().filter(|uri| {
                uri.len() <= 2048
                    && uri
                        .get(..7)
                        .is_some_and(|s| s.eq_ignore_ascii_case("file://"))
                    && !uri.chars().any(char::is_control)
            }) else {
                return Some(invalid);
            };
            let host = uri[7..].split('/').next().unwrap_or("");
            let local = host.is_empty()
                || host.eq_ignore_ascii_case("localhost")
                || self
                    .host
                    .as_deref()
                    .is_some_and(|name| host.eq_ignore_ascii_case(name));
            return Some(Found {
                signal: ShellSignal::Cwd,
                uri: Some(uri.to_string()),
                local: Some(local),
                exit_code: None,
            });
        }
        let rest = text?.strip_prefix("133;")?;
        let mut parts = rest.split(';');
        let signal = match parts.next() {
            Some("A") => ShellSignal::Prompt,
            Some("B") => ShellSignal::Input,
            Some("C") => ShellSignal::Executing,
            Some("D") => ShellSignal::Finished,
            _ => return Some(invalid),
        };
        // `D;<status>`; later fields (`k=v` options some shells add) are not ours to read.
        let exit_code = (signal == ShellSignal::Finished)
            .then(|| {
                parts
                    .next()
                    .and_then(|code| code.trim().parse::<i32>().ok())
            })
            .flatten();
        Some(Found {
            signal,
            uri: None,
            local: None,
            exit_code,
        })
    }
}

/// This machine's name, as a shell would put it in an OSC 7 URL.
pub fn host_name() -> Option<String> {
    #[cfg(windows)]
    {
        std::env::var("COMPUTERNAME")
            .ok()
            .filter(|name| !name.is_empty())
    }
    #[cfg(unix)]
    {
        let mut buffer = [0u8; 256];
        // SAFETY: a fixed buffer, its length passed; the name is NUL-terminated within it.
        let ok = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0;
        let end = buffer.iter().position(|&b| b == 0).unwrap_or(buffer.len());
        (ok && end > 0).then(|| String::from_utf8_lossy(&buffer[..end]).into_owned())
    }
    #[cfg(not(any(windows, unix)))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(chunks: &[&[u8]]) -> Vec<Found> {
        let mut scanner = OscScanner::new(Some("MYBOX".into()));
        chunks
            .iter()
            .flat_map(|chunk| scanner.feed(chunk))
            .map(|(_, found)| found)
            .collect()
    }

    fn signals(found: &[Found]) -> Vec<ShellSignal> {
        found.iter().map(|f| f.signal).collect()
    }

    #[test]
    fn osc_7_reports_the_url_and_whether_its_host_is_this_machine() {
        let found = scan(&[
            b"\x1b]7;file:///home/me/a%20b\x07",
            b"\x1b]7;file://localhost/c/Users/x\x1b\\",
            b"\x1b]7;file://mybox/C:/Work\x07",
            b"\x1b]7;file://elsewhere/srv\x07",
        ]);
        assert_eq!(
            found
                .iter()
                .map(|f| (f.uri.as_deref().unwrap(), f.local.unwrap()))
                .collect::<Vec<_>>(),
            [
                ("file:///home/me/a%20b", true),
                ("file://localhost/c/Users/x", true),
                ("file://mybox/C:/Work", true),
                ("file://elsewhere/srv", false),
            ]
        );
    }

    #[test]
    fn osc_133_marks_prompt_input_execution_and_completion_with_its_status() {
        let found = scan(&[b"\x1b]133;A\x07\x1b]133;B\x07ls\r\n\x1b]133;C\x07out\x1b]133;D;2\x07\x1b]133;D\x07\x1b]133;D;x\x07"]);
        assert_eq!(
            signals(&found),
            [
                ShellSignal::Prompt,
                ShellSignal::Input,
                ShellSignal::Executing,
                ShellSignal::Finished,
                ShellSignal::Finished,
                ShellSignal::Finished,
            ]
        );
        assert_eq!(
            found.iter().map(|f| f.exit_code).collect::<Vec<_>>(),
            [None, None, None, Some(2), None, None]
        );
    }

    #[test]
    fn a_sequence_split_across_reads_anywhere_is_found_once_at_its_end() {
        let whole = b"text\x1b]133;D;130\x1b\\more\x1b]7;file:///tmp\x07tail";
        for cut in 0..whole.len() {
            let mut scanner = OscScanner::new(None);
            let mut found = scanner.feed(&whole[..cut]);
            found.extend(
                scanner
                    .feed(&whole[cut..])
                    .into_iter()
                    .map(|(end, f)| (end + cut, f)),
            );
            assert_eq!(
                found
                    .iter()
                    .map(|(end, f)| (*end, f.signal))
                    .collect::<Vec<_>>(),
                [(17, ShellSignal::Finished), (37, ShellSignal::Cwd)],
                "cut at {cut}"
            );
        }
    }

    #[test]
    fn malformed_sequences_are_invalid_and_other_oscs_pass_unnoticed() {
        let found = scan(&[
            b"\x1b]0;window title\x07",
            b"\x1b]8;;https://example.com\x07link\x1b]8;;\x07",
            b"\x1b]133;Z\x07",
            b"\x1b]133;\x07",
            b"\x1b]7;http://example.com/\x07",
            b"\x1b]7;file:///a\x01b\x07",
        ]);
        assert_eq!(signals(&found), [ShellSignal::Invalid; 4]);
    }

    #[test]
    fn an_oversized_payload_is_abandoned_without_buffering_it() {
        let mut long = b"\x1b]7;file:///".to_vec();
        long.extend(std::iter::repeat_n(b'a', MAX_PAYLOAD * 4));
        long.extend(b"\x07\x1b]133;A\x07");
        let mut scanner = OscScanner::new(None);
        let found = scanner.feed(&long);
        assert_eq!(
            signals(&found.into_iter().map(|(_, f)| f).collect::<Vec<_>>()),
            [ShellSignal::Prompt]
        );
        assert!(scanner.payload.capacity() <= MAX_PAYLOAD * 2);
    }

    #[test]
    fn an_escape_inside_an_osc_that_is_not_st_ends_it_unread() {
        let found = scan(&[b"\x1b]133;A\x1b[0m\x1b]133;B\x07"]);
        assert_eq!(signals(&found), [ShellSignal::Input]);
    }
}
