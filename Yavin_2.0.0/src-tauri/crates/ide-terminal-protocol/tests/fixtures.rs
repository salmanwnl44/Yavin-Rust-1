//! The wire forms both halves of the Terminal contract share
//! (`src/services/terminalProtocol.fixtures.json`): every valid form reads to the expected
//! values and writes back identically; every invalid one is refused.

use ide_terminal_protocol::*;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

fn fixtures() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../src/services/terminalProtocol.fixtures.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn list<'a>(fixtures: &'a Value, key: &str) -> &'a Vec<Value> {
    fixtures[key].as_array().unwrap_or_else(|| panic!("{key}"))
}

/// Reads `wire` as `T` and writes it back: the result must be the same JSON.
fn round_trip<T: DeserializeOwned + Serialize>(wire: &Value) -> T {
    let value: T = serde_json::from_value(wire.clone()).unwrap_or_else(|e| panic!("{wire}: {e}"));
    assert_eq!(&serde_json::to_value(&value).unwrap(), wire);
    value
}

fn refused<T: DeserializeOwned>(wire: &Value) {
    assert!(
        serde_json::from_value::<T>(wire.clone()).is_err(),
        "accepted {wire}"
    );
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn the_state_machine_matches_the_shared_table() {
    let table = &fixtures()["transitions"];
    for from in TerminalState::ALL {
        let name = format!("{from:?}");
        let allowed: Vec<String> = serde_json::from_value(table[&name].clone()).unwrap();
        for to in TerminalState::ALL {
            assert_eq!(
                from.can_transition(to),
                allowed.contains(&format!("{to:?}")),
                "{from:?} -> {to:?}"
            );
        }
    }
}

#[test]
fn output_chunks_carry_exactly_their_bytes() {
    let f = fixtures();
    for case in list(&f, "outputChunks") {
        let chunk: TerminalOutputChunk = round_trip(&case["wire"]);
        assert_eq!(
            hex(&chunk.bytes),
            case["hex"].as_str().unwrap(),
            "{}",
            case["about"]
        );
    }
    for wire in list(&f, "invalidOutputChunks") {
        refused::<TerminalOutputChunk>(wire);
    }
}

#[test]
fn every_byte_value_survives_the_wire() {
    let bytes: Vec<u8> = (0..=255).collect();
    let mut out = OutputSequencer::new(TerminalId::new("t").unwrap(), FIRST_GENERATION);
    let chunk = out.chunk(bytes.clone());
    let back: TerminalOutputChunk =
        serde_json::from_str(&serde_json::to_string(&chunk).unwrap()).unwrap();
    assert_eq!(back.bytes, bytes);
    assert_eq!(
        serde_json::to_value(&chunk).unwrap()["bytes"],
        encode_bytes(&bytes)
    );
}

#[test]
fn lifecycle_events_read_and_write_back_identically() {
    let f = fixtures();
    for wire in list(&f, "stateChanges") {
        round_trip::<TerminalStateChanged>(wire);
    }
    for wire in list(&f, "invalidStateChanges") {
        refused::<TerminalStateChanged>(wire);
    }
    for wire in list(&f, "exits") {
        round_trip::<TerminalExit>(wire);
    }
    for wire in list(&f, "invalidExits") {
        refused::<TerminalExit>(wire);
    }
    for wire in list(&f, "errorEvents") {
        round_trip::<TerminalErrorEvent>(wire);
    }
    for wire in list(&f, "invalidErrorEvents") {
        refused::<TerminalErrorEvent>(wire);
    }
}

#[test]
fn every_error_cause_reads_and_writes_its_wire_form() {
    let f = fixtures();
    let errors = list(&f, "errors");
    let codes: Vec<&str> = errors.iter().map(|e| e["code"].as_str().unwrap()).collect();
    let all: Vec<String> = TerminalErrorCause::ALL
        .iter()
        .map(|c| format!("{c:?}"))
        .collect();
    assert_eq!(codes, all);
    for case in errors {
        let wire = case["wire"].as_str().unwrap();
        let error = TerminalError::parse_wire(wire).unwrap_or_else(|| panic!("{wire}"));
        assert_eq!(format!("{:?}", error.code), case["code"].as_str().unwrap());
        assert_eq!(error.message, case["message"].as_str().unwrap());
        assert_eq!(error.to_string(), wire);
        let json = serde_json::json!({ "code": case["code"], "message": case["message"] });
        assert_eq!(round_trip::<TerminalError>(&json), error);
    }
    for raw in list(&f, "unrecognisedErrors") {
        assert_eq!(
            TerminalError::parse_wire(raw.as_str().unwrap()),
            None,
            "{raw}"
        );
    }
}

#[test]
fn dimensions_are_whole_cells_from_one_to_a_thousand() {
    let f = fixtures();
    for wire in list(&f["dimensions"], "valid") {
        round_trip::<TerminalDimensions>(wire);
    }
    for wire in list(&f["dimensions"], "invalid") {
        refused::<TerminalDimensions>(wire);
    }
}

#[test]
fn profiles_keep_every_field_in_order() {
    let f = fixtures();
    for wire in list(&f, "profiles") {
        let profile: TerminalProfile = round_trip(wire);
        profile.validate().unwrap();
    }
    for wire in list(&f, "invalidProfiles") {
        let profile: TerminalProfile = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(
            profile.validate().unwrap_err().code,
            TerminalErrorCause::ProtocolError,
            "{wire}"
        );
    }
}

#[test]
fn requests_and_sessions_keep_their_identity() {
    let f = fixtures();
    let open: TerminalOpenRequest = round_trip(&f["openRequest"]);
    assert_eq!(open.session_id.as_str(), "terminal-a1-1");
    assert_eq!(open.workspace_id, "file://c:/work");
    let session: TerminalSession = round_trip(&f["session"]);
    assert_eq!(session.metadata.workspace_id, open.workspace_id);
    assert_eq!(session.runtime.state, TerminalState::Running);
    assert_ne!(
        TerminalId::new("terminal-a1-1").unwrap(),
        TerminalId::new("terminal-a1-2").unwrap()
    );
}

#[test]
fn every_message_a_subscriber_receives_reads_and_writes_back_identically() {
    let f = fixtures();
    let kinds: Vec<&str> = list(&f, "messages")
        .iter()
        .map(|m| m["kind"].as_str().unwrap())
        .collect();
    assert_eq!(
        kinds,
        ["output", "state", "state", "exit", "error", "detached", "shell", "shell", "shell"]
    );
    for wire in list(&f, "messages") {
        let message: TerminalMessage = round_trip(wire);
        assert_eq!(message.session_id().as_str(), "terminal-a1-1");
    }
    for wire in list(&f, "invalidMessages") {
        refused::<TerminalMessage>(wire);
    }
}

#[test]
fn acknowledgements_and_subscriptions_name_their_subscriber() {
    let f = fixtures();
    let ack: TerminalAckRequest = round_trip(&f["ackRequest"]);
    assert_eq!(ack.subscription_id.as_str(), "sub-1");
    assert_eq!(ack.seq.get(), 12);
    let subscribe: TerminalSubscribeRequest = round_trip(&f["subscribeRequest"]);
    assert_eq!(subscribe.subscription_id.as_str(), "sub-2");
}
