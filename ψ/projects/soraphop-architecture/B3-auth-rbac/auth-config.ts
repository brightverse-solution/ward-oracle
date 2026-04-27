/**
 * Soraphop — Auth.js (NextAuth v5) config draft (B3 scaffold)
 *
 * Pasteable into: apps/web/src/auth.ts (Next.js 15 App Router pattern)
 *
 * Per addendum 2026-04-27 §2 (WARD section):
 *   "Auth provider = plugin (Auth.js already pluggable — providers list)"
 *
 * This config is the COMPOSITION ROOT for Auth.js providers. Adding a
 * provider (Google OAuth, LINE Login, etc.) = append one entry. Removing
 * one = delete one entry. No other code changes required.
 *
 * --------------------------------------------------------------------------
 * SCAFFOLD CAVEAT: this file is a contract draft. It does NOT contain real
 * secrets. All `process.env.*` references must be wired by ANVIL via
 * SOPS/Vault (NFR §secrets). Direct .env commits are a Critical finding.
 * --------------------------------------------------------------------------
 */

import type { NextAuthConfig, User as NextAuthUser } from 'next-auth';
import type { Role } from './role-enum';

// ============================================================================
// SESSION SHAPE — what travels in the JWT/cookie
// ============================================================================

/**
 * Augment NextAuth session with our domain fields.
 * Pasteable into: apps/web/src/types/next-auth.d.ts
 *
 * Note: keep this MINIMAL. Anything that changes server-side without
 * forcing logout (e.g., role demotion) must NOT live in the JWT alone —
 * it must be re-checked server-side per request. JWT is a hint, DB is truth.
 */
declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      email: string;
      role: Role;
      is_super_admin: boolean;
      two_factor_verified: boolean; // verified for current session
      two_factor_verified_at: number | null; // unix ms — for step-up freshness
    };
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    sub: string; // user id
    role: Role;
    is_super_admin: boolean;
    two_factor_verified: boolean;
    two_factor_verified_at: number | null;
  }
}

// ============================================================================
// CONFIG
// ============================================================================

export const authConfig: NextAuthConfig = {
  // ---------- Providers (the plugin list) ---------------------------------
  // Each provider = a plugin per addendum §2. Add/remove freely.
  providers: [
    // CredentialsProvider for email + password (Phase 1).
    // OAuth providers (Google, LINE) are Phase 2+ candidates — slot in here.
    // Concrete provider impls live in apps/web/src/auth/providers/
    // (kept out of this scaffold; FORGE wires them).
  ],

  // ---------- Session strategy --------------------------------------------
  session: {
    strategy: 'jwt',
    maxAge: 60 * 60 * 8,         // 8 hours absolute
    updateAge: 60 * 30,           // refresh JWT every 30 min on activity
  },

  // ---------- Cookies (CSRF + XSS hardening, NFR-aligned) -----------------
  cookies: {
    sessionToken: {
      name: '__Secure-soraphop.session', // __Secure- prefix → HTTPS-only browser enforcement
      options: {
        httpOnly: true,           // XSS: JS can't read
        secure: true,             // HTTPS only (production)
        sameSite: 'strict',       // CSRF: never sent on cross-site requests
        path: '/',
      },
    },
    callbackUrl: {
      name: '__Secure-soraphop.callback-url',
      options: {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/',
      },
    },
    csrfToken: {
      // Auth.js generates + double-submits a CSRF token for credential auth.
      // Do NOT disable. Listed here for visibility, not override.
      name: '__Host-soraphop.csrf-token',
      options: {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/',
      },
    },
  },

  // ---------- JWT signing -------------------------------------------------
  jwt: {
    // Auth.js uses A256GCM by default with `AUTH_SECRET`.
    // Rotation: set `AUTH_SECRET` to a 256-bit (32-byte) random; rotate quarterly.
    // Rotation procedure (NFR §JWT secret rotation):
    //   1. Generate new secret
    //   2. Deploy with both old + new (keys array form)
    //   3. After 8h (max session lifetime) drop old
    maxAge: 60 * 60 * 8,
  },

  // ---------- Pages -------------------------------------------------------
  pages: {
    signIn: '/login',
    error: '/login',                   // map errors to login page banner (don't expose internal codes)
    verifyRequest: '/verify-email',    // post-signup
    newUser: '/onboarding',            // optional first-login destination
    // signOut: default — Auth.js handles
  },

  // ---------- Callbacks ---------------------------------------------------
  callbacks: {
    /**
     * Called whenever a JWT is created or updated.
     * - On first sign-in: enrich JWT with role + super_admin from DB.
     * - On session refresh: re-read role + super_admin from DB
     *   (so demotion / lockout takes effect within updateAge window).
     */
    async jwt({ token, user, trigger }) {
      // First sign-in: hydrate from `user` returned by provider.
      if (user && (user as NextAuthUser & { role?: Role }).role) {
        const u = user as NextAuthUser & {
          role: Role;
          is_super_admin: boolean;
        };
        token.sub = u.id ?? token.sub;
        token.role = u.role;
        token.is_super_admin = u.is_super_admin;
        token.two_factor_verified = false;
        token.two_factor_verified_at = null;
        return token;
      }

      // Periodic refresh — re-read DB to honor demotion/lockout.
      // Performance: 1 query per updateAge interval (30 min) per active user.
      // Consider Redis cache keyed on user id for >1k DAU.
      if (trigger === 'update' || trigger === 'signIn') {
        // PSEUDOCODE — FORGE wires the actual repository call:
        //   const dbUser = await userRepository.findById(token.sub);
        //   if (!dbUser || dbUser.locked_at) throw new Error('locked');
        //   token.role = dbUser.role;
        //   token.is_super_admin = dbUser.is_super_admin;
      }

      return token;
    },

    /**
     * Project JWT into Session object that the client sees.
     */
    async session({ session, token }) {
      session.user.id = token.sub;
      session.user.role = token.role;
      session.user.is_super_admin = token.is_super_admin;
      session.user.two_factor_verified = token.two_factor_verified;
      session.user.two_factor_verified_at = token.two_factor_verified_at;
      return session;
    },

    /**
     * Allow / block sign-in attempts.
     * Returning false = generic error shown ("invalid credentials").
     * NEVER leak why (locked vs unverified vs nonexistent) — enumeration risk.
     */
    async signIn({ user }) {
      // PSEUDOCODE — FORGE wires:
      //   if (!user.email_verified_at) return false;
      //   if (user.locked_at) return false;
      //   if (failedAttemptsLastHour(user.id) >= 5) return false; // rate limit
      return true;
    },

    /**
     * Restrict redirect URL after sign-in/out.
     * Open redirect = OWASP A1. Whitelist origins.
     */
    async redirect({ url, baseUrl }) {
      // Allow same-origin only.
      if (url.startsWith('/')) return `${baseUrl}${url}`;
      try {
        const u = new URL(url);
        if (u.origin === baseUrl) return url;
      } catch {
        /* fall through */
      }
      return baseUrl;
    },
  },

  // ---------- Events (audit log hooks) ------------------------------------
  // Per audit-log-schema.md, these events MUST be recorded.
  // Bind via composition root: production wires PrismaAuditAdapter; tests use InMemoryAuditAdapter.
  events: {
    async signIn({ user }) {
      // auditLog.record({ kind: 'auth.login.success', actor_user_id: user.id, ... })
    },
    async signOut() {
      // auditLog.record({ kind: 'auth.logout', ... })
    },
    async createUser({ user }) {
      // auditLog.record({ kind: 'auth.signup', actor_user_id: user.id, ... })
    },
    async updateUser({ user }) {
      // auditLog.record({ kind: 'auth.user_updated', actor_user_id: user.id, ... })
    },
    async linkAccount({ user, account }) {
      // auditLog.record({ kind: 'auth.oauth_linked', actor_user_id: user.id, provider: account.provider, ... })
    },
    async session(/* { session, token } */) {
      // intentionally noop — too noisy to log every refresh
    },
  },

  // ---------- Debug -------------------------------------------------------
  // MUST be false in production. Logs include sensitive token info in dev.
  debug: process.env.NODE_ENV !== 'production',

  // ---------- Trust Host --------------------------------------------------
  // Required for deployment behind reverse proxy (Caddy on Hetzner).
  // ANVIL: ensure X-Forwarded-Host / X-Forwarded-Proto are set, not spoofable.
  trustHost: true,

  // ---------- Secret ------------------------------------------------------
  // Read from process.env.AUTH_SECRET. Set via SOPS/Vault, never .env in repo.
  // 256-bit (32 byte) random, base64-encoded.
  // Generate: `openssl rand -base64 32`
  secret: process.env.AUTH_SECRET,
};

// ============================================================================
// COMPOSITION-ROOT NOTES (for FORGE)
// ============================================================================

/**
 * Where this config gets wired:
 *
 *   apps/web/src/auth.ts:
 *     import NextAuth from 'next-auth';
 *     import { authConfig } from '@soraphop/shared-types/auth';
 *     import { credentialsProvider } from './auth/providers/credentials';
 *
 *     export const { auth, handlers, signIn, signOut } = NextAuth({
 *       ...authConfig,
 *       providers: [credentialsProvider],
 *     });
 *
 * The credentialsProvider plugin lives in apps/web/src/auth/providers/.
 * Its `authorize()` function does:
 *   1. zod validate { email, password }
 *   2. fetch user by email (no enumeration leak — same generic error)
 *   3. bcrypt.compare against password_hash (rounds >= 12)
 *   4. check email_verified_at + locked_at
 *   5. enqueue 2FA challenge if user.two_factor_enabled (separate route)
 *   6. return user object (without password_hash, ever)
 *
 * The 2FA challenge step happens AFTER credentials succeed but BEFORE
 * `two_factor_verified` flips true on the JWT. Routes that require 2FA
 * check that flag in middleware. See: rbac-middleware.ts.
 */
