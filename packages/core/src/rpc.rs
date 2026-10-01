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

fn ff_result(id: Value, r: Result<Value, crate::ffmpeg::FfError>) -> Value {
    match r {
        Ok(v) => json!({ "jsonrpc": "2.0", "id": id, "result": v }),
        Err(e) => err(id, e.code, &e.message, e.data),
    }
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
pub async fn handle_line(line: &str) -> Option<Value> {
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
        "media.probe" => ff_result(id, crate::media::probe(&params).await),
        "encoder.detect" => ff_result(id, crate::encoder::detect(&params).await),
        "licence.status" | "render.start" => {
            err(id, ERR_NOT_IMPLEMENTED, &format!("not implemented: {method}"), None)
        }
        _ => err(id, ERR_METHOD_NOT_FOUND, &format!("method not found: {method}"), None),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn call(s: &str) -> Value {
        handle_line(s).await.unwrap()
    }

    #[tokio::test]
    async fn hello_ok() {
        let r = call(r#"{"jsonrpc":"2.0","id":1,"method":"core.hello","params":{"apiVersions":[1,2]}}"#).await;
        assert_eq!(r["result"]["apiVersion"], 1);
        assert_eq!(r["result"]["name"], "lycore");
    }

    #[tokio::test]
    async fn hello_incompatible() {
        let r = call(r#"{"jsonrpc":"2.0","id":1,"method":"core.hello","params":{"apiVersions":[7]}}"#).await;
        assert_eq!(r["error"]["code"], ERR_INCOMPATIBLE_VERSION);
    }

    #[tokio::test]
    async fn stubs_not_implemented() {
        let r = call(r#"{"jsonrpc":"2.0","id":1,"method":"render.start"}"#).await;
        assert_eq!(r["error"]["code"], ERR_NOT_IMPLEMENTED);
    }

    #[tokio::test]
    async fn notification_and_parse_error() {
        assert!(handle_line(r#"{"jsonrpc":"2.0","method":"core.hello"}"#).await.is_none());
        assert_eq!(call("{bad").await["error"]["code"], ERR_PARSE);
    }

    #[tokio::test]
    async fn ffmpeg_missing_is_recoverable_error() {
        for (m, tool) in [("media.probe", "ffprobe"), ("encoder.detect", "ffmpeg")] {
            let req = json!({"jsonrpc":"2.0","id":1,"method":m,"params":{"path":"x.mp4","ffmpegDir":"/nonexistent-lycore-dir"}});
            let r = call(&req.to_string()).await;
            assert_eq!(r["error"]["code"], crate::ffmpeg::ERR_FFMPEG_MISSING);
            assert_eq!(r["error"]["data"]["recoverable"], true);
            assert_eq!(r["error"]["data"]["action"], "reinstall");
            assert_eq!(r["error"]["data"]["tool"], tool);
        }
    }

    #[tokio::test]
    async fn probe_requires_path() {
        let r = call(r#"{"jsonrpc":"2.0","id":1,"method":"media.probe","params":{}}"#).await;
        assert_eq!(r["error"]["code"], ERR_INVALID_PARAMS);
    }
}
