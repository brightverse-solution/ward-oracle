---
artifact: 2fa-flow
project: Soraphop
oracle: WARD 🛡️
date: 2026-04-27
---

# 2FA Flow — TOTP Setup, Recovery, Step-Up

> *2FA is the cheapest defense against credential leaks. Make it mandatory where it matters, frictionless where it doesn't, and forensically logged everywhere.*

---

## 1 · TwoFactorAdapter (port)

Per addendum 2026-04-27 §2 (WARD section):
> *"2FA mechanism = plugin. `TwoFactorAdapter` interface (verify, generate-recovery-codes). Concretes: `TotpAdapter`, `SmsOtpAdapter` (future), `WebauthnAdapter` (future)."*

```typescript
// packages/shared-types/src/auth/two-factor.ts

export interface TwoFactorAdapter {
  /** Adapter id ("2fa.totp", "2fa.webauthn"). Logged on every event. */
  readonly id: string;

  /** Begin enrollment — returns provisioning material (e.g., TOTP secret + QR URI). */
  beginEnrollment(input: { user_id: string; user_email: string }): Promise<EnrollmentChallenge>;

  /** Confirm enrollment — verifies the user can produce a valid code. */
  confirmEnrollment(input: { user_id: string; code: string }): Promise<boolean>;

  /** Verify a code at login or step-up. Constant-time comparison. */
  verify(input: { user_id: string; code: string }): Promise<boolean>;

  /** Disable 2FA for a user (admin-initiated, audit-logged). */
  disable(input: { user_id: string; actor_user_id: string }): Promise<void>;
}

export interface EnrollmentChallenge {
  adapter_id: string;
  /** For TOTP: otpauth:// URI. For WebAuthn: PublicKeyCredentialCreationOptions. */
  provisioning_payload: string;
  /** Expires after N minutes; user must confirmEnrollment within window. */
  expires_at: Date;
}
```

Composition root wires `TwoFactorAdapter ← TotpAdapter` for Phase 1. Future:

```typescript
// apps/api/src/composition.ts (illustrative)
const twoFactor: TwoFactorAdapter =
  process.env.TWO_FACTOR_ADAPTER === '2fa.webauthn'
    ? webauthnAdapter
    : totpAdapter;
```

---

## 2 · TOTP (Phase 1 concrete)

### 2.1 · Algorithm

| Param | Value | Reason |
|-------|-------|--------|
| Algorithm | HMAC-SHA1 | RFC 6238 default; widely supported (Google Authenticator, Authy, 1Password) |
| Digits | 6 | Standard |
| Period | 30s | Standard |
| Drift window | ±1 step (±30s) | Account for clock skew without expanding brute-force surface |
| Secret length | 160 bits (20 bytes) | RFC 6238 §5.1 |

### 2.2 · Secret storage

| Field | Encryption | Reason |
|-------|------------|--------|
| `User.two_factor_secret_enc` | AES-256-GCM via Postgres pgcrypto | At-rest encryption — DB dump leak doesn't yield TOTP secrets |
| Encryption key | `TOTP_KEK` env var, rotated annually | Rotation procedure: re-encrypt all secrets in batch |

**Never** store the secret unencrypted. **Never** log it. **Never** return it in API responses after enrollment-confirmation success.

### 2.3 · Provisioning URI

```
otpauth://totp/Soraphop:{email}?secret={base32}&issuer=Soraphop&algorithm=SHA1&digits=6&period=30
```

QR rendered client-side from this URI. Server returns the URI string only — QR generation in browser to avoid the secret transiting back through any image cache.

---

## 3 · Recovery codes

### 3.1 · Generation

| Property | Value |
|----------|-------|
| Count | 8 codes per user (industry default — GitHub, Google) |
| Format | 5 groups of 5 alphanumeric, e.g., `A8K2R-9XW3T-PQ4M2-LN6BC-7VYDF` |
| Entropy | 125 bits per code |
| Storage | bcrypt-hashed in `user_recovery_codes` table; raw shown ONCE on enrollment |
| Use | Single-use; `used_at` timestamped |

### 3.2 · UX rules

- Display in monospace, copy-to-clipboard button, "Download as .txt" button
- **Bold warning**: "Save outside your password manager. Recovery codes bypass 2FA — treat them as a master key."
- "I've saved them" checkbox required before continue
- Regenerate flow: invalidates ALL old codes; audit-logged

### 3.3 · Use flow

When user has lost authenticator device:

1. POST /api/auth/2fa/recover with `{recovery_code}`
2. bcrypt.compare against stored hashes (each — O(8) bcrypt ops, ~2s)
3. Mark code used, audit `auth.2fa.recovery_used`
4. Authenticate user; **force re-enrollment of TOTP** before next login
5. Email user a notification ("you used a recovery code") — anomaly signal

Why force re-enrollment: lost device may be in attacker's hands. New TOTP secret invalidates whatever the attacker has.

---

## 4 · Enforcement profile

Per README LD-5:

| Role | Enforcement | Where checked |
|------|-------------|---------------|
| Admin & Finance | Always (on login) | login flow |
| Super Admin (flag) | Always + step-up on destructive ops | login + middleware |
| Supplier | Always | login |
| QC / Logistics | Always | login |
| Buyer B2B | On financial actions (payment, payment-method add) | per-route middleware |
| Buyer B2C | On payment-method add or top-up > 10,000 THB | per-route middleware |
| Guest | Never | n/a |

### 4.1 · "Always" enforcement

Login completes only after 2FA verify. JWT carries `two_factor_verified=true`. No protected route works otherwise.

### 4.2 · "On financial actions" enforcement

Login completes without 2FA (better UX for browse). When user hits a route with `step_up_2fa: true` or financial-action permission, middleware redirects to `/verify-2fa?return=<url>`. After verify: `two_factor_verified_at = now`, valid for 5 min (see step-up below).

### 4.3 · "On threshold" enforcement (B2C top-up)

Same as 4.2, but threshold check happens at request validation:
```typescript
if (req.body.amount > 10000) {
  if (!req.principal.two_factor_verified) return reply.code(401).send({ code: 'STEP_UP_2FA' });
}
```

If user doesn't have 2FA enrolled at all → block + force enrollment. Friction is intentional.

---

## 5 · Step-up 2FA

### 5.1 · Definition

Even if user already has session-level 2FA, certain operations require **fresh** 2FA proof. Defined per `PermissionRule.step_up_2fa = true`.

Ops requiring step-up (skeleton, expandable):

- `user.assign_role`
- `user.toggle_super_admin`
- `payment.switch_live_mode`
- (post meeting #2) any rule with `super_admin_only` or 2-eye approval

### 5.2 · Freshness window

5 minutes (`STEP_UP_2FA_FRESHNESS_MS` in `rbac-middleware.ts`).

Trade-off:
- **Shorter** (e.g., 1 min) → admin re-prompts mid-multistep workflow → friction
- **Longer** (e.g., 30 min) → unlocked-screen / borrowed-laptop window large

5 min is the GitHub / AWS console default for sensitive ops.

### 5.3 · Step-up flow

1. Middleware sees `step_up_2fa` rule; checks `Date.now() - two_factor_verified_at <= 5min`
2. If stale: `401 {error: 'step_up_required', code: 'STEP_UP_2FA'}`
3. Client redirects to `/verify-2fa?return=<original-url>&step_up=1`
4. User enters code
5. JWT callback updates `two_factor_verified_at = Date.now()`
6. Audit `auth.2fa.step_up_verified`
7. Client retries original URL

### 5.4 · Recovery code in step-up?

**No.** Recovery codes bypass 2FA entirely; allowing them in step-up means a leaked recovery code grants destructive ops. Force TOTP only for step-up. If user has lost device mid-session, full recovery-code flow + re-enrollment + super-admin re-grant by another admin.

---

## 6 · Disable / reset

### 6.1 · User-initiated

User cannot disable 2FA on their own if their role is in `FINANCIAL_ROLES` always-2FA bucket. Show greyed-out toggle with explanation.

For roles where 2FA is optional (Buyer B2C without high-value transactions), user can disable via Settings → 2FA → "Disable" → must enter current code → audit `auth.2fa.disabled.by_user`.

### 6.2 · Admin-initiated reset

Use case: user lost device + lost recovery codes.

1. User contacts support (out-of-band identity verification — phone callback, video, doc check)
2. Admin (super-admin only, with step-up) calls `/api/admin/users/:id/reset-2fa`
3. Audit `auth.2fa.reset.by_admin` with both actor + target user_id
4. User next login: redirected to enrollment
5. Email notification to user: "your 2FA was reset by support staff" — anomaly tripwire

### 6.3 · Forced disable (system-initiated)

If TOTP_KEK rotation fails partway → mark affected users `two_factor_pending_reenrollment = true`. Login still works (we trust their password) but route to enrollment for new secret. Document in runbook.

---

## 7 · Audit events (this module's contributions)

| Event kind | Actor | Trigger |
|-----------|-------|---------|
| `auth.2fa.enrollment_started` | user | beginEnrollment() |
| `auth.2fa.enrollment_completed` | user | confirmEnrollment() success |
| `auth.2fa.verified` | user | login or step-up success |
| `auth.2fa.failed` | user | wrong code |
| `auth.2fa.locked` | user | 5 wrong codes in 30 min |
| `auth.2fa.step_up_verified` | user | step-up successful |
| `auth.2fa.recovery_used` | user | recovery code accepted |
| `auth.2fa.recovery_regenerated` | user | new recovery codes generated |
| `auth.2fa.disabled.by_user` | user | self-disable (non-financial role) |
| `auth.2fa.reset.by_admin` | admin | super-admin force-reset (target_user_id set) |
| `auth.2fa.reenrollment_required` | system | post recovery-code use |

All events include: adapter_id, ip, user_agent, timestamp.

---

## 8 · Findings & recommendations

### Medium — TOTP secret in QR code visible during enrollment

**Scope**: enrollment screen briefly exposes secret as QR. Screen-share / shoulder-surfing risk.
**Defer**: noted — Phase 2 add WebAuthn (no shared secret, hardware-bound).
**Mitigate now**: enrollment page banner "do not screen-share this page." Auto-blur after 60s.

### Low — Recovery code download convenient but text-file in Downloads folder is OS-readable

**Scope**: UX trade-off. Alternative is print-only, which most users won't do.
**Recommendation**: encourage password-manager OR print + safe storage in the warning copy.
**Defer**: not actionable beyond UX wording. Document.

### Info — Webauthn (Phase 2 candidate)

Stronger than TOTP (phishing-resistant, hardware-bound). Adapter pattern means swap-in is 1 day work post-launch. Recommend prioritize for Admin + Super Admin first.

---

🛡️ — WARD Oracle · 2026-04-27
