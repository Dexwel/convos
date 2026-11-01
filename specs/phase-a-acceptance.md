# Phase A Acceptance: Identity and Tenant Foundation

This spec must be reviewed before implementing customer signup or changing existing admin routes. The SQL migration in `supabase/migrations/20261020000100_saas_foundation.sql` is staging-only and is not sufficient by itself to launch Phase A.

## Scope

- Email/password with verified email, reset, and passwordless email link/code.
- Google, Microsoft Entra, and Apple OAuth.
- Google personal/work accounts; Microsoft personal and organizational accounts, subject to chosen provider setup.
- Optional customer MFA; mandatory MFA for platform admins.
- Personal workspace on signup, organization workspace, multiple memberships, invitation expiry/resend/revoke, role change, ownership transfer and account export/deletion.
- Roles: Owner, Admin, Editor, Analyst, Viewer.
- Workspace-bound data in both database RLS and server-side authorization; respondent identities remain optional and are not customer accounts.
- Platform-admin identity is separate from workspace roles; no public self-service elevation.
- Keep `/admin`, `/s/:slug`, SQLite, local media and existing Render deployment untouched until migration and rollback gates pass.

## Test-first acceptance

### Auth lifecycle

- Signup creates a user and exactly one personal workspace; retries are idempotent.
- Unverified users cannot access customer data. Verification/reset links expire and are single-use.
- Google/Microsoft/Apple state, nonce and PKCE are checked; provider linking is blocked unless both email identities are verified or the user completes authenticated account-link flow.
- Test sign-in, sign-out, refresh rotation, sign-out-all, device revocation, brute-force throttling, MFA, and session expiry.
- OAuth callbacks/redirect allowlists use exact dev/staging/production origins; test open redirect rejection.

### Workspace roles

- Test every role/action in the matrix in `SAAS_MIGRATION_PLAN.md`, including role downgrade, suspension, invite revoke/expiry and concurrent membership removal.
- User can be in multiple organizations; separate browser tabs and explicit active workspace cannot leak request context.
- Owner transfer requires reauthentication, confirmation and audit event.
- Account export/deletion and workspace deletion require explicit scope and preserve other tenants.

### Tenant isolation

Seed two workspaces with distinct forms, versions, responses, audio assets, transcripts, API keys and webhooks. For each route and role, assert cross-workspace read/list/search/update/delete/export/audio/integration access is denied. Test guessed IDs/slugs, forged workspace IDs/headers, stale tokens and removed memberships.

Run the same checks directly against Postgres using `authenticated` JWT claims/RLS, not only Express. Never expose service-role keys to clients. Public respondent tokens must be scoped to a single published form/session, rate-limited, expiring and unable to list other records.

### Platform ops

- Workspace Owner cannot enumerate or mutate `platform_admins`, usage overrides, other workspaces or abuse queues.
- Non-platform user gets generic 404 from every ops route. Platform admin requires MFA and every privileged action creates an append-only audit event.

### Migration and rollback

- Back up SQLite consistently with WAL plus audio files; restore into isolated staging before backfill.
- Preserve old IDs, slugs, timestamps, preview flags and data. Derive legacy immutable form versions from session snapshots; do not invent consent/ownership facts.
- Compare row counts, audio checksums, response totals, and representative exports; test import twice for idempotency.
- Simulate interrupted import and revert traffic to the old Render service. Do not disable legacy writes before reconciliation and restore test pass.

## Required gates

- Unit tests: permission resolver, invite token lifecycle, membership transitions, account-link rules, usage scope.
- Integration: Supabase Auth callbacks, Postgres migration, RLS, storage signed URLs, audit events.
- E2E: signup/verify/reset, each OAuth provider in staging, workspace create/invite/switch, published form response, role denies, user deletion/export.
- Security: dependency and secret scan, cross-tenant IDOR matrix, CSRF/origin checks, rate limits, platform admin MFA.
- Independent review for auth/tenant/RLS changes; migration and rollback evidence attached.

## Config requirements (staging only)

Create a separate Supabase project and Render staging service. Configure secrets only in the provider console: `SUPABASE_URL`, publishable key, server-only secret only if needed, Postgres connection secret, and OAuth secrets. Do not paste credentials into chat or commit `.env`.

Supabase provider callback format: `https://<project-ref>.supabase.co/auth/v1/callback`. Supabase application redirect allowlist must include exact staging `https://<staging-app-domain>/auth/callback` and a local development callback; no production wildcard.

OAuth console setup is documented in [SAAS_MIGRATION_PLAN.md](../SAAS_MIGRATION_PLAN.md#L118). Google, Microsoft, Apple, domain/email, and SSO IdP credentials are founder-owned. Apple client secrets need scheduled six-month rotation.
