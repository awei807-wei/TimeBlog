# Security Review — TimeBlog `services/core` (Auth / Session / Secrets / Recovery)

**Reviewer:** teammate `auth-security`
**Mode:** read-only (no files modified)
**Date:** 2026-08-24

## Scope Reviewed

- `services/core/auth_handlers.go`
- `services/core/password.go`
- `services/core/secrets.go`
- `services/core/config_secrets.go`
- `services/core/security_recovery_handlers.go`
- `services/core/security_recovery_protocol.go`
- `services/core/security_recovery_key_persistence.go`
- `services/core/security_recovery_persistence.go`
- `services/core/account_recovery.go`
- `services/core/account_recovery_persistence.go`
- `services/core/recovery_protocol.go`
- `services/core/recovery_cli.go`, `recovery_cli_store.go`, `recovery_cli_output.go`
- `services/core/auth_operation_persistence.go`
- `services/core/admin_extra_handlers.go`
- `services/core/server.go`
- Supporting helpers: `services/core/platform.go`, `services/core/domain.go`

---

## CRITICAL

### [C1] TOTP replay gap on the primary login flow (no step replay guard)

**File:** `services/core/auth_handlers.go:313-345`

The login TOTP step validates the code with `totp.Validate(...)` and then consumes the *challenge*, but it never records the TOTP *step* that was used. The recovery paths are hardened against this via `totp_replay_guards` + `verifyTOTPFactor` (`security_recovery_persistence.go:55-71`, `loadAndLockTOTPReplayStep:26-35`), but the main login path is not.

**Exact vulnerable lines:**

```go
// auth_handlers.go:313
validCode = totp.Validate(in.Code, plain)

// auth_handlers.go:317
validCode = srv.store.userTOTP != "" && totp.Validate(in.Code, srv.store.userTOTP)
```

**Consequence:** A captured valid TOTP code can be replayed to mint unlimited sessions within its 30s validity window. `loginPassword` (`auth_handlers.go:233-273`) issues a fresh challenge on every call and is unauthenticated (only throttled), so an attacker holding one TOTP code can repeatedly call `login/password` → `login/totp` to create unbounded sessions.

**Fix:** Apply the same step-based replay guard used by the recovery paths — compute `totpStepForTime`, persist `last_used_step` per user, and reject any code whose step ≤ last_used_step. Additionally make challenge consumption atomic (single `UPDATE ... RETURNING` / delete) instead of the current check-then-consume (lines 326-339), which is racy: a concurrent request can pass `challengeValid` and then both fail the consume after both validated the same code.

---

## HIGH

### [H1] Argon2id password-hashing parameters are weak/low

**File:** `services/core/password.go:18,35`

```go
key := argon2.IDKey([]byte(password), salt, 3, 64*1024, 2, 32)              // line 18
actual := argon2.IDKey([]byte(password), salt, 3, 64*1024, 2, uint32(len(expected))) // line 35
```

Parameters: m=64 MiB, t=3, p=2. For a single-owner admin account this is on the low end; OWASP recommends Argon2id m=19456 KiB / t=2 / p=1 as a minimum, and higher-security deployments use more. t=3 with m=64MiB is borderline.

**Fix:** Raise cost (e.g. `argon2.IDKey(password, salt, 4, 128*1024, 2, 32)`) and make params versioned in the stored string so they can be raised later. (Note: salt is 16 bytes from crypto/rand and comparison is constant-time at line 36 — those parts are correct.)

### [H2] In-memory (non-persistent) password comparison is not constant-time

**Files:**
- `auth_handlers.go:253` — `} else if srv.store.userPassword == "" || in.Password != srv.store.userPassword {`
- `security_recovery_key_persistence.go:119` — `if in.Password != srv.store.userPassword {`
- `security_recovery_persistence.go:246` — `if in.CurrentPassword != srv.store.userPassword {`

Memory mode compares plaintext passwords with Go's `!=` (early-exit string compare), enabling a timing side channel. This is dev/local mode only, but should still be hardened.

**Fix:** use `subtle.ConstantTimeCompare` (as `verifyPassword` already does) even in memory mode.

---

## MEDIUM

### [M1] Rate-limit / throttle IP trust is spoofable when TRUSTED_PROXY_CIDRS is misconfigured

**File:** `auth_handlers.go:27-43,45-57,72-77`

`requestRemoteIP` trusts `X-Forwarded-For` only from IPs in `TRUSTED_PROXY_CIDRS` (`trustedProxy`). `recoveryThrottleDimensions` adds account-only + IP-only wildcard buckets (mitigates spreading across accounts/IPs).

**Risk:** If `TRUSTED_PROXY_CIDRS` is empty or overly broad, an attacker can spoof `X-Forwarded-For` to rotate the per-IP bucket, defeating per-IP brute-force throttling. The account-only wildcard bucket limits account-wide guessing, but per-IP limits are weakened.

**Fix:** Verify `TRUSTED_PROXY_CIDRS` is tightly scoped to the actual reverse proxy; consider falling back to `RemoteAddr` when no trusted proxy is configured.

### [M2] Session cookie Secure flag is environment-dependent

**Files:**
- `auth_handlers.go:368-369` — `secure := os.Getenv("APP_ENV") == "production"` then SetCookie `timeline_session` with `Secure: secure`.
- `auth_handlers.go:396` (logout) and `security_recovery_handlers.go:221` (`clearTimelineSessionCookie`) — same pattern.

In any deployment where `APP_ENV != "production"` but the app is Internet-facing, the session cookie is sent over plaintext HTTP.

**Fix:** require an explicit env (or default Secure=true) for any non-loopback deployment; consider the `__Host-` cookie prefix to harden against subdomain cookie injection. CSRF is otherwise solid (double-submit `X-CSRF-Token` header + Origin check).

### [M3] CSRF key falls back to a deterministic constant

**File:** `platform.go:126-131`

```go
key := make([]byte, 32)
if _, err := rand.Read(key); err != nil {
    h := sha256.Sum256([]byte("timeblog/csrf/fallback"))
    return h[:]
}
```

If `crypto/rand.Read` fails, it returns a hardcoded, predictable key — every CSRF token becomes predictable and CSRF protection is silently disabled.

**Fix:** propagate the error and refuse to start rather than degrade to a constant.

### [M4] Memory-mode stores plaintext credentials

**File:** `domain.go:142`

```go
userPassword: getenv("ADMIN_PASSWORD",""),
userTOTP: getenv("ADMIN_TOTP_SECRET",""),
recoveryKeyHash: getenv("ACCOUNT_RECOVERY_KEY_HASH",""),
```

Dev/memory mode keeps plaintext password and TOTP secret in process memory. Acceptable for local dev, but document that memory mode is never for production; production requires the DB-backed persistent store.

---

## LOW

### [L1] MFA challenge issuance is not rate-limited per successful completion on login

**File:** `auth_handlers.go:259`

`loginPassword` issues a fresh MFA challenge on every successful password login (`throttleSuccess` clears the bucket). Combined with C1 this enables challenge spam; even without C1, an attacker with the password can mint unbounded challenges. Consider rate-limiting challenge issuance separately from code verification.

### [L2] resolveEmbed only checks the hostname before provider matching

**File:** `admin_extra_handlers.go:1604-1626`

It blocks private/loopback/link-local IPs (good) but does not follow redirects or fully guard DNS rebinding. Acceptable for an admin-only endpoint; note as defense-in-depth.

### [L3] newID fallback uses timestamp on rand failure

**File:** `domain.go:160-166`

`newID` falls back to `time.Now().UnixNano()` if `rand.Read` fails — predictable IDs in a rare failure path. Fail hard instead.

---

## CLEAN-CHECKED LIST (no issues found)

- **Password hashing:** crypto/rand 16-byte salt, Argon2id, constant-time verify (`password.go`) — good (only params need raising, H1).
- **Session token generation:** `randomToken` uses crypto/rand 24 bytes (`platform.go:105`), stored as SHA-256 hash (`tokenHash` `platform.go:103`) — good. New token per login (no fixation). Idle 30d / absolute 90d expiry enforced in DB + memory.
- **Session revocation:** logout, revoke-others, revoke-by-id, password-change, password-reset, recovery-key-rotation all revoke sessions — good.
- **TOTP/2FA bypass (recovery paths):** constant-time compare (`security_recovery_protocol.go:167`), step-based replay guard, ±1-step skew handled correctly, `FOR UPDATE` row locking — good. (Login-path gap = C1.)
- **Timing attacks:** `verifyPassword` and TOTP/HMAC compares are constant-time (`password.go:36`, `security_recovery_protocol.go:167`, `hmac.Equal`). Only memory-mode password `!=` is the gap (H2).
- **Secrets:** `TOTP_ENCRYPTION_KEY` / `CONFIG_ENCRYPTION_KEY` must be 32-byte base64 (`secrets.go:12-19`, `config_secrets.go:16-23`); AES-256-GCM with fresh random nonce (`secrets.go:33-38`, `config_secrets.go:38-44`); no hardcoded keys; no secrets logged (only event names). Config secrets use a versioned envelope + AAD scope (`config_secrets.go`) — good.
- **Recovery key entropy:** all generation uses crypto/rand (`recovery_cli.go:221-227`, `security_recovery_protocol.go:123-129`, `randomToken`). No `math/rand` anywhere.
- **Weak crypto:** none. Only SHA-256 / HMAC-SHA256 / AES-256-GCM / Argon2id; TOTP uses SHA1 which is standard for TOTP.
- **CORS / headers:** `originAllowed` is strict (production requires exact `APP_ORIGIN`, `server.go:211-224`); `withCORS` sets nosniff, Referrer-Policy, CSP, X-Frame-Options, Permissions-Policy, HSTS (prod), `Vary: Origin`, allow-credentials only for allowed origin (`server.go:277-305`) — good.
- **CSRF:** Origin check + `X-CSRF-Token` double-submit bound to session via HMAC (`server.go:226-264`) — good, except the deterministic fallback (M3).
- **Admin path/parameter tampering:** `taxonomyCategory`/`taxonomyTag` parse id from path and use parameterized queries with `$n::uuid` casts (`admin_extra_handlers.go:1204,1222,1309,1328`) — no SQLi. `exportDownload` serves only the DB-returned `storage_path` for the authenticated owner (`admin_extra_handlers.go:1880-1888`) — safe. `importEntries` validates archive paths (`validImportArchivePath` rejects `../`, absolute, backslash), enforces checksums and size limits (`admin_extra_handlers.go:252-262,326-469`) — good.
- **Recovery flow hardening:** `recoveryOriginAllowed` + strict JSON content-type + `decodeStrictJSON` (rejects unknown fields) + throttle on recovery endpoints + full session revocation + audit logging — good.
- **Recovery key file output:** created via `openat` with `O_EXCL|O_NOFOLLOW`, 0600 perms, symlink-free parent enforced, device/inode re-verified before commit (`recovery_cli_output.go`) — excellent.

---

## Priority Order

1. **C1** — TOTP replay on login (add step-based replay guard + atomic challenge consume).
2. **H1** — raise Argon2id params.
3. **M1** — verify/scope `TRUSTED_PROXY_CIDRS` (IP-spoofing of rate limits).
4. **M3** — CSRF fallback should fail hard.
5. **H2** — constant-time memory-mode password compare.
6. **M2** — Secure cookie flag / `__Host-` prefix.
7. Others are LOW.

## Summary

The codebase is generally well-hardened: constant-time compares, AES-256-GCM, crypto/rand everywhere, CSRF, CSP, session revocation, and TOTP replay guards on the recovery paths. The most important gap is the **TOTP replay on the login flow (C1)**.