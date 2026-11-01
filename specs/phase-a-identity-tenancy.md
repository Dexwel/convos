# Phase A Spec: Identity, Workspaces, and Tenant Isolation

**Status:** Ready for implementation planning; not implemented.  
**Target:** Staging only. Keep the existing Render deployment and SQLite data untouched until migration/cutover approval.

## Scope

- Email/password with verified email, reset, and passwordless link/code.
- Google, Microsoft Entra (personal and work/school as selected), Apple OAuth.
- Optional customer MFA; mandatory MFA for platform operators.
- Individual signup creates a personal workspace. Organizations support multiple memberships and workspace switching.
- Roles: Owner, Admin, Editor, Analyst, Viewer. Invitations expire and can be resent/revoked; ownership transfer and account/workspace deletion have confirmation and audit requirements.
- Safe provider linking only after both identities have verified the same email; otherwise require an authenticated account-link flow.
- Every customer-owned DB row has a workspace scope and is checked in SQL RLS and API authorization.
- Respondents remain unauthenticated customers of a published form; respondent session capabilities are narrow, random, expiring, and cannot access customer APIs.
- Founder control-plane admins are represented separately from workspace roles and are not self-service assignable.

## Explicitly out of scope for Phase A

- Billing/plan enforcement (Phase C).
- Public marketing rebuild (Phase E).
- Founder admin UI (Phase F); Phase A only defines the separate platform-admin identity boundary.
- Social account provider console setup by the engineering agent. The founder must create provider apps/secrets and enter them into staging secrets directly.
- Production cutover or destructive SQLite migration.

## Authorization contract

| Operation | Owner | Admin | Editor | Analyst | Viewer |
|---|---:|---:|---:|---:|---:|
| Create/edit draft form | Yes | Yes | Yes | No | No |
| Publish/close | Yes | Yes | Yes | No | No |
| Delete form/response | Yes | Yes | No | No | No |
| View responses/audio/transcripts | Yes | Yes | No | Yes | No |
| Export responses | Yes | Yes | No | Yes | No |
| Invite/remove members | Yes | Yes | No | No | No |
| Change roles/transfer ownership | Yes | Limited (not owner transfer) | No | No | No |
| Billing/plan/payment method | Yes | No | No | No | No |
| Create/revoke workspace API keys | Yes | Yes | No | No | No |

Every permission is enforced server-side and in Postgres RLS. Client hiding is never authorization. All object lookups, including slug/ID, audio, export, invitation, and delete endpoints, must be tenant-scoped.

## Acceptance tests (write before route implementation)

### Account lifecycle

- Signup creates one verified user record and one personal workspace; duplicate signup is safe and idempotent.
- Unverified email cannot access customer APIs; resend verification and reset links expire and are single-use.
- Email/password, magic link, Google, Microsoft, and Apple callback state/nonce/PKCE are validated in staging.
- Same verified email may link a new provider only after authenticated confirmation. Unverified same-email provider claims never merge accounts.
- Refresh rotation, sign-out, sign-out-everywhere, device list/revocation, brute-force throttling, optional MFA, and mandatory platform-admin MFA are verified.

### Workspace/role

- One user can belong to multiple workspaces; active-workspace switch changes both UI context and backend authorization context.
- Invitations expire, are single-use, and can be revoked/resubmitted. Domain join requires verified domain and admin-approved setting.
- The table above is executable as role-policy tests; include role downgrade and removed-member session tests.
- Ownership transfer requires fresh authentication/confirmation and creates immutable audit events.
- Account deletion/export is tenant-scoped and does not remove another member's or workspace's records unintentionally.

### Tenant isolation

Create two workspaces and seeded forms, responses, audio and transcripts. For each authenticated role and every endpoint, assert cross-workspace get/list/search/export/update/delete/audio access is denied and does not disclose existence. Repeat with guessed UUIDs/slugs, forged workspace headers, stale tokens, user switching workspaces in two tabs, and revoked memberships.

For database coverage, run the same matrix using the authenticated DB role and direct PostgREST/RLS queries, not only Express routes. Admin/service credentials must never be sent to browsers. Public respondent endpoints may operate only on the one published form and session capability and must not expose other tenant records.

### Platform ops

- A normal workspace Owner cannot enumerate or mutate `platform_admins`, billing overrides, global abuse queues, or other tenants.
- Non-platform user to `/ops` receives the same generic 404 regardless of route existence. Platform admin with MFA can access; privilege changes are audit logged.

### Migration and rollback

- Snapshot existing SQLite and audio before any write/copy. Preserve survey IDs/slugs and session/answer/message IDs, timestamps, preview flags, audio filenames/checksums, and original JSON snapshot.
- Derive immutable legacy versions from session snapshots; do not infer absent consent or ownership data.
- Reconcile table counts and version-aware stats/exports; diff representative transcripts and audio references.
- Dry-run import twice to prove idempotence. Simulate interrupted copy and rollback to old Render DB. No production writes are disabled until restore succeeds.

## Required founder-owned configuration

Use a new staging Supabase project/region and a separate staging Render service. Store `SUPABASE_URL`, publishable/anon key, server-only secret/service key if strictly needed, Postgres connection URL, `APP_ORIGIN`, `OPS_ORIGIN`, and OAuth secrets only in the host secret manager. Never paste them in chat or commit them. Prefer a user-JWT-scoped Postgres session with RLS over a broad service-role query path.

Required callback pattern: `https://<project-ref>.supabase.co/auth/v1/callback`; client redirect allowlist includes exact staging `APP_ORIGIN/auth/callback` and local dev callback. Do not add wildcard production redirects.

## Rollback

Phase A remains behind a feature flag and staging project. Existing `/admin`, `/s/:slug`, SQLite and Render remain unchanged. Rollback disables new signup/customer routes and returns traffic to the legacy app; never drop legacy tables/audio as part of this phase.
