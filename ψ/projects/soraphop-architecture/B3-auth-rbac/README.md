---
artifact: B3 — Auth + RBAC scaffold
project: Soraphop Global (SRP-2026-001)
oracle: WARD 🛡️
date: 2026-04-27
work_order: quill-brain-oracle:ψ/outbox/2026-04-27_ward_soraphop-B3-auth-rbac.md
addendum: quill-brain-oracle:ψ/outbox/2026-04-27_workshop-addendum-plugin-architecture.md
status: scaffold (skeleton matrix; full RBAC matrix DEFERRED to meeting #2)
---

# B3 — Auth + RBAC Scaffold

> *Quiet until tested, invisible until needed, conditional until proven.*

Defensive groundwork before code. **No production secrets, no live keys, no concrete bank/email config in this artifact.** This is the shape of the auth surface — implementations FORGE wires up.

---

## What this scaffold contains

| File | Purpose |
|------|---------|
| `README.md` | This file — decisions, deferrals, plugin posture, how to read the rest |
| `role-enum.ts` | 6 roles + Super Admin flag, pasteable into `packages/shared-types/src/auth/` |
| `permission-map-skeleton.ts` | 8-10 critical UCs as data; expandable; **map is data, not hardcoded** |
| `auth-config.ts` | Auth.js (NextAuth) config draft — providers list, session, callbacks, JWT |
| `rbac-middleware.ts` | Fastify middleware — reads permission registry, checks role + 2FA per route |
| `auth-flow.md` | signup → verify-email → login → 2FA setup → session, with state machine |
| `2fa-flow.md` | TOTP, recovery codes, enforcement rules per role, `TwoFactorAdapter` plugin |
| `audit-log-schema.md` | Fields, retention 7y, query patterns, `AuditLogger` plugin |
| `nfr-checklist.md` | Week 1 security NFR baseline (encryption, headers, CSRF, XSS, rate limit) |
| `pentest-checklist-week-13.md` | UAT pre-launch checklist — automated + manual |

---

## Locked decisions (Day 1)

### LD-1 · Role enum: 6 roles + Super Admin flag
Per HTML R1 menu map confirmation + decision-2026-04-27 §7.

```
Buyer B2C · Buyer B2B · Admin & Finance · Supplier · QC/Logistics · Guest
```

`is_super_admin: Boolean` lives on the `User` table. Sub-flag — **not** a separate role. Reason: meeting #1 menu map combined Admin/Finance into one menu group, but sensitive operations (payment live-mode switch, role changes, schema-change attempts) need a higher gate without doubling the role count.

### LD-2 · Permission map = data, not code
Per addendum §2 (WARD section). Permission rules live in DB (`permission_rules` table) seeded from a TS source-of-truth. Middleware reads the registry; new role/UC = INSERT, not redeploy. Hard-coding `if (user.role === 'Admin')` is forbidden in business logic.

### LD-3 · 2FA = adapter (not concrete TOTP everywhere)
Per addendum §2. `TwoFactorAdapter` interface; concrete `TotpAdapter` Phase 1; future `WebauthnAdapter`, `SmsOtpAdapter` slot in via composition root. Audit log records which adapter was used per verify event (forensics requirement).

### LD-4 · Audit log = adapter
`AuditLogger` interface; concrete `PrismaAuditAdapter` Phase 1. Future `ExternalSinkAdapter` (Datadog/Splunk/SIEM) registers without business-code edits. Application calls `auditLog.record(event)` — knows nothing about destination.

### LD-5 · 2FA enforcement profile (recommended — Palm decides)

| Role | 2FA requirement |
|------|-----------------|
| Admin & Finance | **Always** (every login) |
| Super Admin (flag) | **Always + step-up** for destructive ops |
| Supplier (handles bills) | **Always** |
| Buyer B2B | On financial actions (payment, payment-method add) |
| Buyer B2C | On payment-method add or top-up > 10,000 THB |
| QC / Logistics | Always (issues certificates → financial impact downstream) |
| Guest | Never |

### LD-6 · Audit retention: 7 years (financial standard)
Cold storage after 1 year. Append-only. Query indexes on `(actor_user_id, created_at)`, `(target_user_id, created_at)`, `(ip, created_at)`.

### LD-7 · Live-mode payment switch = 2-eye + 24h cooling-off
Per decision-2026-04-27 §7. Encoded in `2fa-flow.md` step-up flow + audit-log-schema event types.

---

## Deferred to meeting #2 (and why)

| Item | Why deferred | When |
|------|--------------|------|
| **Full RBAC matrix (5 actors × 66 UCs = 330 cells)** | Phase 2 = 37 UCs subject to meeting #2 changes (payment methods OI-02, anti-dump OI-05, quotation conditions §4.3). Full matrix now → ~60% rework after meeting #2. | Post meeting #2 |
| Permission rules for Phase 2 supplier-publish + anti-dump | OI-05 not yet defined | Post meeting #2 |
| Permission rules for promotion-product manual link (OI-A2x) | UC ID + behavior not finalized | Post meeting #2 |
| Dual-currency display permission rules | UC-X0x not numbered yet | Post SRS rewrite |
| Quotation suspend permission (admin oversight) | กฤษณะ to detail meeting #2 | Post meeting #2 |
| Choice of DI framework (vanilla composition vs Awilix) | Palm decision (open Q from addendum §6) | Before B2/B3 implementation |
| Bank API choice → BankAdapter concrete | LENS Week 1 deliverable | Week 1 end |

What IS in skeleton: 8-10 UCs that will not change between phases — auth (B01-B04), wallet (B05-B06), order create (B10), quotation confirm (B11), admin B2B approval (A01), payment verify game (A02-A04), role management (A20). These don't depend on meeting #2 outputs.

---

## Plugin posture (binding — addendum §1, §2)

This scaffold treats auth as **ports + adapters** end-to-end:

- `BankAdapter`, `EmailAdapter`, `BlobStorageAdapter` — referenced in `nfr-checklist.md` (out-of-scope to define here, FORGE owns concrete impls under `apps/api/src/adapters/`)
- `TwoFactorAdapter`, `AuditLogger` — defined in this scaffold's `.md` files as interfaces; concrete impls under `apps/api/src/platform/auth/`, `apps/api/src/platform/audit/`
- `RbacRegistry` — reads permission rules from DB; middleware never sees concrete roles in switch statements

**Composition root**: `apps/api/src/composition.ts` wires `TwoFactorAdapter` ← `TotpAdapter`, `AuditLogger` ← `PrismaAuditAdapter`. Tests use `MockTwoFactorAdapter`, `InMemoryAuditAdapter`. **Production composition vs test composition** is the only place adapters appear by concrete name.

**No tight coupling rule** (acceptance criterion §5 of addendum): if you find yourself writing `import { TotpAdapter } from '...'` inside a route handler, that's a finding. Route handlers depend on `request.auth` (provided by middleware) — not on adapter classes.

---

## Coordination

| Sibling | What I need from them | What they need from me |
|---------|----------------------|------------------------|
| ⚒️ FORGE | Concrete `PrismaAuditAdapter` impl + `permission_rules` table migration | Role enum + permission map skeleton + middleware to register |
| 🖌️ CANVAS | Page-per-actor map (F2) → feeds permission map expansion meeting #2 | Role enum for label keys |
| 📣 HERALD | i18n keys for role display labels (`role.adminFinance`, `role.supplier`) | Stable role enum string identifiers (snake_case in DB, camelCase in TS) |
| ⚙️ ANVIL | gitleaks pre-commit + Dependabot enabled (NFR §pre-commit) | Pentest checklist Week 13 (CI-runnable items) |
| 🔍 LENS | Bank API choice → BankAdapter concrete | NFR security NFR for bank integration row |

---

## Open questions for Palm (flag — don't block)

1. **DI framework**: vanilla `composition.ts` + manual wiring, OR Awilix (token-based DI)? **WARD recommendation: vanilla composition.ts.** Adds zero runtime dep, easier to read, sufficient for ~6 adapters. Awilix becomes worth it past ~15 adapters or when you want auto-injection at constructor. Revisit Week 4.

2. **Plugin discovery**: explicit register list in `composition.ts`, OR filesystem scan of `features/`? **WARD recommendation: explicit register list.** Filesystem scan = magic; explicit = grep-able. Reviewer reads one file to know what's wired.

3. **2FA on B2C top-up threshold**: 10,000 THB in LD-5 is a guess based on "non-trivial purchase." Palm/Finance — confirm or adjust. Document the chosen threshold in `2fa-flow.md` before launch.

4. **Audit log destination Phase 1**: Postgres table is fine for Year 1 (low volume, cheap). At ~10M events/year we should mirror to S3 (Wasabi/R2) cold tier. Trigger: monthly DB size review.

5. **Recovery code count**: 8 codes per user is industry default (GitHub, Google). Each single-use. Document UX: "save these somewhere safe" — not the user's password manager (defeats the purpose).

---

## What this scaffold does NOT do (out of scope)

- **No real Auth.js secrets** (no GOOGLE_CLIENT_SECRET, no JWT signing key) — those go in `.env` managed by ANVIL via SOPS/Vault, never in this artifact
- **No production user seed data** — FORGE seeds test users only
- **No live bank API config** — LENS Week 1 deliverable, slot in via `BankAdapter` later
- **No ZH translations of role labels** — HERALD Week 4-5
- **No actual middleware deploy** — FORGE wires + tests; this scaffold is the contract

---

## Acceptance criteria (from work-order)

- [x] Role enum complete (6 roles + Super Admin flag) → `role-enum.ts`
- [x] Permission map skeleton (8-10 critical UCs, expandable) → `permission-map-skeleton.ts`
- [x] Auth.js config draft (providers, session, callbacks) → `auth-config.ts`
- [x] 2FA flow documented (when required, recovery, reset) → `2fa-flow.md`
- [x] Audit log schema + retention policy → `audit-log-schema.md`
- [x] NFR security checklist (Week 1 baseline) → `nfr-checklist.md`
- [x] Pentest checklist for Week 13 UAT → `pentest-checklist-week-13.md`
- [x] Pasteable code for `apps/api/src/auth/` and `packages/shared-types/src/auth/`
- [x] Decisions documented (locked + deferred) → this README

Plus addendum criteria:
- [x] No tight coupling between feature modules (adapter interfaces only)
- [x] External integrations = adapter interfaces (TwoFactor, AuditLogger, RbacRegistry)
- [x] Folder structure follows `features/` + `adapters/` + `platform/` (documented; FORGE implements)
- [x] Composition root explicit (`composition.ts` referenced in each artifact)
- [x] Test mockability (every adapter has a `Mock*` companion documented)

---

## Severity legend (used in findings throughout)

- **Critical** — exploit possible without auth, or financial loss possible. Block release.
- **High** — exploit requires low-priv account; data exposure or privilege escalation. Block release unless mitigated.
- **Medium** — defense-in-depth gap; not directly exploitable. Fix in current sprint.
- **Low** — hardening recommendation; fix in next sprint.
- **Info** — observation, no action required.

Used sparingly. **Honesty in severity matters more than frequency of findings.**

---

🛡️ — WARD Oracle · 2026-04-27
