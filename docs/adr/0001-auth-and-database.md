# ADR 0001: Managed Auth and Postgres for SaaS Foundation

- **Status:** Proposed, staging-only pending founder/provider account setup
- **Date:** 2026-10-20
- **Decision owner:** Founder

## Context

The current Express app uses one global password and SQLite/local audio. The target requires customer identities, multiple workspaces per user, organization membership and roles, SSO, and hard cross-tenant isolation. The current survey/session data must survive a parallel migration. The target team is small and the app is relational/data-heavy.

## Proposed decision

Evaluate Supabase Auth + managed Postgres as the first staging implementation. Keep Express as the application API. Use Supabase Auth for verified email/password, magic link, OAuth, and MFA; model workspace membership and product-specific roles in application tables; enforce workspace isolation in Postgres RLS and in Express authorization. Use managed object storage for private audio in a later gated phase.

Do not use the Supabase service-role credential on browser clients. Prefer user JWT/RLS-scoped DB access; any server-only elevated path must be a narrow audited operation with explicit workspace checks. This ADR is not authorization to touch production or migrate current data.

## Reasons

- Combines SQL database and RLS enforcement with managed identity, matching the data model and tenant-boundary requirement.
- Current listed Pro base is $25/month with included MAU/compute quota; SSO pricing and supported region must be checked for actual expected usage before purchase.
- OAuth callbacks and provider setup are documented for Google, Microsoft and Apple.
- Supabase is a lower-ops starting point than running a dedicated identity service and Postgres cluster separately.

## Alternatives considered

- **Clerk:** stronger prebuilt organizations/member management and polished auth UI; current official pricing lists Pro at $20/month annual/$25 monthly with 50k MRU and one SSO connection, and organization features/add-ons affect price. Rejected as default because data/RLS would still be a separate Postgres layer and custom role/resource policy remains app-owned.
- **WorkOS AuthKit:** strong B2B SSO and migration path; first 1M MAUs free according to its current pricing page, but SSO connections are priced individually and it is not the application database. Reconsider if enterprise SSO is the first buyer blocker.
- **Auth0:** mature B2B/B2C identity, but public B2B Essentials starts at $150/month and may be disproportionate before enterprise demand.
- **Auth.js/Better Auth:** framework-friendly library and broad provider support, but product would own more account lifecycle, email flows, organization/RBAC, MFA support, abuse controls, and SSO. Not selected for the security-sensitive initial rollout.
- **Firebase Auth:** strong managed social authentication, but less aligned with the relational/Postgres/RLS product model; would add another service boundary.

## Consequences and required validation

- Adds a staging Supabase project, provider configuration, schema migrations, and operational/vendor dependency.
- App-owned roles and workspace membership must still be designed and tested; Auth provider organizations alone are not the authorization model.
- Verify region/data residency, SAML entitlement/cost, email deliverability, deletion/export controls, incident support, MAU cost, backup restore, and direct Postgres network access before production.
- Revisit decision if registration country, data residency law, enterprise SSO contract, or total-cost model makes another provider materially better.
