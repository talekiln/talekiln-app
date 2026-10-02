//! 授权校验（licence.status）：校验云端用 ES256 签发的 JWT 授权令牌。
//!
//! 令牌声明见 packages/cloud/src/services/licence.service.ts：
//! `sub`(accountId) `did`(deviceId) `plan` `entitlements` `graceDays` `exp` `iat` `iss`，
//! 头部 `alg=ES256`、`kid`。公钥由客户端以 JWKS（`.well-known/licence-jwks.json`）或单个 JWK 传入，
//! lycore 不联网、不保存公钥。
//!
//! 时间规则（`now` 默认取系统时钟，可由 `nowSec` 覆盖以便测试与时钟校正）：
//! - `nbf`（若有）晚于 now：`not_yet_valid`，无效；
//! - `now <= exp`：有效，`reason = "ok"`；
//! - `exp < now <= exp + 宽限`：离线宽限期，仍有效，`reason = "grace"`；
//! - 超出宽限：无效，`reason = "expired"`。
//!
//! 宽限天数优先取参数 `graceDays`，其次取令牌声明 `graceDays`，最后默认 14 天。
//! 校验失败一律返回 `valid:false` 和机器可读的 `reason`，不抛 RPC 错误；
//! 只有参数结构错误（缺 `jwks`/`publicKey`）才返回 -32602。

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use p256::ecdsa::signature::hazmat::PrehashVerifier;
use p256::ecdsa::{Signature, VerifyingKey};
use serde_json::{json, Value};

pub const DEFAULT_GRACE_DAYS: u64 = 14;
const DAY: i64 = 86_400;

fn b64(s: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(s.trim_end_matches('=')).ok()
}

/// 把 EC P-256 JWK 转为验证密钥。
fn key_from_jwk(jwk: &Value) -> Option<VerifyingKey> {
    if jwk.get("kty")?.as_str()? != "EC" || jwk.get("crv")?.as_str()? != "P-256" {
        return None;
    }
    let x = b64(jwk.get("x")?.as_str()?)?;
    let y = b64(jwk.get("y")?.as_str()?)?;
    if x.len() != 32 || y.len() != 32 {
        return None;
    }
    let mut sec1 = vec![0x04u8];
    sec1.extend_from_slice(&x);
    sec1.extend_from_slice(&y);
    VerifyingKey::from_sec1_bytes(&sec1).ok()
}

fn fail(reason: &str) -> Value {
    json!({ "valid": false, "plan": null, "expires": null, "reason": reason })
}

fn now_sec() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn iso(sec: i64) -> String {
    // 无 chrono 依赖：手写 UTC 公历转换（Howard Hinnant 算法）。
    let days = sec.div_euclid(DAY);
    let rem = sec.rem_euclid(DAY);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

pub fn status(params: &Value) -> Result<Value, String> {
    // 密钥集合：jwks.keys[] 或单个 publicKey（JWK）。
    let keys: Vec<Value> = if let Some(k) = params.get("jwks").and_then(|j| j.get("keys")).and_then(|k| k.as_array()) {
        k.clone()
    } else if let Some(k) = params.get("publicKey").filter(|k| k.is_object()) {
        vec![k.clone()]
    } else {
        return Err("params.jwks ({keys:[...]}) or params.publicKey (JWK) is required".into());
    };
    let Some(token) = params.get("token").and_then(|t| t.as_str()).filter(|t| !t.is_empty()) else {
        return Ok(fail("no_token"));
    };

    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Ok(fail("malformed"));
    }
    let (Some(h), Some(p), Some(sig)) = (b64(parts[0]), b64(parts[1]), b64(parts[2])) else {
        return Ok(fail("malformed"));
    };
    let (Ok(header), Ok(claims)) = (serde_json::from_slice::<Value>(&h), serde_json::from_slice::<Value>(&p)) else {
        return Ok(fail("malformed"));
    };
    // 只接受 ES256，拒绝 none/HS256 等降级。
    if header.get("alg").and_then(|a| a.as_str()) != Some("ES256") {
        return Ok(fail("unsupported_alg"));
    }
    let Ok(sig) = Signature::from_slice(&sig) else {
        return Ok(fail("bad_signature"));
    };

    // 选 key：头部有 kid 则必须匹配；否则逐个尝试。
    let kid = header.get("kid").and_then(|k| k.as_str());
    let candidates: Vec<&Value> = keys
        .iter()
        .filter(|k| match kid {
            Some(id) => k.get("kid").and_then(|v| v.as_str()) == Some(id),
            None => true,
        })
        .collect();
    if candidates.is_empty() {
        return Ok(fail("unknown_kid"));
    }
    let mut digest = crate::sha256::Sha256::new();
    digest.update(format!("{}.{}", parts[0], parts[1]).as_bytes());
    let digest = digest.finish_bytes();
    let verified = candidates
        .iter()
        .filter_map(|k| key_from_jwk(k))
        .any(|vk| vk.verify_prehash(&digest, &sig).is_ok());
    if !verified {
        return Ok(fail("bad_signature"));
    }

    // 签名通过后再看声明。
    if let Some(want) = params.get("issuer").and_then(|i| i.as_str()) {
        if claims.get("iss").and_then(|i| i.as_str()) != Some(want) {
            return Ok(fail("issuer_mismatch"));
        }
    }
    let Some(exp) = claims.get("exp").and_then(|e| e.as_i64()) else {
        return Ok(fail("missing_exp"));
    };
    let now = params.get("nowSec").and_then(|n| n.as_i64()).unwrap_or_else(now_sec);
    let plan = claims.get("plan").cloned().unwrap_or(Value::Null);
    let grace_days = params
        .get("graceDays")
        .and_then(|g| g.as_u64())
        .or_else(|| claims.get("graceDays").and_then(|g| g.as_u64()))
        .unwrap_or(DEFAULT_GRACE_DAYS);
    let grace_end = exp.saturating_add((grace_days.min(36_500) as i64) * DAY);
    let base = |valid: bool, reason: &str| {
        json!({
            "valid": valid, "plan": plan, "expires": iso(exp), "reason": reason,
            "expiresAt": exp, "graceEndsAt": grace_end,
            "entitlements": claims.get("entitlements").cloned().unwrap_or(json!([])),
            "accountId": claims.get("sub").cloned().unwrap_or(Value::Null),
            "deviceId": claims.get("did").cloned().unwrap_or(Value::Null),
        })
    };

    if let Some(nbf) = claims.get("nbf").and_then(|n| n.as_i64()) {
        if now < nbf {
            return Ok(base(false, "not_yet_valid"));
        }
    }
    Ok(if now <= exp {
        base(true, "ok")
    } else if now <= grace_end {
        base(true, "grace")
    } else {
        base(false, "expired")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::hazmat::PrehashSigner, SigningKey};

    // 固定测试私钥（仅用于单元测试，非任何真实密钥）。
    fn sk(seed: u8) -> SigningKey {
        SigningKey::from_slice(&[seed; 32]).unwrap()
    }

    fn jwk(sk: &SigningKey, kid: &str) -> Value {
        let pt = sk.verifying_key().to_sec1_bytes();
        json!({ "kty":"EC","crv":"P-256","kid":kid,"alg":"ES256","use":"sig",
                "x": URL_SAFE_NO_PAD.encode(&pt[1..33]), "y": URL_SAFE_NO_PAD.encode(&pt[33..65]) })
    }

    fn sign(sk: &SigningKey, header: Value, claims: Value) -> String {
        let h = URL_SAFE_NO_PAD.encode(header.to_string());
        let p = URL_SAFE_NO_PAD.encode(claims.to_string());
        let mut d = crate::sha256::Sha256::new();
        d.update(format!("{h}.{p}").as_bytes());
        let sig: Signature = sk.sign_prehash(&d.finish_bytes()).unwrap();
        format!("{h}.{p}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
    }

    const EXP: i64 = 1_800_000_000;

    fn tok(sk: &SigningKey) -> String {
        sign(
            sk,
            json!({"alg":"ES256","kid":"k1","typ":"JWT"}),
            json!({"sub":"acc1","did":"dev1","plan":"test","entitlements":["generate"],"graceDays":14,"exp":EXP,"iat":EXP-3600,"iss":"talekiln"}),
        )
    }

    fn run(token: &str, keys: Value, now: i64, extra: Value) -> Value {
        let mut p = json!({"token":token,"jwks":{"keys":keys},"nowSec":now});
        for (k, v) in extra.as_object().cloned().unwrap_or_default() {
            p[k] = v;
        }
        status(&p).unwrap()
    }

    #[test]
    fn valid_token() {
        let k = sk(7);
        let r = run(&tok(&k), json!([jwk(&k, "k1")]), EXP - 10, json!({}));
        assert_eq!(r["valid"], true);
        assert_eq!(r["reason"], "ok");
        assert_eq!(r["plan"], "test");
        assert_eq!(r["expires"], "2027-01-15T08:00:00Z");
        assert_eq!(r["entitlements"][0], "generate");
        assert_eq!(r["accountId"], "acc1");
    }

    #[test]
    fn iso_epoch() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn grace_window_boundaries() {
        let k = sk(7);
        let t = tok(&k);
        let keys = json!([jwk(&k, "k1")]);
        let rv = |now: i64, extra: Value| {
            let r = run(&t, keys.clone(), now, extra);
            (r["valid"].as_bool().unwrap(), r["reason"].as_str().unwrap().to_string())
        };
        assert_eq!(rv(EXP, json!({})), (true, "ok".into()));
        assert_eq!(rv(EXP + 1, json!({})), (true, "grace".into()));
        assert_eq!(rv(EXP + 14 * DAY, json!({})), (true, "grace".into()));
        assert_eq!(rv(EXP + 14 * DAY + 1, json!({})), (false, "expired".into()));
        // 参数覆盖宽限天数
        assert_eq!(rv(EXP + 2 * DAY, json!({"graceDays":1})), (false, "expired".into()));
        assert_eq!(rv(EXP + 1, json!({"graceDays":0})), (false, "expired".into()));
    }

    #[test]
    fn nbf_in_future() {
        let k = sk(7);
        let t = sign(&k, json!({"alg":"ES256","kid":"k1"}), json!({"plan":"test","exp":EXP,"nbf":EXP-100}));
        let keys = json!([jwk(&k, "k1")]);
        assert_eq!(run(&t, keys.clone(), EXP - 200, json!({}))["reason"], "not_yet_valid");
        assert_eq!(run(&t, keys, EXP - 100, json!({}))["valid"], true);
    }

    #[test]
    fn wrong_key_and_tamper() {
        let (k, other) = (sk(7), sk(9));
        let t = tok(&k);
        assert_eq!(run(&t, json!([jwk(&other, "k1")]), EXP - 1, json!({}))["reason"], "bad_signature");
        // 篡改载荷（改 plan 与 exp）
        let mut parts: Vec<String> = t.split('.').map(String::from).collect();
        parts[1] = URL_SAFE_NO_PAD.encode(json!({"plan":"pro","exp":EXP+999999,"iss":"talekiln"}).to_string());
        let r = run(&parts.join("."), json!([jwk(&k, "k1")]), EXP - 1, json!({}));
        assert_eq!(r["valid"], false);
        assert_eq!(r["reason"], "bad_signature");
    }

    #[test]
    fn kid_and_alg_rules() {
        let k = sk(7);
        assert_eq!(run(&tok(&k), json!([jwk(&k, "other")]), EXP - 1, json!({}))["reason"], "unknown_kid");
        // 无 kid 时逐个尝试
        let t = sign(&k, json!({"alg":"ES256"}), json!({"plan":"test","exp":EXP}));
        assert_eq!(run(&t, json!([jwk(&sk(3), "a"), jwk(&k, "b")]), EXP - 1, json!({}))["valid"], true);
        // alg=none / HS256
        for alg in ["none", "HS256"] {
            let t = sign(&k, json!({"alg":alg,"kid":"k1"}), json!({"plan":"test","exp":EXP}));
            assert_eq!(run(&t, json!([jwk(&k, "k1")]), EXP - 1, json!({}))["reason"], "unsupported_alg");
        }
    }

    #[test]
    fn issuer_and_malformed() {
        let k = sk(7);
        let keys = json!([jwk(&k, "k1")]);
        assert_eq!(run(&tok(&k), keys.clone(), EXP - 1, json!({"issuer":"evil"}))["reason"], "issuer_mismatch");
        assert_eq!(run(&tok(&k), keys.clone(), EXP - 1, json!({"issuer":"talekiln"}))["valid"], true);
        for bad in ["", "a.b", "a.b.c", "!!.!!.!!"] {
            let r = run(bad, keys.clone(), 0, json!({}));
            assert_eq!(r["valid"], false, "{bad}");
        }
        assert_eq!(run("a.b", keys, 0, json!({}))["reason"], "malformed");
    }

    #[test]
    fn needs_key_param_and_accepts_single_jwk() {
        assert!(status(&json!({"token":"x"})).is_err());
        let k = sk(7);
        let p = json!({"token":tok(&k),"publicKey":jwk(&k,"k1"),"nowSec":EXP-1});
        assert_eq!(status(&p).unwrap()["valid"], true);
    }
}
