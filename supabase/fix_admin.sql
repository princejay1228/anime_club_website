-- =====================================================================
-- FIX: admin page not showing for animeclubsimats@gmail.com
-- Supabase > SQL Editor > New query > paste ALL of this > Run.
-- Safe to run more than once. The table at the end shows every account.
-- =====================================================================
-- =====================================================================
-- Admin bootstrap, made robust.
-- Supabase can create a Google user first and mark the email as verified
-- (or link the Google identity) a moment later. The sign-up trigger only
-- looked at the first moment, so the club account could miss admin rights.
-- This also checks on every later update of the account, and fixes
-- accounts that already exist. Safe to run more than once.
-- =====================================================================

create or replace function public._promote_allowlisted_admin(u auth.users) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  -- Google only: an account that also has an email/password identity is never promoted
  v_google boolean := coalesce(u.raw_app_meta_data ->> 'provider', '') = 'google'
                      and not (coalesce(u.raw_app_meta_data -> 'providers', '["google"]'::jsonb) ? 'email');
begin
  if not v_google or u.email_confirmed_at is null
     or not exists (select 1 from public.admin_allowlist a where a.email = lower(coalesce(u.email, ''))) then
    return false;
  end if;
  perform public._create_profile(u);              -- make sure the profile exists
  update public.profiles set
    is_admin = true,
    membership_status = 'approved',
    full_name = coalesce(full_name, google_name, 'Club Admin'),
    reviewed_at = coalesce(reviewed_at, now()),
    suspended_at = null, suspended_by = null, suspension_reason = null
  where id = u.id and not (is_admin and membership_status = 'approved');
  if found then
    insert into public.moderation_log (actor_id, action, target_type, target_id, reason)
    values (u.id, 'admin_bootstrapped', 'member', u.id::text, 'Email is on admin_allowlist');
  end if;
  return true;
end $$;

create or replace function public.handle_user_updated() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public._promote_allowlisted_admin(new);
  return new;
end $$;

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update of email_confirmed_at, raw_app_meta_data, email on auth.users
  for each row execute function public.handle_user_updated();

revoke execute on function public._promote_allowlisted_admin(auth.users) from public, anon, authenticated;
revoke execute on function public.handle_user_updated() from public, anon, authenticated;

-- Fix accounts that already exist: create any missing profiles, then promote the club account.
select public._create_profile(u) from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);
select public._promote_allowlisted_admin(u) from auth.users u;

-- Every account, so you can check: the club account should say approved + true
select u.email, u.raw_app_meta_data ->> 'provider' as signed_in_with,
       u.email_confirmed_at is not null as email_verified,
       p.membership_status, p.is_admin
from auth.users u left join public.profiles p on p.id = u.id
order by p.is_admin desc nulls last, u.created_at;
