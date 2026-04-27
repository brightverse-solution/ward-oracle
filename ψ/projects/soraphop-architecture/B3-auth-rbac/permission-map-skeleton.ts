/**
 * Soraphop — Permission Map (skeleton, B3 scaffold)
 *
 * Pasteable into: packages/shared-types/src/auth/permissions.ts
 * Loaded into DB seeder at: apps/api/prisma/seed/permissions.ts (FORGE)
 *
 * Per addendum 2026-04-27 §2 (WARD section):
 *   "RBAC permission map = data, not code.
 *    Permission rules in DB (or config file) — not hardcoded in middleware.
 *    Middleware reads permission registry → generic check.
 *    New role? Add row, no code deploy."
 *
 * This file is the SOURCE OF TRUTH for the seed. The runtime registry reads
 * from `permission_rules` table. Middleware never imports this file directly.
 *
 * --------------------------------------------------------------------------
 * Skeleton scope: 8-10 critical UCs that DON'T change between Phase 1 and 2.
 * Full matrix (5 actors × 66 UCs = 330 cells) DEFERRED to post meeting #2.
 * Reason: see README §"Deferred to meeting #2".
 * --------------------------------------------------------------------------
 */

import { ROLES, type Role } from './role-enum';

/**
 * Permission rule shape.
 *
 * Why this shape (not a role → action[] map):
 *  - Easy to query: "who can do X?" = WHERE action = X
 *  - Easy to extend: add a `condition` JSONB column for ABAC later
 *    (e.g., "buyer can cancel only own order in pending state")
 *  - Index-friendly: (action, resource) lookup is the hot path
 */
export interface PermissionRule {
  /** Verb. Snake_case. Stable. */
  action: string;

  /** Noun (entity / domain object). Stable. */
  resource: string;

  /** Roles allowed to perform this action on this resource. */
  roles: readonly Role[];

  /**
   * Step-up 2FA required even if user already has session 2FA.
   * Use for destructive / high-value operations.
   * See: 2fa-flow.md "step-up" section.
   */
  step_up_2fa?: boolean;

  /**
   * Requires is_super_admin flag in addition to role match.
   * See: role-enum.ts isSuperAdmin().
   */
  super_admin_only?: boolean;

  /**
   * 2-eye approval required (second human approves before execution).
   * See: decisions-2026-04-27 §7.
   */
  two_eye_approval?: boolean;

  /**
   * Cooling-off period in hours between request and execution.
   * 0 / undefined = no cooling-off.
   */
  cooling_off_hours?: number;

  /** UC reference for traceability (helps reviewers + audit). */
  uc_refs: readonly string[];

  /**
   * Optional ABAC condition expressed as a string token.
   * Resolved by middleware via a registered condition evaluator.
   * Examples: 'owner', 'same_company', 'order.status==pending'
   * Phase 1 uses 'owner' only. Don't expand without WARD review.
   */
  condition?: string;

  /** Free-text rationale for reviewers. */
  notes?: string;
}

// ============================================================================
// SKELETON RULES — Phase 1 critical path that won't change post meeting #2
// ============================================================================

export const SKELETON_RULES: readonly PermissionRule[] = [
  // --- AUTH (UC-B01..B04, system-wide) -------------------------------------

  {
    action: 'account.signup',
    resource: 'user',
    roles: [ROLES.GUEST],
    uc_refs: ['UC-B01', 'UC-B02'],
    notes: 'B2B signup creates pending user; admin approval gates activation',
  },
  {
    action: 'account.login',
    resource: 'user',
    roles: [ROLES.GUEST], // unauthenticated principal becomes one of the roles after success
    uc_refs: ['UC-B03'],
  },
  {
    action: 'account.verify_email',
    resource: 'user',
    roles: [ROLES.GUEST],
    uc_refs: ['UC-B01', 'UC-B02'],
    condition: 'token_match',
    notes: 'Email verification token validated separately from RBAC',
  },
  {
    action: 'account.change_language',
    resource: 'user_preference',
    roles: [
      ROLES.BUYER_B2C,
      ROLES.BUYER_B2B,
      ROLES.ADMIN_FINANCE,
      ROLES.SUPPLIER,
      ROLES.QC_LOGISTICS,
      ROLES.GUEST,
    ],
    uc_refs: ['UC-B04'],
  },

  // --- WALLET (UC-B05, B06) -------------------------------------------------

  {
    action: 'wallet.topup',
    resource: 'wallet',
    roles: [ROLES.BUYER_B2C, ROLES.BUYER_B2B],
    condition: 'owner',
    uc_refs: ['UC-B05'],
    notes:
      'Top-up triggers Bank API (BankAdapter). Step-up 2FA may apply to B2C ' +
      'above threshold — see 2fa-flow.md LD-5',
  },
  {
    action: 'wallet.view',
    resource: 'wallet',
    roles: [ROLES.BUYER_B2C, ROLES.BUYER_B2B],
    condition: 'owner',
    uc_refs: ['UC-B06'],
  },

  // --- ORDER + QUOTATION (UC-B10, B11) -------------------------------------

  {
    action: 'order.create',
    resource: 'order',
    roles: [ROLES.BUYER_B2C, ROLES.BUYER_B2B],
    uc_refs: ['UC-B10'],
    notes:
      'Quotation issued by system or supplier; confirmation gates phase-1 payment',
  },
  {
    action: 'quotation.confirm',
    resource: 'quotation',
    roles: [ROLES.BUYER_B2C, ROLES.BUYER_B2B],
    condition: 'owner',
    uc_refs: ['UC-B11'],
    notes:
      'Meeting #1 §3.3 expanded UC-B11 to include B2C (was implicit B2B-only)',
  },

  // --- ADMIN B2B APPROVAL (UC-A01) -----------------------------------------

  {
    action: 'b2b_application.approve',
    resource: 'user',
    roles: [ROLES.ADMIN_FINANCE],
    uc_refs: ['UC-A01'],
    notes:
      'Approves the company doc upload + activates the buyer account; ' +
      'always-2FA per LD-5',
  },
  {
    action: 'b2b_application.reject',
    resource: 'user',
    roles: [ROLES.ADMIN_FINANCE],
    uc_refs: ['UC-A01'],
  },

  // --- PAYMENT VERIFY GATE (UC-A02 Phase 1; A03/A04 Phase 2) ---------------

  {
    action: 'payment.verify_phase1',
    resource: 'payment',
    roles: [ROLES.ADMIN_FINANCE],
    uc_refs: ['UC-A02'],
    notes: '50% deposit verify; gates supplier assign (UC-A06)',
  },
  // Phase 2 placeholders (logic/UC stable; permissions stable; just not active yet)
  {
    action: 'payment.verify_phase2',
    resource: 'payment',
    roles: [ROLES.ADMIN_FINANCE],
    uc_refs: ['UC-A03'],
    notes:
      'Phase 2; enable when UC-A03 ships. Permission row may be created now ' +
      'with no live route attached.',
  },
  {
    action: 'payment.verify_phase3',
    resource: 'payment',
    roles: [ROLES.ADMIN_FINANCE],
    uc_refs: ['UC-A04'],
    notes: 'Phase 2; final 30% net of claim/box deduction',
  },

  // --- ROLE / PERMISSION MGMT (UC-A20) -------------------------------------

  {
    action: 'user.assign_role',
    resource: 'user',
    roles: [ROLES.ADMIN_FINANCE],
    super_admin_only: true,
    step_up_2fa: true,
    uc_refs: ['UC-A20'],
    notes:
      'Per decisions-2026-04-27 §7 + WARD security policy: role changes ' +
      'are super-admin-only with step-up 2FA. Logged unconditionally.',
  },
  {
    action: 'user.toggle_super_admin',
    resource: 'user',
    roles: [ROLES.ADMIN_FINANCE],
    super_admin_only: true,
    step_up_2fa: true,
    two_eye_approval: true,
    cooling_off_hours: 24,
    uc_refs: ['UC-A20'],
    notes: 'Highest-privilege op; matches payment live-mode switch policy',
  },

  // --- PAYMENT LIVE-MODE SWITCH (decisions §7) -----------------------------

  {
    action: 'payment.switch_live_mode',
    resource: 'system_config',
    roles: [ROLES.ADMIN_FINANCE],
    super_admin_only: true,
    step_up_2fa: true,
    two_eye_approval: true,
    cooling_off_hours: 24,
    uc_refs: ['UC-A20', 'UC-X01', 'UC-X02'],
    notes:
      'Sandbox → live BankAdapter switch. Single human cannot move real ' +
      'money to production unilaterally. Audit log MUST capture: requester, ' +
      'approver, request_at, executed_at, IP both sides, prior_mode, new_mode.',
  },

  // --- AUDIT LOG VIEW (cross-cutting) --------------------------------------

  {
    action: 'audit_log.view_self',
    resource: 'audit_log',
    roles: [
      ROLES.BUYER_B2C,
      ROLES.BUYER_B2B,
      ROLES.SUPPLIER,
      ROLES.QC_LOGISTICS,
      ROLES.ADMIN_FINANCE,
    ],
    condition: 'owner',
    uc_refs: ['UC-X07'],
    notes: 'Own login history + own action log only (PDPA — data subject rights)',
  },
  {
    action: 'audit_log.view_all',
    resource: 'audit_log',
    roles: [ROLES.ADMIN_FINANCE],
    super_admin_only: true,
    uc_refs: ['UC-A19', 'UC-X07'],
    notes:
      'Cross-user audit log access is super-admin-only. Every read is itself ' +
      'logged (auditing the auditor).',
  },
];

// ============================================================================
// EXTENSION GUIDE — for post meeting #2 expansion
// ============================================================================

/**
 * To add a permission rule:
 *  1. Append to `EXTENSION_RULES_PHASE_2` (do NOT modify `SKELETON_RULES`)
 *  2. Update audit log if the action is financial or destructive
 *  3. Run permission seed migration
 *  4. Add unit test in `apps/api/src/platform/auth/permissions.test.ts`
 *  5. Open PR; WARD reviews any rule with `step_up_2fa` or `super_admin_only`
 *
 * Common Phase 2 additions (from kickoff-brief §15.5 + meeting #1 minutes):
 *  - promotion.create / link_product (manual product link, UC-A2x)
 *  - quotation.suspend (admin oversight, §4.3)
 *  - supplier.publish_product (with anti-dump policy, OI-05)
 *  - barcode.generate (post-order FK, §4.1)
 *  - packaging.set_threshold + packaging.subscribe_alert (§4.2)
 *  - container.close + container.ship (UC-S05+)
 *  - inspection.record + certificate.issue (UC-Q01..Q07)
 *  - claim.deduct (UC-A10..A12)
 *  - bill.release (UC-A14)
 */
export const EXTENSION_RULES_PHASE_2: readonly PermissionRule[] = [
  // (intentionally empty — meeting #2 outputs land here)
];

/**
 * Combined export for the seeder. Single source of truth.
 */
export const ALL_PERMISSION_RULES: readonly PermissionRule[] = [
  ...SKELETON_RULES,
  ...EXTENSION_RULES_PHASE_2,
];

// ============================================================================
// RBAC REGISTRY INTERFACE — composition-root contract
// ============================================================================

/**
 * `RbacRegistry` is the port consumed by middleware.
 *
 * Production composition: `PrismaRbacRegistry` (queries permission_rules table,
 *   cached in-memory at boot, refreshed on signal).
 * Test composition: `InMemoryRbacRegistry` (constructed from this file directly).
 *
 * NEVER call rules-resolution logic from inside route handlers. Middleware
 * resolves; route receives boolean / 403. Per addendum §1.4 (failure isolation).
 */
export interface RbacRegistry {
  /**
   * Returns the matching rule, or null if denied.
   * Caller MUST treat null as deny + log + 403.
   */
  resolve(input: {
    action: string;
    resource: string;
    role: Role;
    is_super_admin: boolean;
  }): PermissionRule | null;

  /** For diagnostics + admin UI. */
  listRules(): readonly PermissionRule[];

  /** Hot-reload after permission_rules table edit. */
  refresh(): Promise<void>;
}
