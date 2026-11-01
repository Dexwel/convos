-- STAGING FOUNDATION ONLY. This does not migrate or modify legacy SQLite data.
-- Create a personal workspace only after Supabase confirms the customer's email.

create unique index if not exists workspaces_one_personal_per_creator
  on public.workspaces(created_by)
  where kind = 'personal';

create or replace function public.bootstrap_verified_customer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  customer_name text;
  workspace_slug text;
begin
  if new.email_confirmed_at is null then
    return new;
  end if;

  if tg_op = 'UPDATE' and old.email_confirmed_at is not null then
    return new;
  end if;

  customer_name := left(
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Convo customer'
    ),
    80
  );

  insert into public.profiles (id, display_name)
  values (new.id, customer_name)
  on conflict (id) do nothing;

  if not exists (
    select 1
    from public.workspaces
    where created_by = new.id
      and kind = 'personal'
  ) then
    workspace_slug :=
      coalesce(
        nullif(trim(both '-' from left(
          regexp_replace(lower(customer_name), '[^a-z0-9]+', '-', 'g'),
          48
        )), ''),
        'workspace'
      )
      || '-'
      || left(replace(new.id::text, '-', ''), 8);

    insert into public.workspaces (name, slug, kind, created_by)
    values (left(customer_name || '''s workspace', 120), workspace_slug, 'personal', new.id)
    on conflict (created_by) where kind = 'personal' do nothing;
  end if;

  return new;
end;
$$;

revoke all on function public.bootstrap_verified_customer() from public, anon, authenticated;

create trigger auth_user_bootstrap_verified_customer
  after insert or update of email_confirmed_at on auth.users
  for each row execute function public.bootstrap_verified_customer();
