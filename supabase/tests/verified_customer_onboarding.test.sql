begin;

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data
) values
  (
    '00000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'verified@example.test',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Verified Customer"}'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'waiting@example.test',
    null,
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb
  );

do $$
begin
  if (select count(*) from public.workspaces
      where created_by = '00000000-0000-4000-8000-000000000001' and kind = 'personal') <> 1 then
    raise exception 'verified signup must create exactly one personal workspace';
  end if;
  if (select count(*) from public.workspace_memberships
      where user_id = '00000000-0000-4000-8000-000000000001'
        and role = 'owner' and status = 'active') <> 1 then
    raise exception 'verified signup must grant its customer personal-workspace ownership';
  end if;
  if exists (select 1 from public.profiles
      where id = '00000000-0000-4000-8000-000000000002')
    or exists (select 1 from public.workspaces
      where created_by = '00000000-0000-4000-8000-000000000002') then
    raise exception 'unverified signup must not create an accessible customer workspace';
  end if;
end;
$$;

update auth.users
set email_confirmed_at = now()
where id = '00000000-0000-4000-8000-000000000002';

update auth.users
set email_confirmed_at = now()
where id = '00000000-0000-4000-8000-000000000002';

do $$
begin
  if (select count(*) from public.workspaces
      where created_by = '00000000-0000-4000-8000-000000000002' and kind = 'personal') <> 1 then
    raise exception 'email verification and retries must create exactly one personal workspace';
  end if;
  if (select count(*) from public.workspace_memberships
      where user_id = '00000000-0000-4000-8000-000000000002'
        and role = 'owner' and status = 'active') <> 1 then
    raise exception 'verified customer must own exactly one personal workspace';
  end if;
end;
$$;

rollback;
