-- STAGING FOUNDATION ONLY. Do not apply to production or legacy SQLite data.
-- This migration is additive and creates identity/workspace scaffolding only.
-- Survey/session/answer migration will be a separately reviewed migration with a restore-tested backfill.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
  kind text not null check (kind in ('personal', 'organization')),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_memberships (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'editor', 'analyst', 'viewer')),
  status text not null default 'active' check (status in ('invited', 'active', 'suspended')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (workspace_id, user_id)
);

create index if not exists workspace_memberships_user_idx on public.workspace_memberships(user_id, status);

-- A new workspace creator must become its initial owner atomically; otherwise
-- the RLS rules below would make the workspace impossible to administer.
create or replace function public.bootstrap_workspace_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.workspace_memberships (
    workspace_id, user_id, role, status, invited_by, accepted_at
  ) values (
    new.id, new.created_by, 'owner', 'active', new.created_by, now()
  );
  return new;
end;
$$;

revoke all on function public.bootstrap_workspace_owner() from public, anon, authenticated;

create trigger workspaces_bootstrap_owner
  after insert on public.workspaces
  for each row execute function public.bootstrap_workspace_owner();

create or replace function public.prevent_workspace_identity_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.created_by <> old.created_by
    or new.kind <> old.kind
    or new.slug <> old.slug then
    raise exception using errcode = '42501', message = 'Workspace identity fields are immutable';
  end if;
  return new;
end;
$$;

create trigger workspaces_keep_identity_immutable
  before update on public.workspaces
  for each row execute function public.prevent_workspace_identity_change();

create table if not exists public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin', 'editor', 'analyst', 'viewer')),
  token_hash text not null unique,
  invited_by uuid not null references auth.users(id) on delete restrict,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists workspace_invites_workspace_idx on public.workspace_invites(workspace_id, expires_at);

-- Immutable audit evidence is retained separately from deletable workspace rows.
-- Writes are server-only; no authenticated/anonymous RLS policy is granted here.
create table if not exists public.workspace_audit_events (
  id bigint generated always as identity primary key,
  workspace_id uuid,
  actor_user_id uuid,
  actor_kind text not null check (actor_kind in ('user', 'platform_admin', 'system')),
  event_type text not null,
  target_type text not null,
  target_id text,
  request_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists workspace_audit_events_workspace_time_idx
  on public.workspace_audit_events(workspace_id, created_at desc);

-- Platform operators are not workspace roles and are not self-service assignable.
-- Only a trusted migration/operations procedure may insert rows here.
create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete restrict,
  granted_by text not null,
  reason text not null,
  created_at timestamptz not null default now()
);

create or replace function public.has_workspace_role(target_workspace uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_memberships wm
    where wm.workspace_id = target_workspace
      and wm.user_id = (select auth.uid())
      and wm.status = 'active'
      and wm.role = any(allowed_roles)
  );
$$;

revoke all on function public.has_workspace_role(uuid, text[]) from public;
grant execute on function public.has_workspace_role(uuid, text[]) to authenticated;

create or replace function public.prevent_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '42501', message = 'Audit events are append-only';
end;
$$;

create trigger workspace_audit_events_append_only
  before update or delete on public.workspace_audit_events
  for each row execute function public.prevent_audit_mutation();

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_memberships enable row level security;
alter table public.workspace_invites enable row level security;
alter table public.platform_admins enable row level security;
revoke all on table public.workspace_audit_events from public, anon, authenticated;
grant insert on table public.workspace_audit_events to service_role;
grant usage, select on sequence public.workspace_audit_events_id_seq to service_role;

create policy profiles_select_self on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy profiles_insert_self on public.profiles
  for insert to authenticated with check (id = (select auth.uid()));
create policy profiles_update_self on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy workspace_select_member on public.workspaces
  for select to authenticated using (
    public.has_workspace_role(id, array['owner','admin','editor','analyst','viewer'])
  );
-- No direct workspace insert policy. A verified signup/service procedure must
-- create a personal workspace atomically; organization creation additionally
-- checks authorization/plan limits before invoking the same owner bootstrap.
create policy workspace_update_admin on public.workspaces
  for update to authenticated using (
    public.has_workspace_role(id, array['owner','admin'])
  ) with check (
    public.has_workspace_role(id, array['owner','admin'])
  );
-- No direct workspace delete policy. Deletion/transfer must use a reviewed,
-- audited server-side procedure with explicit confirmation and dependency checks.

create policy membership_select_workspace on public.workspace_memberships
  for select to authenticated using (
    user_id = (select auth.uid())
    or public.has_workspace_role(workspace_id, array['owner','admin'])
  );
-- No direct membership mutations. Invitation acceptance, suspension, role
-- changes, removal, ownership transfer, and deletion must be implemented as
-- narrowly scoped server-side transactions with audit events and tests.

create policy invite_select_admin on public.workspace_invites
  for select to authenticated using (
    public.has_workspace_role(workspace_id, array['owner','admin'])
  );
-- Invite mutations are server-side only so token verification, verified-email
-- checks, expiry, role ceilings, and audit insertion happen atomically.

alter table public.workspace_audit_events enable row level security;

-- No authenticated or anonymous table policies exist for platform_admins.
-- Platform operator checks must use a separate, audited server-only path.
