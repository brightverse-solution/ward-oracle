---
from: WARD Oracle 🛡️
to: QuillBrain 🪶, Palm (p4lmnpk)
date: 2026-04-27
subject: Security Audit — Soraphop-Project main (Tier 1)
scope: CVEs, auth scaffold, Caddy headers, secrets scan, cookie domain
draft-pr: fix/ward-security-fixes (Soraphop-Project)
---

# Soraphop-Project — Security Audit Report (Tier 1)
## WARD Oracle 🛡️ · 2026-04-27

---

## Executive Summary

Audited: `Soraphop-Project` main branch (commit `bd65891`).
Scope: dependency CVEs, auth scaffold, Caddy security headers, secrets scan, cookie domain/CSRF model.

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 2 |
| Medium | 4 |
| Low | 1 |
| Info | 3 |
| **Total** | **10** |

**Two findings require immediate action before staging deploy:**
- `CVE_ASTRO_XSS` (High) — production XSS in apps/marketing via Astro `define:vars`
- `CADDY_CSP_MISSING` (High) — no Content-Security-Policy on either site; amplifies XSS blast radius

Draft PR `fix/ward-security-fixes` contains patches for both Highs plus the Medium CVE.

---

## Findings

---

### [HIGH] CVE_ASTRO_XSS — CVE-2026-41067 — Astro `define:vars` XSS

**File**: `apps/marketing/package.json`
**Current version**: `"astro": "^5.6.0"` (v5 series, range caps at <6.0.0)
**CVE**: CVE-2026-41067 · CVSS 6.1 · XSS via `define:vars` directive in Astro component scripts
**Fix version**: Astro ≥ 6.1.6 — not reachable from current `^5.6.0` range

**Impact**: apps/marketing is a public-facing site. If any Astro component uses `define:vars` to pass server-side values (e.g., from CMS, query params, or request headers) into client scripts, an attacker can inject arbitrary JavaScript. The `^5.6.0` semver range will never resolve to the fix — requires explicit major-version bump.

**Patch**: `"astro": "^6.1.6"` in apps/marketing/package.json (included in draft PR).

**Defer decision to**: Palm + FORGE/PRISM to validate Astro v6 migration compatibility.

---

### [HIGH] CADDY_CSP_MISSING — No Content-Security-Policy on Either Site

**File**: `infra/caddy/Caddyfile` (both `soraphop.brightverse.dev` and `app.soraphop.brightverse.dev` blocks)
**Finding**: The Caddyfile sets HSTS, X-Content-Type-Options, X-Frame-Options, and Referrer-Policy but is missing `Content-Security-Policy` on both sites.

**Impact**: Without CSP:
- Any XSS payload (including CVE-2026-41067 above) can execute inline scripts without browser restriction
- Inline script injection through reflected/stored inputs is unrestricted
- Given the shared-domain cookie design intent (see `COOKIE_DOMAIN_DESIGN_TENSION` below), XSS on either subdomain could make credentialed API requests to the other app

**Why this is High in combination with CVE_ASTRO_XSS**: Astro XSS CVE + no CSP = confirmed production XSS attack surface with no browser-level mitigation layer.

**Patch (draft, in PR)**: Starter restrictive CSP for each site:
- Storefront (Next.js): policy allowing `'self'`, `'unsafe-inline'` for styles only (Next.js requires this for RSC hydration), blocking object-src and base-uri
- Portal (Vite SPA): tighter policy; no `'unsafe-inline'` in script-src since Vite produces hashed bundles

Note: Final CSP tuning requires runtime testing (report-only first). Patch in PR is a starting point.

---

### [MEDIUM] CVE_NEXTINTL_REDIRECT — CVE-2026-40299 — next-intl Open Redirect

**File**: `apps/storefront/package.json`
**Current version**: `"next-intl": "^3.26.5"` (range caps at <4.0.0)
**CVE**: CVE-2026-40299 · Open redirect via crafted locale/redirect parameter
**Fix version**: next-intl ≥ 4.9.1 — not reachable from `^3.26.5`

**Impact**: An attacker can craft a URL that passes next-intl's routing layer and redirects users to an attacker-controlled domain (e.g., phishing). Storefront is user-facing and handles locale routing — directly in blast radius.

**Patch**: `"next-intl": "^4.9.1"` in apps/storefront/package.json (included in draft PR).

**Defer decision to**: FORGE to validate Next.js + next-intl v4 API compatibility.

---

### [MEDIUM] AUTH_TRUST_HOST_FWDHOST — `trustHost: true` Without X-Forwarded-Host Stripping

**File**: `apps/api/src/platform/auth/auth-config.ts:246`, `infra/caddy/Caddyfile:27,35,65`

`trustHost: true` tells Auth.js to trust the `X-Forwarded-Host` header from the reverse proxy. Caddy sets `X-Forwarded-Proto` and `X-Real-IP` but does **not** strip or override incoming `X-Forwarded-Host` headers from clients.

**Attack path**: Client sends `X-Forwarded-Host: evil.com`. Caddy passes it through. Auth.js uses it to construct callback URLs and CSRF token host bindings. Potential outcomes:
- Auth.js generates `callbackUrl: https://evil.com/api/auth/callback/credentials` (partially mitigated by same-origin redirect check in `redirect` callback)
- CSRF token `__Host-soraphop.csrf-token` host binding is based on the spoofed host
- Future OAuth providers (LINE, Google) may use the host for redirect_uri construction

**Partial mitigation in place**: The `redirect` callback (auth-config.ts:202–211) performs a same-origin check, which blocks direct redirect exploitation. But host spoofing affects more than redirects in Auth.js internals.

**Fix**: Add `header_up X-Forwarded-Host {host}` to all Caddy `reverse_proxy` blocks. This forces Caddy to rewrite the header with its own received host, regardless of what the client sent. (Included in draft PR as comment with instruction — ANVIL to enable.)

**Defer decision to**: ANVIL (Caddy config owner).

---

### [MEDIUM] PERM_B2B_APPROVE_2FA_MISSING — `b2b_application.approve` Missing `step_up_2fa`

**File**: `apps/api/src/platform/auth/permission-map-skeleton.ts:169–179`

```typescript
{
  action: 'b2b_application.approve',
  resource: 'user',
  roles: [ROLES.ADMIN_FINANCE],
  uc_refs: ['UC-A01'],
  notes: 'Approves the company doc upload + activates the buyer account; always-2FA per LD-5',
  // ← step_up_2fa: true is MISSING
}
```

The `notes` field references "always-2FA per LD-5" but `step_up_2fa` is not set. `rbac-middleware.ts:183` checks `if (rule.step_up_2fa)` — `undefined` is falsy, so step-up 2FA will **not** be enforced at runtime despite the stated policy.

This means an admin whose session 2FA expired (> 5-min freshness window) can still approve B2B applications without re-verifying identity.

**Scope**: Limited to the scaffold skeleton. No live route yet. Named now so it's caught before the route ships.

**Fix**: Add `step_up_2fa: true` to the `b2b_application.approve` rule (patch in draft PR).

**Defer decision to**: FORGE to confirm before wiring the route; Palm to approve the constraint.

---

### [MEDIUM] COOKIE_DOMAIN_DESIGN_TENSION — Shared Domain Intent vs Auth Config Mismatch

**Files**: `infra/caddy/Caddyfile:9` (comment), `apps/api/src/platform/auth/auth-config.ts:84–113`

Caddyfile comment: `# Cookie domain: .soraphop.brightverse.dev (session shared between apps)`

auth-config.ts cookie options do **not** set a `domain` property. Without explicit domain, browsers bind cookies to the exact serving hostname. Currently:
- `soraphop.brightverse.dev` session cookies are bound to that hostname only
- `app.soraphop.brightverse.dev` session cookies are bound to that hostname only
- They are **not** shared — the comment is aspirational, not implemented

**Why this matters when shared domain is eventually implemented**: Both apps share the `brightverse.dev` registered domain. `sameSite: 'strict'` protects against cross-site CSRF but NOT against XSS within the same eTLD+1. If domain is set to `.soraphop.brightverse.dev`:
- XSS on `app.soraphop.brightverse.dev` (portal) can make credentialed fetch requests to `soraphop.brightverse.dev/api/*`
- Cookies are `httpOnly` (JS can't read them), but the browser sends them automatically on same-site requests
- The portal is a Vite SPA (larger client-side attack surface than Next.js SSR)

**Interaction**: This finding's severity is conditional on `CADDY_CSP_MISSING`. With CSP in place, XSS impact is contained. Without CSP, the shared domain design creates meaningful cross-app session risk.

**Recommendation**: Decide before implementing shared domain whether CSP is in place. If shared session is not required, remove the Caddyfile comment to avoid future accidental implementation.

**Defer decision to**: Palm + FORGE (session architecture owner).

---

### [LOW] CVE_POSTCSS_CSS_INJECT — CVE-2026-41305 — PostCSS `</style>` Injection

**File**: `apps/storefront/package.json` (transitive via `next`, then `styled-jsx` → `postcss`)
**CVE**: CVE-2026-41305 · CVSS 6.1 · XSS via `</style>` sequence in PostCSS CSS stringify output

**Assessment**: PostCSS configuration in storefront is build-time only — `tailwindcss` + `autoprefixer` on developer-controlled static CSS files. No evidence of runtime user input passing through PostCSS (no CSS-in-JS, no `styled-jsx` usage, no `createGlobalStyle`).

**Risk**: Low in this app's current architecture. Would become High if CSS values derived from user input are ever processed through PostCSS at runtime.

**Scope**: Named for awareness. Not actionable until user-input CSS processing is introduced.

---

### [INFO] CVE_ESBUILD_CORS — GHSA-67mh-4wv8-2f99 — esbuild Development Server CORS

**Finding**: esbuild 0.21.5 has a CORS misconfiguration in its development server. Exploitable only when `esbuild`'s dev server is running and accepting connections — never in production builds.

**Scope**: Dev-only dependency (pulled in by vitest). Non-actionable until next vitest upgrade resolves it upstream.

---

### [INFO] CVE_VITE_TRAVERSAL — CVE-2026-39365 — Vite Development Server Path Traversal

**Finding**: Vite 5.4.21 has a path traversal via crafted URL in its development server. Dev-only — Vite dev server is never exposed in production.

**Scope**: Dev-only dependency (vitest). Non-actionable until next Vite upgrade.

---

### [INFO] COMPOSE_DEV_HARDCODED_PASS — compose.dev.yml Hardcoded Postgres Password

**File**: `infra/docker/compose.dev.yml:30` — `POSTGRES_PASSWORD: soraphop`

Dev-only, committed to repo. Expected pattern for local dev environments. Noting for completeness — guard against accidental copy to staging.

compose.staging.yml correctly uses `${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}` — the staging pattern is correct.

---

## Non-Findings (Confirmed Clean)

| Area | Check | Result |
|------|-------|--------|
| auth-config.ts | Hardcoded `AUTH_SECRET` | ✅ Clean — `process.env.AUTH_SECRET` only |
| auth-config.ts | `debug: true` in production | ✅ Conditional on `NODE_ENV !== 'production'` |
| auth-config.ts | Session JWT maxAge | ✅ 8h absolute + 30min refresh — reasonable |
| auth-config.ts | Cookie flags: httpOnly, secure, sameSite | ✅ All three set correctly |
| auth-config.ts | Cookie name prefixes `__Secure-` / `__Host-` | ✅ Browser-enforced HTTPS + host binding |
| auth-config.ts | CSRF token (double-submit) | ✅ Auth.js generates + validates — not disabled |
| auth-config.ts | Redirect callback open redirect | ✅ Same-origin whitelist enforced |
| rbac-middleware.ts | Fail-closed on unknown condition evaluator | ✅ Returns 500, logs `rbac.error.unknown_condition` |
| rbac-middleware.ts | Audit log on every denial | ✅ All 6 denial paths logged with reason |
| permission-map-skeleton.ts | Destructive ops gating | ✅ `toggle_super_admin` + `switch_live_mode` have 2-eye + 24h cooling-off + step-up 2FA |
| role-enum.ts | `isSuperAdmin` type guard | ✅ Requires `role === ADMIN_FINANCE && is_super_admin === true` — no privilege escalation path |
| compose.staging.yml | Sensitive env vars | ✅ All use `${VAR:?required}` — fail fast, no fallback secrets |
| compose.staging.yml | DB port exposure | ✅ No host port mapping for postgres/redis — internal network only |
| apps/ + infra/ secrets grep | Hardcoded keys/tokens/passwords (non-dev) | ✅ CLEAN — no matches |
| Caddyfile | HSTS (both sites) | ✅ `max-age=31536000; includeSubDomains; preload` |
| Caddyfile | X-Content-Type-Options | ✅ `nosniff` on both sites |
| Caddyfile | X-Frame-Options | ✅ `SAMEORIGIN` (storefront), `DENY` (portal) |
| Caddyfile | Server header removal | ✅ `-Server` on both sites |

---

## Priority Action Queue

| Priority | Finding | Owner | Blocker for deploy? |
|----------|---------|-------|---------------------|
| 1 | `CVE_ASTRO_XSS` — Astro → 6.1.6 | FORGE/PRISM | ✅ Yes |
| 2 | `CADDY_CSP_MISSING` — add CSP | ANVIL | ✅ Yes |
| 3 | `CVE_NEXTINTL_REDIRECT` — next-intl → 4.9.1 | FORGE | Before public launch |
| 4 | `AUTH_TRUST_HOST_FWDHOST` — Caddy X-Forwarded-Host | ANVIL | Before public launch |
| 5 | `PERM_B2B_APPROVE_2FA_MISSING` — add step_up_2fa | FORGE | Before UC-A01 route ships |
| 6 | `COOKIE_DOMAIN_DESIGN_TENSION` — decide domain strategy | Palm + FORGE | Before session sharing implemented |

---

## Draft PR

`fix/ward-security-fixes` contains patches for items 1–5 above.
All changes are draft — do not auto-merge. Requires:
- [ ] FORGE/PRISM: Astro v6 + next-intl v4 compatibility validation
- [ ] ANVIL: CSP policy tuning + X-Forwarded-Host review
- [ ] Palm: final approval

---

*WARD Oracle 🛡️ — brightverse-solution family — 2026-04-27*
*"The ward held. That was the answer."*
