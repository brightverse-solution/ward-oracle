/**
 * Soraphop — Role Enum (B3 scaffold)
 *
 * Pasteable into: packages/shared-types/src/auth/roles.ts
 *
 * Source decisions:
 *  - HTML R1 menu map (Admin & Finance combined as one actor)
 *  - quill-brain-oracle:ψ/projects/soraphop/decisions-2026-04-27.md §7 (Super Admin sub-flag)
 *  - kickoff-brief.md §3.2 (actor list)
 *  - addendum 2026-04-27 §2 (RBAC permission map = data, not code)
 *
 * Stability: STABLE for Phase 1 + 2. Adding a 7th role = breaking change
 * (DB enum migration + permission_rules backfill). Unlikely in scope window.
 */

/**
 * Canonical role identifiers.
 *
 * Conventions:
 *  - DB enum: snake_case (`buyer_b2c`)
 *  - TS string union: snake_case to match DB (no translation layer needed)
 *  - i18n display key: camelCase under `role.*` namespace (HERALD owns)
 *
 * DO NOT branch on Role inside business logic. Use the permission registry.
 * The only place Role appears in switch statements: middleware that maps
 * Role → permission set lookup (and even that should be data-driven, see
 * permission-map-skeleton.ts).
 */
export const ROLES = {
  BUYER_B2C: 'buyer_b2c',
  BUYER_B2B: 'buyer_b2b',
  ADMIN_FINANCE: 'admin_finance',
  SUPPLIER: 'supplier',
  QC_LOGISTICS: 'qc_logistics',
  GUEST: 'guest',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ALL_ROLES: readonly Role[] = Object.values(ROLES);

/**
 * Authenticated roles (excludes Guest).
 * Use for "must be logged in" checks before permission lookup.
 */
export const AUTHENTICATED_ROLES: readonly Role[] = [
  ROLES.BUYER_B2C,
  ROLES.BUYER_B2B,
  ROLES.ADMIN_FINANCE,
  ROLES.SUPPLIER,
  ROLES.QC_LOGISTICS,
];

/**
 * Roles that handle money directly (bills, payments, wallet ops).
 * Used by 2FA enforcement profile (always-2FA bucket).
 * See: 2fa-flow.md, README LD-5
 */
export const FINANCIAL_ROLES: readonly Role[] = [
  ROLES.ADMIN_FINANCE,
  ROLES.SUPPLIER,
  ROLES.QC_LOGISTICS, // issues claim certificates → triggers payment deductions
];

/**
 * Roles with menu access to Back Office.
 * Source: HTML R1 menu map.
 */
export const BACK_OFFICE_ROLES: readonly Role[] = [
  ROLES.ADMIN_FINANCE,
  ROLES.SUPPLIER,
  ROLES.QC_LOGISTICS,
];

/**
 * Roles allowed to view Customer Website logged-in features
 * (separate from Guest, who can browse but not order).
 */
export const CUSTOMER_PORTAL_ROLES: readonly Role[] = [
  ROLES.BUYER_B2C,
  ROLES.BUYER_B2B,
];

/**
 * is_super_admin is a User-level boolean flag, NOT a role.
 *
 * Per decisions-2026-04-27 §7:
 *  - Required for: payment live-mode switch, role assignment to other users,
 *    permission_rules table edits, audit log retention policy changes
 *  - Always combined with: 2-eye approval + 24h cooling-off + step-up 2FA
 *
 * Why a flag, not a role:
 *  - Super Admin always also has Admin & Finance day-to-day duties.
 *    Two-role arrangement (user has both) doubles permission lookup
 *    cost and creates "which role is active right now?" ambiguity.
 *  - Sub-flag = same role for routine ops, gate appears on destructive ops.
 */
export interface UserAuthShape {
  id: string;
  role: Role;
  is_super_admin: boolean;
  email: string;
  email_verified_at: Date | null;
  two_factor_enabled: boolean;
  two_factor_method: '2fa.totp' | '2fa.webauthn' | null; // adapter id, see 2fa-flow.md
  two_factor_enrolled_at: Date | null;
  // Suppliers may also be Soraphop-internal (per meeting #1 §4.5).
  // This flag lives on the Supplier profile, not on User. Cross-ref only here.
  // supplier_profile_id?: string;
}

/**
 * Type guard: is this user authenticated (not Guest)?
 *
 * Use BEFORE permission lookup. Permission registry assumes a real principal.
 */
export function isAuthenticated(
  user: Pick<UserAuthShape, 'role'> | null | undefined,
): user is UserAuthShape {
  return user != null && user.role !== ROLES.GUEST;
}

/**
 * Type guard: super-admin operations gate.
 *
 * NEVER call this without also requiring step-up 2FA in the caller path.
 * See: 2fa-flow.md "step-up" section.
 */
export function isSuperAdmin(
  user: Pick<UserAuthShape, 'role' | 'is_super_admin'> | null | undefined,
): boolean {
  return (
    user != null &&
    user.role === ROLES.ADMIN_FINANCE &&
    user.is_super_admin === true
  );
}

/**
 * Prisma enum equivalent — for forge-oracle:apps/api/prisma/schema.prisma
 *
 *   enum Role {
 *     buyer_b2c
 *     buyer_b2b
 *     admin_finance
 *     supplier
 *     qc_logistics
 *     guest
 *   }
 *
 *   model User {
 *     id                       String   @id @default(cuid())
 *     email                    String   @unique
 *     email_verified_at        DateTime?
 *     password_hash            String   // bcrypt rounds >= 12 (NFR)
 *     role                     Role
 *     is_super_admin           Boolean  @default(false)
 *     two_factor_enabled       Boolean  @default(false)
 *     two_factor_method        String?  // adapter id
 *     two_factor_secret_enc    String?  // AES-256 encrypted via pgcrypto
 *     two_factor_enrolled_at   DateTime?
 *     // ... per FORGE B1
 *   }
 */
