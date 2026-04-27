---
artifact: auth-flow
project: Soraphop
oracle: WARD 🛡️
date: 2026-04-27
---

# Auth Flow — Signup → Verify → Login → 2FA → Session

> *Every state transition produces an audit event. Every error returns a generic message. Every secret stays out of git.*

---

## States

```
┌─────────┐  signup    ┌──────────────┐  verify_email  ┌──────────┐
│  Guest  │ ─────────► │ EmailPending │ ─────────────► │ Verified │
└─────────┘            └──────────────┘                └──────────┘
                                                           │
                              ┌────────────────────────────┘
                              │ (B2B only)
                              ▼
                       ┌──────────────┐  admin_approve   ┌──────────┐
                       │ AdminPending │ ───────────────► │ Approved │
                       └──────────────┘                  └──────────┘
                                                              │
                                                              ▼ login (credentials ok)
                                                      ┌───────────────┐
                                                      │ AuthedNo2FA   │
                                                      └───────────────┘
                                                              │
                              ┌─────── if 2FA enrolled ───────┤
                              │                               │ if not enrolled
                              ▼                               ▼
                       ┌─────────────┐                 ┌─────────────────┐
                       │ 2FAChallenge│                 │ 2FAEnrollPrompt │
                       └─────────────┘                 │ (if FINANCIAL_   │
                              │                        │  ROLE: required) │
                              ▼ verify_2fa             └─────────────────┘
                       ┌────────────┐                          │
                       │  Authed   │ ◄─────── enroll ──────────┘
                       └────────────┘
                              │
                              ▼ idle > maxAge | logout | demoted
                       ┌───────────┐
                       │ SignedOut │
                       └───────────┘
```

---

## 1 · Signup (UC-B01, UC-B02)

### 1.1 · B2C signup (UC-B01)

| Step | Action | Failure mode |
|------|--------|--------------|
| 1 | POST /api/auth/signup with `{email, password, accept_terms}` | rate-limit: 3/hr/IP, 5/hr/email |
| 2 | zod validate (email format, password ≥ 12 chars + complexity) | 400 + generic message |
| 3 | Check email uniqueness (constant-time response — same delay on hit/miss) | **enumeration risk if not constant-time → High** |
| 4 | Hash password with bcrypt (rounds = 12) | server-side cost ~250ms |
| 5 | INSERT User (email_verified_at = null, role = buyer_b2c, two_factor_enabled = false) | DB transaction |
| 6 | Generate verification token (32 bytes random, hashed in DB; raw value emailed) | TTL 24h, single-use |
| 7 | EmailAdapter.send(verification template) | retry on transient failure (queue) |
| 8 | Audit: `auth.signup.b2c` | always logged |
| 9 | Response: 200 + "check your email" — same response whether email existed or not | enumeration prevention |

### 1.2 · B2B signup (UC-B02)

Same as B2C plus:

| Step | Action |
|------|--------|
| 5a | INSERT Company (status=pending) + link to User |
| 5b | Upload company docs to BlobStorageAdapter (S3/Wasabi) — antivirus scan before persist (`MockBlobAdapter` returns clean in test) |
| 5c | User.role = buyer_b2b but **not active** until UC-A01 admin approval |
| 9 | Response: "we'll review and email you" |

### 1.3 · Guest browse (no signup)

`Guest` role assigned implicitly to unauthenticated requests. Permission registry expresses what Guest can hit (catalog browse, language change). **Never** confer write permissions to Guest.

---

## 2 · Email verification

| Step | Action | Failure mode |
|------|--------|--------------|
| 1 | GET /api/auth/verify-email?token=… | rate-limit: 10/hr/IP |
| 2 | Hash token, lookup; reject if not found / expired / already-used | generic 400 |
| 3 | UPDATE User SET email_verified_at = NOW() | atomic |
| 4 | Audit: `auth.email_verified` | |
| 5 | If B2B: stay AdminPending; redirect to "thank you, awaiting approval" | |
| 6 | If B2C: redirect to /login | |

**Token reuse**: must be invalidated after first success. **Token leak via referrer**: send only via email (don't expose in URL after verify — rewrite to `/verified` immediately).

---

## 3 · Login (UC-B03)

### 3.1 · Credentials

| Step | Action | Failure mode |
|------|--------|--------------|
| 1 | POST /api/auth/sign-in (Auth.js Credentials provider) | rate-limit: 5/min/IP, 10/hr/email |
| 2 | zod validate `{email, password, csrf_token}` | 400 + generic |
| 3 | Look up user; if missing → run dummy bcrypt to equalize timing | timing attack mitigation |
| 4 | bcrypt.compare → check `email_verified_at`, `locked_at`, `b2b_approved_at` | all errors: same message "invalid credentials" |
| 5 | If failed_attempts ≥ 5 in last hour → set `locked_at = NOW() + 30min` | progressive lock |
| 6 | Audit: `auth.login.success` or `auth.login.failed` (with reason in metadata, NOT in response) | |
| 7 | If user.two_factor_enabled → JWT issued with `two_factor_verified = false`; redirect to /verify-2fa | |
| 8 | Else if FINANCIAL_ROLE → force /enroll-2fa before any other route | enforced by middleware |
| 9 | Else → JWT with `two_factor_verified = false` (will be promoted on first 2FA verify) | |

### 3.2 · 2FA challenge

| Step | Action |
|------|--------|
| 1 | POST /api/auth/verify-2fa with `{code}` |
| 2 | TwoFactorAdapter.verify(user_id, code) — adapter resolved at composition root |
| 3 | On success: update JWT: `two_factor_verified = true`, `two_factor_verified_at = Date.now()` |
| 4 | Audit: `auth.2fa.verified` (with adapter id in metadata) |
| 5 | On 5 wrong codes: lock 30 min, audit `auth.2fa.locked` |

### 3.3 · 2FA enrollment (first time)

See `2fa-flow.md` — full TOTP setup ritual + recovery codes.

---

## 4 · Session lifetime

| Property | Value | Source |
|----------|-------|--------|
| Strategy | JWT, stateless | auth-config.ts |
| Absolute max age | 8 hours | auth-config.ts session.maxAge |
| Sliding refresh | 30 min on activity | auth-config.ts session.updateAge |
| Cookie | `__Secure-` prefix, HttpOnly, Secure, SameSite=Strict | auth-config.ts cookies |
| Step-up 2FA freshness | 5 min for `step_up_2fa` ops | rbac-middleware.ts |
| CSRF | double-submit token (Auth.js default) | auth-config.ts |

### 4.1 · Logout

`POST /api/auth/sign-out` clears cookie; JWT cannot be revoked individually (stateless). To force-logout a user (security event):

1. Increment user's `session_epoch` column
2. JWT carries the epoch at issue time
3. JWT callback rejects on epoch mismatch
4. User is logged out at next refresh (≤ 30 min)

This is the trade-off of JWT. Acceptable for non-emergency demotion; for emergency revocation (compromised account), pair with email/SMS notification + force password reset.

### 4.2 · Demotion (role change while logged in)

JWT callback re-reads role + is_super_admin every `updateAge` (30 min). Demotion takes effect within that window. Acceptable; documented.

For step-up ops (super_admin_only + step_up_2fa), middleware does a fresh DB read of `is_super_admin` — demotion takes effect immediately on those routes.

---

## 5 · Failure surface table

| Scenario | Response | Status | Audit kind |
|----------|----------|--------|-----------|
| Bad email format | "Invalid input" | 400 | (none) |
| Email exists | "Check your email" (same as success) | 200 | `auth.signup.duplicate_email_attempt` |
| Wrong password | "Invalid credentials" | 401 | `auth.login.failed` |
| Unverified email | "Invalid credentials" | 401 | `auth.login.failed.unverified` |
| Account locked | "Invalid credentials" | 401 | `auth.login.failed.locked` |
| B2B not approved | "Account pending review" | 403 | `auth.login.failed.b2b_pending` |
| 2FA wrong code | "Invalid code" | 401 | `auth.2fa.failed` |
| 2FA locked | "Too many attempts. Try again later." | 429 | `auth.2fa.locked` |
| Verify token expired | "Link expired or already used" | 400 | `auth.verify.token_invalid` |
| CSRF token missing | "Invalid request" | 403 | `auth.csrf.missing` |
| Step-up required | `{error:'step_up_required',code:'STEP_UP_2FA'}` | 401 | `rbac.deny.step_up_required` |
| Cooling-off active | `{error:'cooling_off_pending',code:'COOLING_OFF'}` | 425 | `rbac.deny.cooling_off_pending` |

**Generic-message rule**: never reveal whether email exists, whether account is unverified vs locked vs unapproved, or which password attempt count we're at. Reasoning: each piece of information is an enumeration / brute-force aid.

---

## 6 · Open questions for Palm (flagged here, decision in README)

1. **B2C top-up 2FA threshold**: 10,000 THB? 5,000? Per-user opt-in? Pending Palm.
2. **Recovery code count**: 8 default. Pending Palm.
3. **Force-logout on password change**: yes (industry standard). No questions.

---

## 7 · Pasteable test plan (FORGE wires real impl, WARD reviews)

```typescript
// apps/api/test/auth-flow.spec.ts (illustrative)

describe('signup', () => {
  it('returns same body whether email exists or not (enumeration)', async () => {
    const a = await signup({ email: 'new@e.com', password: 'Aa1!aaaaaaaa' });
    const b = await signup({ email: 'taken@e.com', password: 'Aa1!aaaaaaaa' });
    expect(a.body).toEqual(b.body);
    // Timing: both within ±50ms of each other (constant-time bcrypt path)
  });

  it('rejects weak password', async () => { /* ... */ });
  it('rate-limits after 3/hr/IP', async () => { /* ... */ });
});

describe('login', () => {
  it('does not reveal locked vs wrong-password', async () => { /* ... */ });
  it('runs dummy bcrypt for non-existent email (timing equality)', async () => { /* ... */ });
});

describe('2fa', () => {
  it('rejects code on freshness > 5 min for step-up ops', async () => { /* ... */ });
});
```

---

🛡️ — WARD Oracle · 2026-04-27
