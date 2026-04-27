---
artifact: audit-log-schema
project: Soraphop
oracle: WARD 🛡️
date: 2026-04-27
---

# Audit Log Schema — Fields, Retention, Query Patterns

> *Auditing is not surveillance — it's evidence. If we can't prove what happened, we can't defend what we did.*

---

## 1 · AuditLogger (port)

Per addendum 2026-04-27 §2 (WARD section):
> *"Audit log = plugin. `AuditLogger` interface — concretes: `PrismaAuditAdapter`, `ExternalSinkAdapter` (Datadog/Splunk later). Application code calls `auditLog.record(event)` — doesn't know where it goes."*

```typescript
// packages/shared-types/src/audit/index.ts

export interface AuditLogger {
  /** Fire-and-forget for hot paths; await for critical events. */
  record(event: AuditEvent): Promise<void>;

  /** Bulk read for admin dashboards. Always paginated. */
  query(input: AuditQuery): Promise<AuditPage>;
}

export interface AuditEvent {
  kind: string;                  // dotted, e.g. "payment.verify_phase1"
  actor_user_id: string | null;  // null = system or unauthenticated
  target_user_id?: string | null;
  resource: string;
  action: string;
  outcome: 'allow' | 'deny' | 'error' | 'success' | 'failure';
  reason?: string;               // free text, never PII
  ip: string;
  user_agent: string;
  request_id?: string;           // correlation id (propagated via header)
  metadata?: Record<string, unknown>; // JSONB; size capped (8KB)
  created_at?: Date;             // server sets if absent
}
```

Composition root wires `AuditLogger ← PrismaAuditAdapter` (Phase 1). Future: `ExternalSinkAdapter` mirrors to SIEM.

---

## 2 · DB Schema (Prisma)

```prisma
model AuditLog {
  id               String   @id @default(cuid())
  kind             String   // indexed
  actor_user_id    String?  // indexed; null for system events
  target_user_id   String?  // indexed for "who modified user X" queries
  resource         String
  action           String
  outcome          String   // 'allow' | 'deny' | 'error' | 'success' | 'failure'
  reason           String?
  ip               String   // indexed for anomaly queries
  user_agent       String
  request_id       String?  // indexed for cross-service correlation
  metadata         Json?
  created_at       DateTime @default(now())  // indexed

  @@index([actor_user_id, created_at])
  @@index([target_user_id, created_at])
  @@index([ip, created_at])
  @@index([kind, created_at])
  @@index([request_id])
}
```

**Append-only**: no UPDATE / DELETE except retention purge (see §4). DB role for app does NOT have UPDATE/DELETE on this table.

**Tamper-evidence (recommended)**: hash chain — each row stores `prev_hash + sha256(content)`. Forgery detectable. Implement Phase 2 if compliance requires.

---

## 3 · What to log (per work-order §"Audit Log")

### 3.1 · Always log (success path)

| Category | Events | Rationale |
|----------|--------|-----------|
| Auth | `auth.signup`, `auth.login.success`, `auth.login.failed`, `auth.logout`, `auth.password_changed` | Account lifecycle |
| 2FA | All events from `2fa-flow.md §7` | Forensic: which adapter, when, by whom |
| RBAC denials | `rbac.deny.*` (any) | Anomaly detection signal |
| Role changes | `user.role.assigned`, `user.super_admin.toggled` | Privilege escalation trail |
| Wallet | `wallet.topup`, `wallet.deduction` | Money movement |
| Payment | `payment.verify_phase1/2/3`, `payment.refund`, `payment.live_mode_switched` | Financial txn |
| Claim | `claim.deduct`, `claim.appeal_submitted`, `claim.appeal_resolved` | Phase 2; financial impact |
| Supplier bills | `bill.released`, `bill.held` | Money out |
| Promotion | `promotion.created`, `promotion.product_linked`, `promotion.suspended` | Pricing override |
| Quotation | `quotation.suspended` | Admin oversight (meeting #1 §4.3) |
| Schema attempts | `schema.ddl_attempted` | Should be ZERO; alert if seen |
| 2-eye approvals | `approval.requested`, `approval.granted`, `approval.executed`, `approval.expired` | High-stakes ops |
| Permission rules | `permission_rule.created/updated/deleted` | Who changed RBAC, when |

### 3.2 · Always log (failure path)

| Event | Reason in metadata |
|-------|---------------------|
| `auth.login.failed` | wrong_password / unverified / locked / b2b_pending |
| `auth.2fa.failed` | wrong_code / drift_too_large / locked |
| `rbac.deny.*` | which gate (no_rule / super_admin / step_up / cooling_off / condition) |
| `payment.verify_failed` | bank_api_error / amount_mismatch / signature_mismatch |
| `claim.deduction_calc_failed` | input_invalid / divide_by_zero |

### 3.3 · Don't log

- Read operations of own non-sensitive data (catalog browse, own profile view) — too noisy
- Heartbeat / health-check pings
- Static asset requests
- Session refresh (see auth-config.ts events.session)
- PII in `reason` field (use `metadata` with hashed identifier if needed for anomaly correlation)

### 3.4 · NEVER log

- Passwords, even hashed
- TOTP codes (current or historical)
- TOTP secrets (encrypted or otherwise)
- Recovery codes
- Bank account numbers in full (last 4 digits OK if needed for UX)
- Full credit card numbers (we don't store these — use BankAdapter)
- JWT tokens (current or historical)
- Session cookies
- AUTH_SECRET, TOTP_KEK, or any encryption keys

**If a developer adds one of these to `metadata` accidentally, it is a Critical finding.** A pre-merge check (regex on test fixtures) is in `nfr-checklist.md`.

---

## 4 · Retention

| Tier | Retention | Storage | Access |
|------|-----------|---------|--------|
| Hot | 0–12 months | Postgres `audit_log` table | App + admin UI |
| Warm | 12–24 months | Same Postgres, partition `audit_log_YYYY` | Admin UI (slower) |
| Cold | 24m–7y | S3-compatible (Wasabi/R2) — gzip + sealed | Manual restore |
| Purge | After 7y | Cryptographic shred | Auditor sign-off required |

**Total: 7 years** per Thai accounting + financial standard (พ.ร.บ.บัญชี).

### 4.1 · Cold-tier write

Monthly cron (ANVIL):
1. Read `audit_log_YYYY-MM` partition into NDJSON
2. gzip + AES-256 encrypt with separate key (`AUDIT_COLD_KEK`)
3. Upload to S3 with object lock (compliance retention mode)
4. Verify SHA256 round-trip
5. Drop partition from hot Postgres
6. Audit event: `audit.tier_migration_completed`

### 4.2 · Restore

Manual procedure documented in runbook. Requires super-admin + 2-eye + cooling-off. Restored data goes to `audit_log_restore_<request_id>` table, read-only, expires after 90 days.

---

## 5 · Query patterns

### 5.1 · "Who changed user X's role?"

```sql
SELECT * FROM audit_log
WHERE target_user_id = $1
  AND kind IN ('user.role.assigned', 'user.super_admin.toggled')
ORDER BY created_at DESC;
```

Index: `(target_user_id, created_at)`.

### 5.2 · "All actions by user Y in last 24h"

```sql
SELECT * FROM audit_log
WHERE actor_user_id = $1
  AND created_at >= NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC
LIMIT 1000;
```

Index: `(actor_user_id, created_at)`.

### 5.3 · "Anomalous activity from IP Z"

```sql
SELECT actor_user_id, COUNT(*), MIN(created_at), MAX(created_at)
FROM audit_log
WHERE ip = $1
  AND created_at >= NOW() - INTERVAL '7 days'
GROUP BY actor_user_id
HAVING COUNT(*) > 100;
```

Use case: same IP touching many users = scraping or compromised proxy.

### 5.4 · "All RBAC denials for action X (rule misconfig?)"

```sql
SELECT actor_user_id, COUNT(*) FROM audit_log
WHERE kind = 'rbac.deny.no_rule'
  AND action = $1
  AND created_at >= NOW() - INTERVAL '7 days'
GROUP BY actor_user_id;
```

If this trends up after a deploy → permission rule regressed. Alert.

### 5.5 · "Payment verifications without prior login"

```sql
WITH verifies AS (
  SELECT actor_user_id, created_at FROM audit_log
  WHERE kind LIKE 'payment.verify_phase%' AND outcome = 'success'
)
SELECT v.* FROM verifies v
LEFT JOIN audit_log al
  ON al.actor_user_id = v.actor_user_id
  AND al.kind = 'auth.login.success'
  AND al.created_at BETWEEN v.created_at - INTERVAL '8 hours' AND v.created_at
WHERE al.id IS NULL;
```

Should always return zero rows. Alert if ever non-zero (replay / forged session).

---

## 6 · Performance

| Concern | Mitigation |
|---------|-----------|
| Write hot path latency | `record()` async on noncritical paths; await only on auth + payment |
| Storage growth | Estimate: ~50 events/active user/day × DAU × 1KB = manageable for Year 1 |
| Index bloat | Monthly `REINDEX CONCURRENTLY` on `(actor_user_id, created_at)` and `(ip, created_at)` |
| Read load on admin queries | Read replica Phase 2 if admin dashboard slow |

Estimate at 1000 DAU: 50,000 events/day × 365 = 18M rows/year. Postgres handles this easily; cold-tier kicks in Month 12.

---

## 7 · Findings

### Medium — Hash-chain tamper-evidence not implemented Phase 1

**Scope**: An admin with DB write access could backdate / delete entries. Hash-chain catches this.
**Defer**: Phase 2; complexity not justified for current threat model (small team, Hetzner VPS, ANVIL controls DB access).
**Mitigation now**: revoke direct DB write to `audit_log` from app role (only INSERT). Daily backup compare against prior day for unexpected mutations.

### Low — Metadata field is JSONB without schema

**Scope**: developers may stuff PII or sensitive data without realizing.
**Mitigation**: lint rule that warns on `metadata: { password, token, secret, code }` keys at build time. Add to NFR pre-commit (`nfr-checklist.md`).
**Defer**: ship lint rule before first audit-emitting code lands.

### Info — Audit log access itself audited?

**Yes**: `audit_log.view_self` and `audit_log.view_all` are permission rules in skeleton. Each read of `view_all` (super-admin op) records `audit_log.read_all` — auditing the auditor. Self-reads (own history) not logged (too noisy + low risk).

---

🛡️ — WARD Oracle · 2026-04-27
