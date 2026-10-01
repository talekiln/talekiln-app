//! JSON-RPC 2.0 dispatch (transport independent).

use serde_json::{json, Value};

pub const API_VERSIONS: &[u64] = &[1];
pub const NAME: &str = "lycore";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub const ERR_PARSE: i64 = -32700;
pub const ERR_INVALID_REQUEST: i64 = -32600;
pub const ERR_METHOD_NOT_FOUND: i64 = -32601;
pub const ERR_INVALID_PARAMS: i64 = -32602;
/// Application errors (implementation-defined range -32000..-32099).
pub const ERR_NOT_IMPLEMENTED: i64 = -32001;
pub const ERR_INCOMPATIBLE_VERSION: i64 = -32010;

fn err(id: Value, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut e = json!({ "code": code, "message": message });
    if let Some(d) = data {
        e["data"] = d;
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": e })
}

fn build_id() -> String {
    option_env!("LYCORE_BUILD")
        .unwrap_or(if cfg!(debug_assertions) { "dev-debug" } else { "dev-release" })
        .to_string()
}

fn hello(id: Value, params: &Value) -> Value {
    let supported = match params.get("apiVersions").and_then(|v| v.as_array()) {
        Some(a) if !a.is_empty() && a.iter().all(|x| x.is_u64()) => {
            a.iter().filter_map(|x| x.as_u64()).collect::<Vec<_>>()
        }
        _ => {
            return err(
                id,
                ERR_INVALID_PARAMS,
                "params.apiVersions must be a non-empty array of integers",
                None,
            )
        }
    };
    match API_VERSIONS.iter().rev().find(|v| supported.contains(v)) {
        Some(v) => json!({
            "jsonrpc": "2.0", "id": id,
            "result": { "name": NAME, "version": VERSION, "apiVersion": v, "build": build_id() }
        }),
        None => err(
            id,
            ERR_INCOMPATIBLE_VERSION,
            &format!(
                "incompatible API version: client supports {:?}, server supports {:?}",
                supported, API_VERSIONS
            ),
            Some(json!({ "serverApiVersions": API_VERSIONS, "clientApiVersions": supported })),
        ),
    }
}

/// Handle one raw request line; returns the response (None for notifications).
pub fn handle_line(line: &str) -> Option<Value> {
    let req: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return Some(err(Value::Null, ERR_PARSE, &format!("parse error: {e}"), None)),
    };
    if req.get("jsonrpc").and_then(|v| v.as_str()) != Some("2.0") {
        return Some(err(Value::Null, ERR_INVALID_REQUEST, "invalid request: jsonrpc must be \"2.0\"", None));
    }
    let Some(method) = req.get("method").and_then(|m| m.as_str()) else {
        return Some(err(Value::Null, ERR_INVALID_REQUEST, "invalid request: missing method", None));
    };
    let id = req.get("id").cloned();
    let params = req.get("params").cloned().unwrap_or(Value::Null);
    tracing::info!(method, "request");
    let id = id?; // notification: no response
    Some(match method {
        "core.hello" => hello(id, &params),
        "licence.status" | "media.probe" | "render.start" => {
            err(id, ERR_NOT_IMPLEMENTED, &format!("not implemented: {method}"), None)
        }
        _ => err(id, ERR_METHOD_NOT_FOUND, &format!("method not found: {method}"), None),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(s: &str) -> Value {
        handle_line(s).unwrap()
    }

    #[test]
    fn hello_ok() {
        let r = call(r#"{"jsonrpc":"2.0","id":1,"method":"core.hello","params":{"apiVersions":[1,2]}}"#);
        assert_eq!(r["result"]["apiVersion"], 1);
        assert_eq!(r["result"]["name"], "lycore");
    }

    #[test]
    fn hello_incompatible() {
        let r = call(r#"{"jsonrpc":"2.0","id":1,"method":"core.hello","params":{"apiVersions":[7]}}"#);
        assert_eq!(r["error"]["code"], ERR_INCOMPATIBLE_VERSION);
    }

    #[test]
    fn stubs_not_implemented() {
        let r = call(r#"{"jsonrpc":"2.0","id":1,"method":"render.start"}"#);
        assert_eq!(r["error"]["code"], ERR_NOT_IMPLEMENTED);
    }

    #[test]
    fn notification_and_parse_error() {
        assert!(handle_line(r#"{"jsonrpc":"2.0","method":"core.hello"}"#).is_none());
        assert_eq!(call("{bad")["error"]["code"], ERR_PARSE);
    }
}
