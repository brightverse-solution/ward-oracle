---
artifact: nfr-checklist
project: Soraphop
oracle: WARD 🛡️
date: 2026-04-27
scope: Week 1 baseline — extends per-feature reviews
---

# Security NFR Checklist — Week 1 Baseline

> *Each item is checkable. Each owner is named. Each unchecked = a finding at audit time.*

Per kickoff-brief §6 + work-order. Items are **Week 1 baseline** — additional NFRs surface per-feature.

---

## Legend

- 🛡️ = WARD owns
- ⚒️ = FORGE owns
- 🎨 = PRISM owns
- ⚙️ = ANVIL owns
- 🔍 = LENS owns
- 📝 = INKWELL owns

---

## Transport & at-rest encryption

- [ ] **HTTPS/TLS 1.3 in transit** ⚙️ — Caddy/Traefik on Hetzner; HSTS preload; auto-renew via ACME; reject TLS < 1.2
- [ ] **AES-256 at-rest for sensitive columns** ⚒️ — Postgres `pgcrypto` for: `wallet_balance`, `bank_account`, `id_number`, `two_factor_secret`, company doc references
- [ ] **AES-256 for object storage** ⚙️ — S3-compatible bucket with SSE-KMS or SSE-C; bucket policy denies unencrypted PUT
- [ ] **Encryption key rotation policy documented** ⚙️ + 🛡️ — `AUTH_SECRET` quarterly; `TOTP_KEK` annually; `AUDIT_COLD_KEK` annually
- [ ] **No plaintext PII in logs** ⚒️ + 🎨 — log redaction filter for email, ID number, bank account, wallet balance

## Password & credential handling

- [ ] **bcrypt cost ≥ 12 rounds** ⚒️ — server-side hash time ~250ms; tune to ~250–500ms on chosen VPS
- [ ] **Password policy** ⚒️ — min 12 chars, must include 3 of {upper, lower, digit, special}; reject top-1000 common passwords (`zxcvbn` ≥ score 3)
- [ ] **Constant-time bcrypt compare** ⚒️ — dummy-bcrypt path on user-not-found to equalize timing
- [ ] **Password reset tokens** ⚒️ — 32-byte random, hashed in DB, 1-hour TTL, single-use; old sessions invalidated on success
- [ ] **No password leaks in error messages** ⚒️ — generic "invalid credentials"
- [ ] **Force re-login on password change** ⚒️ — bump `session_epoch`

## Authentication

- [ ] **JWT signed A256GCM** ⚒️ — Auth.js default; secret 256-bit
- [ ] **Cookies: HttpOnly, Secure, SameSite=Strict, `__Secure-`/`__Host-` prefix** ⚒️ — see `auth-config.ts`
- [ ] **Session absolute max 8h, sliding 30min** ⚒️ — see `auth-config.ts`
- [ ] **2FA mandatory per LD-5** ⚒️ + 🛡️ — see `2fa-flow.md`
- [ ] **Step-up 2FA on `step_up_2fa` rules** ⚒️ + 🛡️ — see `rbac-middleware.ts`
- [ ] **Forced logout via `session_epoch`** ⚒️ — JWT callback rejects on epoch mismatch
- [ ] **Brute-force lockout** ⚒️ — 5 wrong logins / 10 wrong 2FA in 30 min → 30 min lock + audit event

## RBAC & authorization

- [ ] **Permission map = data, not code** ⚒️ + 🛡️ — `permission_rules` table seeded from `permission-map-skeleton.ts`
- [ ] **Middleware fails closed** ⚒️ — unknown action / unknown condition / DB error → 403 / 500, never 200
- [ ] **No role hard-codes in business logic** 🛡️ (review) — grep `user.role ===` and `user.role.includes(` in code review
- [ ] **Super-admin gated ops require step-up + audit** ⚒️ — see permission map
- [ ] **2-eye + cooling-off enforced on `payment.switch_live_mode` and role assignment** ⚒️ — see `rbac-middleware.ts`

## CSRF / XSS / injection

- [ ] **CSRF: SameSite=Strict + double-submit token on mutating endpoints** ⚒️ + 🎨 — Auth.js default for auth routes; Fastify `@fastify/csrf-protection` for app routes
- [ ] **XSS: React auto-escape relied on** 🎨 — no `dangerouslySetInnerHTML` without WARD review
- [ ] **CSP headers** ⚒️ + 🎨 — `default-src 'self'; script-src 'self'; img-src 'self' data: <CDN>; frame-ancestors 'none'; base-uri 'self'`; report-uri to Sentry
- [ ] **No inline `<script>` or inline event handlers in JSX** 🎨
- [ ] **SQL injection: Prisma parameterized only** ⚒️ — `prisma.$queryRaw` only with `Prisma.sql` template literals; no string concat
- [ ] **Reports / analytic queries reviewed individually** 🛡️ — any raw SQL = WARD review before merge
- [ ] **Output encoding** 🎨 — Next.js handles HTML; CSV / Excel exports must escape `=`, `+`, `-`, `@`, `\t`, `\r` to prevent CSV injection (Day 1 finding precedent)
- [ ] **Filename sanitization on uploads** ⚒️ — strip `..`, `/`, control chars; store with random UUID, original name in metadata

## Headers (set globally via Caddy + Next.js + Fastify)

- [ ] `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` ⚙️
- [ ] `X-Frame-Options: DENY` ⚙️ + 🎨 (frame-ancestors in CSP supersedes for modern browsers)
- [ ] `X-Content-Type-Options: nosniff` ⚙️
- [ ] `Referrer-Policy: strict-origin-when-cross-origin` ⚙️
- [ ] `Permissions-Policy: geolocation=(), microphone=(), camera=()` ⚙️
- [ ] No `Server` header leakage (strip Express/Fastify version) ⚙️ + ⚒️

## Rate limiting

- [ ] **Login**: 5/min/IP + 10/hr/email ⚒️
- [ ] **Signup**: 3/hr/IP + 5/hr/email ⚒️
- [ ] **2FA verify**: 10/30min/user + 30/hr/IP ⚒️
- [ ] **Password reset request**: 3/hr/email + 5/hr/IP ⚒️
- [ ] **Money endpoints (top-up, payment verify, bill release)**: 10/min/user ⚒️
- [ ] **Public catalog browse**: 100/min/IP ⚒️
- [ ] **Admin endpoints**: 30/min/user (loose, but bounded) ⚒️
- [ ] Rate-limit responses include `Retry-After` header ⚒️
- [ ] Rate-limit events audit-logged when triggered ⚒️

## Secrets management

- [ ] **`.env` never committed** ⚒️ + ⚙️ — pre-commit gitleaks (Day 1 audit precedent)
- [ ] **gitleaks pre-commit hook installed at repo level** ⚙️ — see `pentest-checklist-week-13.md` for schedule of full scans
- [ ] **Production secrets in SOPS or Hashicorp Vault** ⚙️ — never in `.env.production`
- [ ] **GitHub Actions secrets used for CI** ⚙️ — never echo to logs (`set -x` disabled in secret-handling steps)
- [ ] **Dependency audit weekly** ⚙️ + ⚒️ — `pnpm audit` in CI; Dependabot enabled
- [ ] **Secret rotation runbook** 📝 — documents procedure for AUTH_SECRET, TOTP_KEK, AUDIT_COLD_KEK, DB password, BankAdapter API key

## Dependency & supply-chain

- [ ] **Lockfile committed** ⚒️ — `pnpm-lock.yaml` enforced in CI
- [ ] **No `*` or wide ranges in `dependencies`** ⚒️ — caret OK, star not
- [ ] **Renovate or Dependabot** ⚙️ — security patches auto-PR
- [ ] **`pnpm audit --prod` clean before each release** ⚙️
- [ ] **Postinstall scripts disabled by default** ⚙️ — `pnpm config set ignore-scripts true` for CI; allowlist where required (e.g., bcrypt native)
- [ ] **License audit Phase 1** 🔍 — no GPL/AGPL surprises (commercial system)

## Audit log (cross-cutting)

- [ ] **`AuditLogger` adapter wired** ⚒️ — see `audit-log-schema.md`
- [ ] **All "Always log" events firing** 🛡️ + ⚒️ — verified by smoke tests
- [ ] **PII redaction in `metadata`** ⚒️ — lint rule rejects `password`/`token`/`secret`/`code` keys
- [ ] **Append-only DB role for app** ⚙️ — INSERT only on `audit_log` table
- [ ] **Cold-tier migration cron** ⚙️ — Month 12 onward

## Operational

- [ ] **Sentry connected (FE + BE)** ⚙️ — without leaking PII (scrub email, name)
- [ ] **Uptime Kuma monitoring `/healthz`** ⚙️
- [ ] **DB daily backup + offsite copy** ⚙️ — encrypted, restore-tested monthly
- [ ] **Incident runbook drafted** 📝 — at minimum: who-to-call, log-pull-commands, Sentry/Discord links
- [ ] **Status page** 📝 — public Phase 2; internal Phase 1 OK
- [ ] **Time sync (NTP/chrony) on VPS** ⚙️ — TOTP drift, audit timestamps depend on it

## Compliance posture (Phase 1 — informational, not gating)

- [ ] **PDPA data subject rights surface mapped** 📝 — export own data, delete account flow
- [ ] **Privacy policy + ToS published** 📝
- [ ] **Cookie banner where applicable** 🎨 + 📝
- [ ] **No analytic SDKs leaking PII** 🎨 + 🛡️
- [ ] **Bank API integration scoped per provider's compliance requirements** 🔍 + 🛡️ — review when LENS picks bank

---

## Pre-commit hardening (gitleaks — Day 1 finding precedent)

```yaml
# .pre-commit-config.yaml (root)
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.18.0
    hooks:
      - id: gitleaks
  - repo: local
    hooks:
      - id: no-pii-in-audit-metadata
        name: PII in audit metadata
        entry: bash -c 'grep -rE "metadata.*(password|token|secret|code)" --include="*.ts" apps/ packages/ && exit 1 || exit 0'
        language: system
        pass_filenames: false
```

⚙️ ANVIL Week 1: install hooks at repo template level so all devs get them on first `pnpm install`.

---

## Findings already known (carry-forward from Day 1 audit)

- **Medium — PRODUCT_FORMULA_IMPLICIT** (precedent from prior audit): CSV / xlsx exports must explicit-escape leading `= + - @` to neutralize formula injection. Track in code-review checklist for any export endpoint.
- **Recommended — gitleaks pre-commit** (precedent): now baseline above.

---

🛡️ — WARD Oracle · 2026-04-27
