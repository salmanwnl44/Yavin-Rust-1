//! The Language Server Protocol's base protocol: messages framed by a `Content-Length` header.
//!
//! ```text
//! Content-Length: 52\r\n
//! \r\n
//! {"jsonrpc":"2.0","id":1,"method":"initialize",...}
//! ```
//!
//! This is the only part of LSP that lives natively: a server's stdout is a byte stream, and a
//! message can be split across reads -- or a multi-byte character across two messages' worth of
//! reads -- so the renderer is handed whole message bodies, each valid UTF-8, and does the JSON-RPC
//! itself. A stream that does not follow the framing cannot be resynchronized (there is no way to
//! know where the next message starts), so a malformed header is an error the caller ends the
//! session on rather than something to skip past.

/// The largest message a server may send. Real messages are kilobytes to a few megabytes (a
/// workspace-wide symbol list); anything past this is a runaway or a broken stream.
pub const MAX_MESSAGE: usize = 64 * 1024 * 1024;

/// The longest a header block may be before its blank line: a few short lines at most.
const MAX_HEADER: usize = 8 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    /// The header block is not `Name: value` lines ending in a blank line, or has no length.
    Malformed(String),
    /// A length over `MAX_MESSAGE`.
    TooLarge(usize),
    /// The body is not UTF-8, which JSON-RPC requires.
    NotUtf8,
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Malformed(why) => write!(f, "Malformed message header: {why}"),
            FrameError::TooLarge(size) => write!(f, "Message of {size} bytes is too large"),
            FrameError::NotUtf8 => write!(f, "Message body is not UTF-8"),
        }
    }
}

/// Reassembles messages from the chunks a pipe delivers.
#[derive(Default)]
pub struct FrameReader {
    buffer: Vec<u8>,
}

impl FrameReader {
    /// Adds `bytes` and returns every message now complete, in order. Bytes of an incomplete
    /// message are kept for the next call.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, FrameError> {
        self.buffer.extend_from_slice(bytes);
        let mut messages = Vec::new();
        loop {
            let Some(end) = find(&self.buffer, b"\r\n\r\n") else {
                if self.buffer.len() > MAX_HEADER {
                    return Err(FrameError::Malformed("no end of header".into()));
                }
                break;
            };
            let length = content_length(&self.buffer[..end])?;
            if length > MAX_MESSAGE {
                return Err(FrameError::TooLarge(length));
            }
            let start = end + 4;
            if self.buffer.len() < start + length {
                break;
            }
            let body = self.buffer[start..start + length].to_vec();
            self.buffer.drain(..start + length);
            messages.push(String::from_utf8(body).map_err(|_| FrameError::NotUtf8)?);
        }
        Ok(messages)
    }

    /// Bytes held that do not yet make a message: non-zero when a stream ended mid-message.
    pub fn pending(&self) -> usize {
        self.buffer.len()
    }
}

/// A message body with its header, ready to write to a server's stdin.
pub fn frame(body: &str) -> Vec<u8> {
    let mut bytes = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    bytes.extend_from_slice(body.as_bytes());
    bytes
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// The `Content-Length` of a header block. `Content-Type` is allowed and ignored (it is always
/// UTF-8 JSON in practice); any other line must still be `Name: value`.
fn content_length(header: &[u8]) -> Result<usize, FrameError> {
    let text = std::str::from_utf8(header)
        .map_err(|_| FrameError::Malformed("header is not ASCII".into()))?;
    let mut length = None;
    for line in text.split("\r\n") {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| FrameError::Malformed(format!("{line:?} is not a header")))?;
        if name.trim().eq_ignore_ascii_case("Content-Length") {
            length = Some(value.trim().parse::<usize>().map_err(|_| {
                FrameError::Malformed(format!("Content-Length {:?} is not a number", value.trim()))
            })?);
        }
    }
    length.ok_or_else(|| FrameError::Malformed("no Content-Length".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_framed_message_reads_back_as_it_was_written() {
        let body = r#"{"jsonrpc":"2.0","id":1,"result":"héllo ✓"}"#;
        let mut reader = FrameReader::default();
        assert_eq!(reader.push(&frame(body)).unwrap(), vec![body.to_string()]);
        assert_eq!(reader.pending(), 0);
    }

    #[test]
    fn messages_split_anywhere_and_run_together_come_out_whole_and_in_order() {
        let bodies = [r#"{"a":1}"#, r#"{"b":"ü"}"#, r#"{"c":[1,2,3]}"#];
        let stream: Vec<u8> = bodies.iter().flat_map(|body| frame(body)).collect();
        // Every split point, including inside the header and inside a multi-byte character.
        for cut in 0..stream.len() {
            let mut reader = FrameReader::default();
            let mut out = reader.push(&stream[..cut]).unwrap();
            out.extend(reader.push(&stream[cut..]).unwrap());
            assert_eq!(out, bodies.map(String::from), "split at {cut}");
        }
        // Byte by byte.
        let mut reader = FrameReader::default();
        let mut out = Vec::new();
        for byte in &stream {
            out.extend(reader.push(std::slice::from_ref(byte)).unwrap());
        }
        assert_eq!(out, bodies.map(String::from));
    }

    #[test]
    fn a_content_type_header_is_accepted_and_names_are_case_insensitive() {
        let mut reader = FrameReader::default();
        let message =
            b"content-length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}";
        assert_eq!(reader.push(message).unwrap(), vec!["{}".to_string()]);
    }

    #[test]
    fn a_broken_stream_is_an_error_not_something_skipped() {
        let error = |bytes: &[u8]| FrameReader::default().push(bytes).unwrap_err();
        assert!(matches!(
            error(b"Content-Length: x\r\n\r\n{}"),
            FrameError::Malformed(_)
        ));
        assert!(matches!(
            error(b"Hello\r\n\r\n{}"),
            FrameError::Malformed(_)
        ));
        assert!(matches!(
            error(b"Content-Type: json\r\n\r\n{}"),
            FrameError::Malformed(_)
        ));
        // A server printing a log line to stdout instead of stderr.
        assert!(matches!(
            error(b"Starting server...\nContent-Length: 2\r\n\r\n{}"),
            FrameError::Malformed(_)
        ));
        assert_eq!(
            error(b"Content-Length: 99999999999\r\n\r\n"),
            FrameError::TooLarge(99_999_999_999)
        );
        assert_eq!(
            error(b"Content-Length: 2\r\n\r\n\xff\xfe"),
            FrameError::NotUtf8
        );
        // Header garbage with no end at all is not waited on forever.
        assert!(matches!(
            error(&[b'x'; MAX_HEADER + 1]),
            FrameError::Malformed(_)
        ));
    }

    #[test]
    fn an_incomplete_message_waits_for_the_rest() {
        let mut reader = FrameReader::default();
        assert!(reader
            .push(b"Content-Length: 10\r\n\r\n{\"a\":")
            .unwrap()
            .is_empty());
        assert!(reader.pending() > 0);
        assert_eq!(
            reader.push(b"true}").unwrap(),
            vec![r#"{"a":true}"#.to_string()]
        );
    }
}
