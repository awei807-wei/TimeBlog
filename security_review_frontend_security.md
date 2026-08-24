# Frontend Security Review — apps/web

**Reviewer:** frontend-security (teammate)
**Scope:** `apps/web` (React / Next.js 16.3.1, TypeScript). Backend is a Go API.
**Mode:** Read-only audit. No files were modified.
**Date:** 2026-08-24

---

## Part A — Good Practices Verified (no action needed)

1. **Auth token storage is correct.** No `localStorage`/`sessionStorage` storage of any auth token. The session is a server-managed **httpOnly same-origin cookie**; the client only holds a short-lived CSRF token fetched from `/auth/session`. Token refresh is server-driven via `/auth/session/status` (`apps/web/app/SessionContext.tsx:25-37`, `apps/web/app/admin/useAdminSession.ts:15-30`). Logout POSTs to `/auth/logout` with the CSRF token and does **not** rely on client-side cookie deletion (`apps/web/app/SessionContext.tsx:77-105`, `apps/web/app/AuthNav.tsx:48-75`).

2. **No secrets committed.** No `.env*` files exist (verified via `find`). No API keys/secrets in client code. The external image-host token is never echoed to the client (`tokenMasked: '' | '********'`, `apps/web/lib/api.ts:29`; `apps/web/app/admin/settings/IntegrationsSettingsPanel.tsx:95-102`).

3. **Markdown/renderedHtml is sanitized.** Both the article page (`apps/web/app/article/[slug]/page.tsx:65`) and the public note preview (`apps/web/app/public/PublicEntryCard.tsx:32-35`) run DOMPurify (`isomorphic-dompurify`) with `ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|\/|#):?)/i`. The custom GFM renderer escapes all user input before emitting markup (`apps/web/lib/markdown.js:5-18,46-68`).

4. **Embed URLs are host-whitelisted** (youtube/bilibili/vimeo) with scheme/port checks (`apps/web/lib/embed-utils.js:22-43`) and use `sandbox` + `referrerPolicy` (`apps/web/app/article/EmbedResolver.tsx:20`). `window.open(...,'_blank','noopener,noreferrer')` (`apps/web/app/admin/MdxMarkdownEditorClient.tsx:253`). `target="_blank"` links carry `rel=noreferrer` (`apps/web/app/admin/EditingDraftNotice.tsx:35`).

5. **Recovery secrets use a secure RNG.** Recovery key + TOTP secret are generated with `crypto.getRandomValues`, never `Math.random` (`apps/web/app/recovery/RecoveryForm.tsx:29-39`).

6. **No open redirects.** All `redirect()` / `router.push()` target internal paths only.

---

## Part B — Findings

### F1. HIGH — Recovery credentials generated & held entirely client-side; persisted in DOM + React state/history; never auto-cleared

- **File:line:** `apps/web/app/recovery/RecoveryForm.tsx:58-73` (`newRecoveryAttempt`/`base32`/`base64URL`), `:141` (`result` state), `:197-201` (`setResult`), `:254-282` (render into read-only `<textarea>` + `QRCodeSVG`)
- **Code:**
  ```ts
  function newRecoveryAttempt(recoveryKey, newPassword) {
    return { recoveryKey, newPassword,
             operationToken: base64URL(randomBytes(32)),
             newRecoveryKey: base64URL(randomBytes(32)),
             newTotpSecret: base32(randomBytes(20)) };
  }
  ...
  setResult({ recoveryKey: attempt.newRecoveryKey, totpSecret: attempt.newTotpSecret,
              totpSetupURI: recoveryTOTPSetupURI(attempt.newTotpSecret) });
  ...
  <textarea id="new-recovery-key" readOnly value={result.recoveryKey} rows={3} />
  <textarea id="totp-manual-secret" readOnly spellCheck={false} value={result.totpSecret} rows={2} />
  <textarea id="totp-setup-uri" readOnly value={result.totpSetupURI} rows={4} />
  ```
- **Description:** The new TOTP secret, recovery key, and full `otpauth://` URI are generated in the browser and rendered into persistent read-only textareas + a QR code. They remain in React state and the DOM for the entire component lifetime; nothing clears them on blur, timeout, or navigation (they persist until remount). The code comment states it explicitly: "The browser owns these plaintext credentials." If any XSS exists anywhere in the app (see F4/F5), these secrets are trivially exfiltratable and linger in browser history/state. Also, the server accepts a *client-generated* TOTP secret as the authoritative value, so the server cannot confirm the user actually stored it (recovery anti-pattern).
- **Fix:**
  - Clear `setResult(null)` on unmount and after a short display timeout / on blur.
  - Render secrets via ephemeral, non-persisted DOM; add `inert` and `autocomplete="off"`.
  - Prefer generating the TOTP secret server-side and returning it over TLS for display-only, with a "user confirmed saved" acknowledgement before the server commits it.
  - Never keep the plaintext in component state after display.

### F2. MEDIUM — No security headers at all (no CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy)

- **File:line:** `apps/web/next.config.mjs:1-17`
- **Code:**
  ```js
  const nextConfig = {
    output: 'standalone',
    reactStrictMode: true,
    experimental: { useTypeScriptCli: false },
    async rewrites() {
      const apiOrigin = process.env.API_ORIGIN || 'http://localhost:8080';
      return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
    },
  };
  ```
- **Description:** There is no `async headers()` in next.config and no middleware setting headers. The app relies entirely on the reverse proxy (if any) for headers. Given the app ships inline scripts (theme script), iframes, and `innerHTML`, the absence of CSP removes the last line of defense against stored XSS, and there is no clickjacking protection for the admin panel.
- **Fix:** Add `async headers()` returning:
  - `Content-Security-Policy`: `default-src 'self'; script-src 'self' 'unsafe-inline'; frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://player.bilibili.com; img-src 'self' data:; connect-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; form-action 'self'`
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - (behind TLS) `Strict-Transport-Security`

### F3. MEDIUM — No server-side route guard for `/admin` (no middleware.ts / no admin layout auth check)

- **File:line:** `find` confirmed no `middleware.*`; `apps/web/app/admin/page.tsx:1-10` (renders `AdminEditorView` unconditionally); `apps/web/app/admin/useAdminSession.ts:17` (only fetches CSRF after mount)
- **Code:**
  ```ts
  export default function AdminPage() {
    const props = useAdminPageController();
    return <AdminEditorView {...props} />;
  }
  ```
  ```ts
  const request = fetch(`${API}/auth/session`, { cache: 'no-store', credentials: 'include', headers: { Accept: 'application/json' } })...
  ```
- **Description:** The admin SPA shell is served to unauthenticated visitors; protection relies entirely on the backend returning 401 for `/admin/*` API calls. This exposes the editor bundle and enables UI probing. Data exposure is limited because the backend enforces auth on every admin endpoint, but it violates defense-in-depth.
- **Fix:** Add a Next.js `middleware.ts` (or a server-component layout under `/admin`) that checks the session and redirects to `/login` when unauthenticated.

### F4. MEDIUM — `wrapper.innerHTML = result.svg` in MermaidResolver (mitigated by `securityLevel:'strict'`)

- **File:line:** `apps/web/app/article/MermaidResolver.tsx:28`
- **Code:**
  ```ts
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
  ...
  wrapper.innerHTML = result.svg;
  ```
- **Description:** A manually-injected `innerHTML` of the rendered mermaid SVG, whose source is attacker-influenced markdown (base64-decoded). The `securityLevel: 'strict'` config strips `<script>`/event handlers, so this is currently LOW-to-MEDIUM. But manual `innerHTML` injection of rendered graph markup is fragile: if a dependency upgrade or a config change ever drops `securityLevel`, this becomes stored XSS.
- **Fix:** Keep `securityLevel:'strict'` permanently, and additionally run `DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true } })` before assigning `innerHTML`.

### F5. LOW — Embed iframes combine `allow-scripts allow-same-origin`

- **File:line:** `apps/web/app/article/EmbedResolver.tsx:20`
- **Code:**
  ```tsx
  <iframe title={...} src={visible ? src : undefined} loading="lazy"
          sandbox="allow-scripts allow-same-origin allow-presentation"
          referrerPolicy="strict-origin-when-cross-origin"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" />
  ```
- **Description:** `allow-scripts allow-same-origin` together is the classic combination that lets a sandboxed frame escape its sandbox and script the parent if the embedded origin is ever attacker-controlled. The host whitelist in `embedSource` (`apps/web/lib/embed-utils.js:22-43`) constrains origins to video providers, so current risk is low, but the `src` is derived from user-authored markdown.
- **Fix:** Remove `allow-same-origin` from the sandbox (keep `allow-scripts allow-presentation`), or validate the final embedded origin server-side.

### A6. LOW — Sidebar cookie written without `Secure`/`SameSite`

- **File:line:** `apps/web/app/components/ui/sidebar.tsx:86`
- **Code:**
  ```ts
  document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`
  ```
- **Description:** Non-sensitive UI preference cookie, but under an HTTPS deployment it is sent over plaintext and could be overwritten cross-site.
- **Fix:** Append `; Secure; SameSite=Lax`.

### A7. LOW — Theme preference in `localStorage` read by an inline `<script dangerouslySetInnerHTML>`

- **File:line:** `apps/web/app/layout.tsx:37-38`
- **Code:**
  ```tsx
  const themeScript = `(function(){try{var saved=localStorage.getItem('timeblog-theme');...})()`;
  <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
  ```
- **Description:** Benign (theme preference, not a secret), but the inline script forces `'unsafe-inline'` in any CSP (see F2).
- **Fix:** Move to a nonce-based or hashed external script. (`apps/web/app/public/PublicShell.tsx:30` writes the same key.)

### A8. LOW — Service worker caches public pages including search/user-query-reflected responses

- **File:line:** `apps/web/public/sw.js:13-17,61`
- **Code:**
  ```js
  const mutable = url.origin === self.location.origin && (
    url.pathname === '/' || url.pathname.startsWith('/day/') || url.pathname.startsWith('/article/') ||
    url.pathname.startsWith('/categories/') || url.pathname.startsWith('/tag/') ||
    url.pathname.startsWith('/search') || url.pathname === '/feed.xml'
  );
  ...
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)...));
  ```
- **Description:** The SW caches `/search` responses, which can reflect user query terms into the cache. It correctly excludes `/admin`, `/api`, `/login`, `/recovery`, `/private-media/`, and only caches same-origin. Private entries are only ever placeholder text, not full bodies, so impact is minimal.
- **Fix:** Drop `/search` from the mutable-cache set to avoid caching user-query-containing responses.

---

## Part C — Areas Checked With No Issues Found

- **Admin MDX editor XSS:** Content is stored as markdown and only ever rendered through DOMPurify on the public side; `prepareMarkdownForMdxEditor` (`apps/web/app/admin/mdx-compat.ts`) HTML-escapes unsafe tags and preserves original source. No raw `dangerouslySetInnerHTML` on user content in the editor path.
- **The three `dangerouslySetInnerHTML` usages found** (layout theme script, article ld+json with `<` escaped, MediaResolver) are safe: the theme script is static; the ld+json escapes `<`; MediaResolver input is already DOMPurify-sanitized before it is passed in from both call sites.
- **Open redirects:** none. All `redirect()`/`router.push()` target internal paths.
- **Dependency versions:** Next 16.3.1, React 19.1.1, DOMPurify 3.22.0, mermaid 11.16.1, @mdxeditor/editor 4.2.0 — all current; no obviously known-vulnerable pinned versions. `npm audit` was not run (read-only audit) — recommended to run in CI.

---

## Net Assessment

- **No CRITICAL findings.**
- **One HIGH:** F1 (recovery credential lifecycle).
- The auth/session model is solid (httpOnly cookie + CSRF header).
- Most valuable hardening items: **F2** (missing CSP/security headers) and **F3** (no admin route guard).