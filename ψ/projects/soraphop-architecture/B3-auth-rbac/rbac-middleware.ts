/**
 * Soraphop — RBAC Middleware (B3 scaffold)
 *
 * Pasteable into: apps/api/src/platform/auth/rbac-middleware.ts
 *
 * Per addendum 2026-04-27 §2 (WARD section):
 *   "Middleware reads permission registry → generic check.
 *    New role? Add row, no code deploy."
 *
 * This middleware:
 *   1. Resolves authenticated user (or 401)
 *   2. Looks up permission rule from RbacRegistry (data, not code)
 *   3. Verifies super_admin / step_up_2fa / cooling_off requirements
 *   4. Records every denial in audit log (anomaly detection signal)
 *
 * NEVER hardcode role checks in route handlers. If you need a check the
 * registry doesn't express yet, extend `PermissionRule.condition` (rare),
 * not the middleware. See: permission-map-skeleton.ts.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Role } from './role-enum';
import type {
  PermissionRule,
  RbacRegistry,
} from './permission-map-skeleton';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Authenticated principal extracted from session/JWT.
 * Provided by the upstream `authenticate` plugin.
 */
export interface Principal {
  user_id: string;
  role: Role;
  is_super_admin: boolean;
  two_factor_verified: boolean;
  two_factor_verified_at: number | null;
  // Request context — used by ABAC condition evaluators
  ip: string;
  user_agent: string;
}

/**
 * Condition evaluator port.
 * Concrete evaluators (e.g., 'owner', 'same_company') registered at
 * composition root. Middleware looks up evaluator by `condition` token.
 */
export interface ConditionEvaluator {
  /** Returns true = allow, false = deny. Throws = 500 (logged). */
  evaluate(input: {
    principal: Principal;
    request: FastifyRequest;
    rule: PermissionRule;
  }): Promise<boolean>;
}

/**
 * Audit logger port (see audit-log-schema.md).
 * Concrete: PrismaAuditAdapter (production), InMemoryAuditAdapter (test).
 */
export interface AuditLogger {
  record(event: {
    kind: string;
    actor_user_id: string | null;
    target_user_id?: string | null;
    resource: string;
    action: string;
    outcome: 'allow' | 'deny' | 'error';
    reason?: string;
    ip: string;
    user_agent: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * Step-up 2FA freshness window (ms).
 * If `two_factor_verified_at` older than this, require re-verify even if
 * the user has session-level 2FA. Default 5 min.
 *
 * Why 5 min: long enough to complete a multi-step destructive op without
 * re-prompting; short enough that a borrowed laptop / unlocked-screen
 * window is bounded.
 */
export const STEP_UP_2FA_FRESHNESS_MS = 5 * 60 * 1000;

// ============================================================================
// FACTORY
// ============================================================================

export interface RequirePermissionDeps {
  registry: RbacRegistry;
  audit: AuditLogger;
  conditionEvaluators: Record<string, ConditionEvaluator>;
  /** Fetches in-flight 2-eye approval state for an action+actor. */
  twoEyeApprovalRepository: {
    findOpen(input: {
      action: string;
      requester_id: string;
    }): Promise<{
      approver_id: string | null;
      requested_at: Date;
    } | null>;
  };
}

/**
 * Build a Fastify preHandler that requires the given (action, resource)
 * permission. Pasteable usage:
 *
 *   fastify.post('/admin/b2b/:id/approve', {
 *     preHandler: requirePermission('b2b_application.approve', 'user'),
 *     schema: { ... },
 *   }, handler);
 *
 * Production: deps wired in apps/api/src/composition.ts.
 * Tests: deps replaced with mocks.
 */
export function requirePermissionFactory(deps: RequirePermissionDeps) {
  return function requirePermission(action: string, resource: string) {
    return async function preHandler(
      request: FastifyRequest,
      reply: FastifyReply,
    ) {
      const principal = (request as FastifyRequest & {
        principal?: Principal;
      }).principal;

      // ----- 1. Authenticate ------------------------------------------------
      if (!principal) {
        await deps.audit.record({
          kind: 'rbac.deny.unauthenticated',
          actor_user_id: null,
          resource,
          action,
          outcome: 'deny',
          reason: 'no_principal',
          ip: request.ip,
          user_agent: request.headers['user-agent'] ?? '',
        });
        // Generic 401. Never leak which step failed.
        return reply.code(401).send({ error: 'unauthorized' });
      }

      // ----- 2. Resolve rule ------------------------------------------------
      const rule = deps.registry.resolve({
        action,
        resource,
        role: principal.role,
        is_super_admin: principal.is_super_admin,
      });

      if (!rule) {
        await deps.audit.record({
          kind: 'rbac.deny.no_rule',
          actor_user_id: principal.user_id,
          resource,
          action,
          outcome: 'deny',
          reason: `role=${principal.role} not in rule.roles`,
          ip: principal.ip,
          user_agent: principal.user_agent,
        });
        return reply.code(403).send({ error: 'forbidden' });
      }

      // ----- 3. Super admin gate -------------------------------------------
      if (rule.super_admin_only && !principal.is_super_admin) {
        await deps.audit.record({
          kind: 'rbac.deny.super_admin_required',
          actor_user_id: principal.user_id,
          resource,
          action,
          outcome: 'deny',
          reason: 'is_super_admin=false',
          ip: principal.ip,
          user_agent: principal.user_agent,
        });
        return reply.code(403).send({ error: 'forbidden' });
      }

      // ----- 4. Step-up 2FA freshness --------------------------------------
      if (rule.step_up_2fa) {
        const fresh =
          principal.two_factor_verified &&
          principal.two_factor_verified_at != null &&
          Date.now() - principal.two_factor_verified_at <=
            STEP_UP_2FA_FRESHNESS_MS;

        if (!fresh) {
          await deps.audit.record({
            kind: 'rbac.deny.step_up_required',
            actor_user_id: principal.user_id,
            resource,
            action,
            outcome: 'deny',
            reason: 'step_up_2fa stale or missing',
            ip: principal.ip,
            user_agent: principal.user_agent,
          });
          // 401 with a known code → client redirects to /verify-2fa?return=...
          return reply
            .code(401)
            .send({ error: 'step_up_required', code: 'STEP_UP_2FA' });
        }
      }

      // ----- 5. Cooling-off check ------------------------------------------
      if (rule.cooling_off_hours && rule.cooling_off_hours > 0) {
        const open = await deps.twoEyeApprovalRepository.findOpen({
          action,
          requester_id: principal.user_id,
        });
        if (!open) {
          // No request started yet — this call should be the "request" route,
          // not the "execute" route. Surface a typed error so client knows.
          await deps.audit.record({
            kind: 'rbac.deny.cooling_off_required',
            actor_user_id: principal.user_id,
            resource,
            action,
            outcome: 'deny',
            reason: 'no open 2-eye approval request',
            ip: principal.ip,
            user_agent: principal.user_agent,
          });
          return reply
            .code(409)
            .send({ error: 'cooling_off_required', code: 'COOLING_OFF' });
        }
        const elapsedMs = Date.now() - open.requested_at.getTime();
        const requiredMs = rule.cooling_off_hours * 60 * 60 * 1000;
        if (elapsedMs < requiredMs) {
          await deps.audit.record({
            kind: 'rbac.deny.cooling_off_pending',
            actor_user_id: principal.user_id,
            resource,
            action,
            outcome: 'deny',
            reason: `${Math.round(elapsedMs / 1000)}s of ${rule.cooling_off_hours}h elapsed`,
            ip: principal.ip,
            user_agent: principal.user_agent,
          });
          return reply
            .code(425) // Too Early
            .send({ error: 'cooling_off_pending', code: 'COOLING_OFF' });
        }
        if (rule.two_eye_approval && !open.approver_id) {
          await deps.audit.record({
            kind: 'rbac.deny.two_eye_pending',
            actor_user_id: principal.user_id,
            resource,
            action,
            outcome: 'deny',
            reason: 'no approver yet',
            ip: principal.ip,
            user_agent: principal.user_agent,
          });
          return reply
            .code(409)
            .send({ error: 'two_eye_required', code: 'TWO_EYE' });
        }
      }

      // ----- 6. ABAC condition ---------------------------------------------
      if (rule.condition) {
        const evaluator = deps.conditionEvaluators[rule.condition];
        if (!evaluator) {
          // Misconfiguration. Fail closed + alert.
          await deps.audit.record({
            kind: 'rbac.error.unknown_condition',
            actor_user_id: principal.user_id,
            resource,
            action,
            outcome: 'error',
            reason: `unknown condition: ${rule.condition}`,
            ip: principal.ip,
            user_agent: principal.user_agent,
          });
          return reply.code(500).send({ error: 'internal' });
        }
        const allowed = await evaluator.evaluate({
          principal,
          request,
          rule,
        });
        if (!allowed) {
          await deps.audit.record({
            kind: 'rbac.deny.condition',
            actor_user_id: principal.user_id,
            resource,
            action,
            outcome: 'deny',
            reason: `condition ${rule.condition} returned false`,
            ip: principal.ip,
            user_agent: principal.user_agent,
          });
          return reply.code(403).send({ error: 'forbidden' });
        }
      }

      // ----- 7. ALLOW — log only the destructive ones ----------------------
      // Logging every allow is too noisy. Log only:
      //   - super_admin_only
      //   - step_up_2fa
      //   - actions in audit-log-schema.md "Always log" list
      // The audit-log-schema decides what gets logged on success.
      if (rule.super_admin_only || rule.step_up_2fa) {
        await deps.audit.record({
          kind: `rbac.allow.${action}`,
          actor_user_id: principal.user_id,
          resource,
          action,
          outcome: 'allow',
          ip: principal.ip,
          user_agent: principal.user_agent,
          metadata: { rule_uc_refs: rule.uc_refs },
        });
      }

      // Pass — handler runs.
    };
  };
}

// ============================================================================
// USAGE EXAMPLES (for FORGE — not exported, kept for reference)
// ============================================================================

/* eslint-disable @typescript-eslint/no-unused-vars */
/*

import { requirePermissionFactory } from './rbac-middleware';

// In apps/api/src/composition.ts:
const requirePermission = requirePermissionFactory({
  registry: prismaRbacRegistry,
  audit: prismaAuditLogger,
  conditionEvaluators: {
    owner: ownerConditionEvaluator,
    same_company: sameCompanyEvaluator,
    token_match: tokenMatchEvaluator,
  },
  twoEyeApprovalRepository: prismaTwoEyeApprovalRepo,
});

// In apps/api/src/features/admin/routes.ts:
fastify.post(
  '/admin/b2b/:id/approve',
  { preHandler: requirePermission('b2b_application.approve', 'user') },
  approveB2bHandler,
);

fastify.post(
  '/admin/users/:id/role',
  { preHandler: requirePermission('user.assign_role', 'user') },
  assignRoleHandler,
);

fastify.post(
  '/admin/system/payment-mode',
  { preHandler: requirePermission('payment.switch_live_mode', 'system_config') },
  switchLiveModeHandler,
);

*/
