# Security Review — API / Media / Data-Integrity

Reviewer: api-media-security (teammate). Read-only review. No files modified.

Scope files reviewed: main.go, server.go, media_handlers.go, entry_handlers.go,
entry_list_handlers.go, entry_versions.go, commit_handlers.go, commit_database.go,
undo_handlers.go, public_handlers.go, render.go, working_copy.go,
working_copy_handlers.go, writing_handlers.go, domain.go, persistence.go,
migrations.go, platform.go, nas_config_export.go, ouimage/client.go,
integration_settings.go, admin_extra_handlers.go (import/export/embed),
cmd/worker/main.go (media_delete job).

## Summary

The codebase is generally security-conscious: parameterized SQL everywhere,
path-containment checks on media, strict ZIP import validation, SSRF guards on
the image-hosting client, and bluemonday sanitization on rendered HTML. Most of
the high-risk classes (path traversal, zip-slip, SSRF, SQLi) are well defended.

The findings below are the genuine residual risks. No CRITICAL remote
unauthenticated RCE was found. The most serious issues are authenticated
stored-XSS / trust-boundary gaps and a few hardening gaps.

## Findings

### 1. MEDIUM — Stored XSS via imported `rendered_html` bypasses sanitization
- File: `services/core/admin_extra_handlers.go:787-790` (import applies archived `RenderedHTML` verbatim)
- The normal write path (`commit_database.go:139`, `entry_versions.go:55`) always runs `renderMarkdown()` which sanitizes through bluemonday. The ZIP import path stores the archive's `rendered_html` directly into the DB without re-sanitizing:
  ```go
  entry.Markdown = rewriteImportedMediaReferences(entry.Markdown, mediaMapping)
  entry.RenderedHTML = rewriteImportedMediaReferences(entry.RenderedHTML, mediaMapping)
  ```
  and later `INSERT ... rendered_html=EXCLUDED.rendered_html ...` (line 790).
- Public rendering (`publicView` → `render.go`) serves `e.RenderedHTML` as-is; the client renders it. A crafted export ZIP carrying `<script>`/`onerror` in `renderedHtml` becomes stored XSS on the public timeline.
- Impact: authenticated admin can self-inject stored XSS that executes for every public visitor. Since the import endpoint is admin-only (single-owner blog), the practical exposure is the operator importing a malicious/compromised export file — but the defense-in-depth gap is real and the data-integrity invariant ("rendered_html is always sanitized server-side") is broken.
- Fix: never trust archived `rendered_html`; re-render from `markdown` on import (`htmlOut, _ := renderMarkdown(entry.Markdown)`), or at minimum run the archived HTML through `htmlPolicy.Sanitize()` before persisting. Also reject entries whose `markdown` → `renderMarkdown` output differs from the archived `rendered_html`.

### 2. MEDIUM — `importDryRun` trusts the ZIP central directory filename for traversal detection
`/services/core/admin_extra_handlers.go:1734-1785` (`importDryRun`)
The dry-run reports unsafe paths using `file.Name` from `zip.NewReader`. The primary `readImportArchive` path validates `validImportArchivePath` correctly (rejects `..`, absolute, backslash). The dry-run path is consistent with that and only reports. Not exploitable for writes. Low real risk — informational, included for completeness: dry-run and real import must share the same validation so the dry-run preview cannot diverge from the applied result.

### 3. LOW — `validImportArchivePath` is safe but worth noting for symlink entries
`/services/core/admin_extra_handlers.go:252-262`
Rejects `..`, absolute, backslashes, and requires `filepath.Clean(name)==name`. Good. Go's `archive/zip` does not materialize symlinks; entries are read into memory and never written to disk by path in `importEntries` (media staged by generated UUID `targetID` at line 663). No zip-slip. No finding beyond a note: if a future change writes entries to disk by archive name, re-apply this check at write time.

### 4. MEDIUM — Media serving uses stored `Content-Type` from client-declared MIME
`/services/core/media_handlers.go:695,748` (`mediaContent`/`mediaContentDatabase`)
`w.Header().Set("Content-Type", m.MimeType)` serves the MIME the client declared at ticket time. Although `validateMediaFile` at finalize requires `http.DetectContentType` to match the declared MIME (line 111-116), `allowedMediaMime` (line 187-191) permits `application/pdf`, `application/zip`, and `text/plain` in addition to images/audio/video. `DetectContentType` for a small crafted file can be ambiguous, and `text/plain`/`application/*` served with `nosniff` (set in `withCORS`, server.go:280) is low-risk. The main residual: an uploaded `text/html`-looking file is rejected (good), but a `text/plain` file with embedded HTML would be served as `text/plain` + `nosniff`, which is safe. **No stored-XSS via media.** Note `Content-Disposition: inline` with `filename` for private media only. Public media is served inline with a user-controlled-ish `OriginalName` in `http.ServeContent` — `http.ServeContent` sets its own `Content-Type` from extension if not set, overriding the stored MIME. Verify the intended MIME is always the stored one; recommend forcing the validated MIME and not letting `ServeContent` infer from a user-controlled filename.

### 5. LOW — `importMediaBytes`/media import stores bytes under a UUID filename but trusts `record.OriginalName` for `Content-Disposition`/feed
`/services/core/admin_extra_handlers.go:663,692` and `mediaContent`
Imported media `original_name` comes from the archive. When later served, `mediaContent` builds `Content-Disposition: inline; filename="<originalName>"`. `strings.ReplaceAll(orig, "\"", "")` strips quotes but not CR/LF. A `\r\n` in `original_name` could inject header lines (header injection) in the `Content-Disposition`. Header injection is largely mitigated by Go's `net/http` which rejects newlines in header values (returns an error and logs), so impact is limited. Still, sanitize `original_name` to a safe base filename (strip CR/LF/control chars) at import and at ticket time.

### 6. MEDIUM — `resolveEmbed` performs no actual fetch (good), but its allowlist is the only SSRF gate; `ouimage` client's `safeDialer` is DNS-only
`/services/core/ouimage/client.go:351-368` (`safeDialer`) and `/services/core/integration_settings.go:143-163` (`validateExternalEndpoint`)
The `safeDialer` resolves the host to IPs and rejects loopback/private/link-local/multicast **at dial time**, which is the correct TOCTOU-safe place. `validateExternalEndpoint` rejects literal IPs that are loopback/private but only at config-save time; the dial-time check is the real guard. The `resolveEmbed` handler (admin_extra_handlers.go:1596-1627) does **not** fetch anything — it only validates the hostname against youtube/bilibili/vimeo and returns metadata. **No SSRF.**
One gap: `safeDialer` rejects private IPs but a public DNS name that resolves to a private IP on a non-default resolver is caught at dial. However the client dials the **configured endpoint only** (never attacker-supplied URLs), so SSRF exposure is limited to the admin configuring a malicious host — already admin-gated. No actionable finding.

### 7. LOW — `ouimage` `resolveDeliveryURL` allows cross-host via `base.Parse` normalization edge
`/services/core/ouimage/client.go:311-325`
`target, err := base.Parse(raw)` then requires `sameOrigin(base, target)`, `https`, no userinfo, and rejects signed-query params. `sameOrigin` compares Scheme+Host case-insensitively — good. An attacker-controlled server could return a URL on a sibling subdomain of the configured host (same host suffix but different subdomain) — `sameOrigin` requires exact host match, so subdomains are **not** allowed. Safe. Informational.

### 5. LOW — `mediaContent` in-memory GET auth check is `requireAuth` (memory mode only)
`/services/core/media_handlers.go:248` and `mediaEndpoint` GET
In-memory/non-persistent mode, GET `/admin/media/` uses `requireAuth` (any authenticated session) — consistent with admin scope. Private media serving requires auth (line 681). Public media is served without auth (intended). No IDOR because the persistent path scopes every query by `owner_id` (single-owner). No finding.

### 6. LOW — `decode()` has no strict body-size after LimitReader for some JSON endpoints
`/services/core/platform.go:58-63`
`decode` uses `io.LimitReader(r.Body, 2<<20)` but does **not** reject a body larger than 2 MiB — it silently truncates. For mutations like `commitWorkingDatabase` this means an oversized markdown is truncated at 2 MiB and persisted, which is acceptable (not an overflow). `decodeStrictJSON` (platform.go:70) correctly rejects oversized bodies. Minor inconsistency; recommend `decode` also reject bodies exceeding the limit to avoid silent truncation on import-heavy JSON.

### 7. LOW — `exportDownload` uses `http.ServeFile` on a DB-stored path without re-checking root
`/services/core/admin_extra_handlers.go:1870-1888`
`filePath` comes from `SELECT storage_path FROM exports WHERE id=$1 AND owner_id=$2 AND status='ready'`. The path was written by the worker when generating the export; the worker sets it under `EXPORT_ROOT`. This handler does **not** call `mediaPathWithinRoot` on `filePath` before `http.ServeFile`. If the worker (or an import/DB compromise) ever stored a path outside EXPORT_ROOT, this would serve an arbitrary file. Admin-only and export paths are generated server-side, so impact is low. Recommend a root-containment check before `ServeFile`.

### 8. LOW — `exportDownload`/`mediaContent` rely on `storage_path` from DB without re-validating on every serve
Same class as #7; `mediaContentDatabase` does call `mediaPathWithinRoot` (line 738), so media is defended. Only the export path is missing the check. See #7.

### 9. LOW — Undo token entropy / lifetime
`/services/core/undo_handlers.go`, `commit_database.go:253-255`
Undo tokens are `randomToken()` (24 random bytes, hex) and expire in 15s. They are single-use (deleted in the DELETE query). Good. The in-memory `undoEntry` (undo_handlers.go:63-64) deletes the token before checking expiry, which is fine. No issue.

### 10. LOW — `newID()` falls back to `time.Now().UnixNano()` on `rand.Read` failure
`/services/core/domain.go:160-166`
If `crypto/rand` fails, IDs become predictable timestamps. Also the media upload path uses this `newID()` for media IDs and filenames. A predictable ID would weaken path-uniqueness and could enable IDOR-ish enumeration if combined with the in-memory store. In practice `crypto/rand` failing is catastrophic anyway. Recommend treating `rand.Read` failure as fatal (panic/return error) rather than silently degrading.

### 11. LOW — `newCSRFKey` fallback is deterministic
`/services/core/platform.go:111-132`
When `TOTP_ENCRYPTION_KEY` and `CONFIG_ENCRYPTION_KEY` are both unset, `newCSRFKey` falls back to a random key (good) unless `rand.Read` fails, then a hardcoded `"timeblog/csrf/fallback"` hash. In persistent production these keys are required (persistence.go:248), so the fallback only affects memory/dev mode. Low. Recommend never using a deterministic key.

### 12. LOW — `main.go` healthcheck/`--healthcheck` performs an outbound GET to `HEALTHCHECK_URL`
`/services/core/main.go:34-45`
The healthcheck fetches `HEALTHCHECK_URL` (default loopback) via a plain `http.Client`. This is operator-invoked CLI, not a server-side user-triggered fetch, so not SSRF. Informational.

### 13. LOW — `nas_config_export` writes config to stdout including paths; no command injection in code
`/services/core/nas_config_export.go:41-50`
`writeNASConfig` only `fmt.Fprintf`s `SOURCE_HOST/SOURCE_PATH/DEST_PATH/RETENTION_DAYS`. The values are validated (`validNASHost`, `validNASPath` reject `;&|`$<>(){}[]` etc., integration_settings.go:173-196). No `os/exec` anywhere in the reviewed core files (searched; only the NAS script consumes this env file externally). **No command injection.**

### 14. LOW — `decode` used for `mediaTicket` and many JSON bodies does not reject unknown fields
`/services/core/media_handlers.go:147`, `platform.go:58-63`
`decode` accepts unknown JSON fields silently. For an admin-only API this is low risk, but strict decoding (`decodeStrictJSON`) is preferred for security-sensitive mutations to avoid future field-name confusion. The codebase already has `decodeStrictJSON`; recommend migrating mutations to it.

## What was checked and is CLEAN (no findings)
- **SQL injection:** every query uses parameterized `$N` placeholders via `QueryContext/ExecContext`. The only string-built SQL is `publicSearch` (public_handlers.go:390-401) where the `LIMIT $N` placeholder index is computed from `len(args)` and the user `q` is always passed as a parameter — no concatenation of user input. `publicCalendar` uses `month+"%"` as a LIKE parameter (parameterized). Clean.
- **Path traversal / arbitrary file read-write:** media storage paths are `<uuid>` or `<uuid>-upload` under `mediaRoot`; every open/remove is guarded by `mediaPathWithinRoot`. Media deletion paths re-validated in worker `deleteMediaJob`. Clean.
- **ZIP slip / zip bomb:** `readImportArchive` enforces `maxImportArchiveBytes=256MiB` (whole), `maxImportFileBytes=32MiB` (per file), total-accumulation check, per-file `LimitReader`, `validImportArchivePath` (relative-only, no `..`, no backslash), duplicate-path rejection, and mandatory SHA-256 checksum verification against the manifest. Media files additionally constrained to `configuredMaxUploadBytes`. Clean.
- **SSRF:** `ouimage` client restricts scheme/host/port, dial-time private-IP rejection, redirects confined to same-origin, max 3 redirects, bounded response body. `resolveEmbed` performs no network fetch. Clean.
- **Upload size limits:** ticket validates `Size` against `configuredMaxUploadBytes`; finalize validates actual size; upload path enforces `remaining`/`offset+n` bounds and `io.LimitReader(remaining+1)`. Clean.
- **MIME validation:** `validateMediaFile` requires `http.DetectContentType` to equal declared MIME (with `application/octet-stream` rejected). Clean (with the stored-MIME serving note in #4).
- **Auth (IDOR):** all `/admin/*` routes wrapped in `adminAuth`; every persistent DB query scopes by `owner_id`; media queries scoped by `owner_id`; single-owner model. Clean.
- **HTML rendering:** `renderMarkdown` → `htmlPolicy.Sanitize` (bluemonday UGCPolicy) after goldmark; media refs rendered as inert spans; embed URLs host-allowlisted; feed uses `html.EscapeString`. The only gap is the import path (#1).

## Priority recommendation
1. Re-sanitize (or re-render) `rendered_html` on ZIP import (#1) — highest value.
2. Force the validated MIME on media serving instead of `ServeContent` inference and sanitize `original_name` for the `Content-Disposition` header (#4/#5).
3. Add root-containment check in `exportDownload` (#7).
4. Make `rand.Read` failure fatal in `newID` (#10) and remove deterministic CSRF fallback (#11).