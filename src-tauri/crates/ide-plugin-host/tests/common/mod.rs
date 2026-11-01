//! The real `yavin-extension-host` process, driven over its framed protocol (shared by the
//! host tests).
#![allow(dead_code)]

use ide_workspace::lsp_framing::{frame, FrameReader};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::Duration;

pub struct Host {
    pub child: Child,
    pub stdin: ChildStdin,
    pub messages: Receiver<Value>,
}

pub const WS: &str = "file://c:/work";

impl Host {
    pub fn start() -> Host {
        Host::start_with(json!({"memoryBytes": 16 * 1024 * 1024, "loadMs": 2000, "callMs": 500}))
    }
    pub fn start_with(limits: Value) -> Host {
        let mut child = Command::new(env!("CARGO_BIN_EXE_yavin-extension-host"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("the host starts");
        let stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let (sender, messages) = channel();
        std::thread::spawn(move || {
            let mut reader = FrameReader::default();
            let mut buffer = vec![0u8; 65536];
            while let Ok(count) = stdout.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                for text in reader.push(&buffer[..count]).unwrap_or_default() {
                    let _ = sender.send(serde_json::from_str::<Value>(&text).unwrap());
                }
            }
        });
        let mut host = Host {
            child,
            stdin,
            messages,
        };
        host.send(json!({"type": "init", "workspaceId": WS, "hostGeneration": 3, "workspaceFolder": "C:/work", "apiVersion": "2.0.0", "limits": limits}));
        assert_eq!(host.recv()["type"], "ready");
        host
    }
    pub fn send(&mut self, message: Value) {
        self.send_text(&message.to_string());
    }
    pub fn send_text(&mut self, text: &str) {
        self.stdin.write_all(&frame(text)).unwrap();
        self.stdin.flush().unwrap();
    }
    pub fn recv(&self) -> Value {
        self.messages
            .recv_timeout(Duration::from_secs(10))
            .expect("the host answers")
    }
    /// The next message satisfying `wanted` (others are skipped).
    pub fn until(&self, wanted: impl Fn(&Value) -> bool) -> Value {
        loop {
            let message = self.recv();
            if wanted(&message) {
                return message;
            }
        }
    }
    pub fn to(&mut self, extension: &str, mut message: Value) {
        let object = message.as_object_mut().unwrap();
        object.insert("extensionId".into(), json!(extension));
        object.insert("workspaceId".into(), json!(WS));
        object.insert("hostGeneration".into(), json!(3));
        self.send(message);
    }
    pub fn load(&mut self, extension: &str, code: &str) -> Value {
        self.to(
            extension,
            json!({"type": "load", "code": code, "extensionPath": "C:/ext"}),
        );
        self.until(|m| m["type"] == "loaded" || m["type"] == "error")
    }
    /// Yavin asks the extension; every request it makes meanwhile is answered `ok` with `answer`.
    pub fn ask(
        &mut self,
        extension: &str,
        id: &str,
        method: &str,
        params: Value,
        answer: Value,
    ) -> Value {
        self.to(
            extension,
            json!({"type": "request", "requestId": id, "method": method, "params": params}),
        );
        loop {
            let message = self.recv();
            if message["type"] == "request" {
                let request_id = message["requestId"].clone();
                self.to(extension, json!({"type": "response", "requestId": request_id, "ok": true, "result": answer}));
                continue;
            }
            if message["type"] == "response" && message["requestId"] == json!(id) {
                return message;
            }
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}
