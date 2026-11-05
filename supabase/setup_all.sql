-- =====================================================================
-- SIMATS Anime Club — ONE-PASTE DATABASE SETUP
-- Supabase > SQL Editor > New query > paste ALL of this > Run.
-- It is the six files in supabase/migrations/ in order, plus a safety
-- check at the top: it finishes an earlier setup that stopped part-way, and
-- once everything is installed, running it again stops without touching data.
-- =====================================================================

do $$
declare
  f text;
begin
  -- fully installed already (the last migration's function exists)? stop without changing anything
  if to_regprocedure('public.apply_event_sync(bigint,jsonb)') is not null
     and to_regprocedure('public.admin_list_log(text,text,integer)') is not null then
    if to_regprocedure('public.admin_cancel_event(uuid,text)') is null then
      raise exception 'The club database is already set up. Nothing was changed. To add notices, office bearers and meeting cancellation, run supabase/update_2026_11_05_notices.sql instead.';
    end if;
    raise exception 'The club database is already set up and complete. Nothing was changed. Reload the website (if the admin page is missing, run supabase/fix_admin.sql).';
  end if;
  -- an earlier attempt stopped part-way: the site could not work yet, so clear what it made and start clean
  if to_regclass('public.admin_allowlist') is not null or to_regclass('public.event_sync_logs') is not null
     or to_regclass('public.club_settings') is not null then
    drop trigger if exists on_auth_user_created on auth.users;
    drop trigger if exists on_auth_user_updated on auth.users;
    drop table if exists public.notices, public.event_sync_logs, public.moderation_log, public.comments, public.votes, public.poll_options,
      public.polls, public.events, public.profiles, public.club_settings, public.admin_allowlist cascade;
    foreach f in array array['_log','_require_admin','_require_member','_clean_text','_poll_phase','_check_comment_body',
      '_create_profile','touch_updated_at','is_admin','is_approved_member','handle_new_user','submit_membership','get_polls',
      'cast_vote','list_event_comments','event_comment_counts','post_comment','edit_my_comment','delete_my_comment',
      'admin_overview','admin_review_member','admin_bulk_approve','admin_suspend_member','admin_restore_member','admin_set_admin',
      'admin_save_poll','admin_set_poll_status','admin_delete_poll','admin_list_comments','admin_moderate_comment',
      'admin_set_comment_premoderation','admin_save_event','admin_delete_event','admin_release_event_override',
      'admin_list_log','apply_event_sync','_promote_allowlisted_admin','handle_user_updated',
      'list_notices','notice_unread_count','mark_notices_seen','list_office_bearers','admin_set_position',
      'admin_post_notice','admin_delete_notice','admin_list_notices','admin_cancel_event'] loop
      execute format('drop function if exists public.%I cascade', f);
    end loop;
    raise notice 'Cleared an unfinished earlier setup; installing fresh.';
  end if;
  -- remove the early draft tables from chat, if they were created (they only held test data)
  if to_regclass('public.poll_votes') is not null
     or (to_regclass('public.profiles') is not null and not exists (
           select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'profiles' and column_name = 'membership_status')) then
    drop trigger if exists on_auth_user_created on auth.users;
    drop table if exists public.poll_votes, public.poll_options, public.polls, public.comments, public.profiles cascade;
    drop function if exists public.handle_new_user() cascade;
    drop function if exists public.is_admin() cascade;
    drop function if exists public.is_approved_member() cascade;
    raise notice 'Removed the early draft tables.';
  end if;
end $$;



-- ===================== 20261103000001_core_schema.sql =====================
-- =====================================================================
-- SIMATS Anime Club — core schema
-- Tables, constraints, indexes, timestamps and the sign-up trigger.
-- Run the migrations in filename order (Supabase CLI does this for you).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Admin bootstrap list.
-- Accounts whose Google email is listed here become admins (and approved
-- members) the first time they sign in. Nobody can edit this table from
-- the website: RLS is on and there are no policies, so only the database
-- owner / service role (SQL editor) can change it.
-- ---------------------------------------------------------------------
create table public.admin_allowlist (
  email      text primary key check (email = lower(email)),
  note       text,
  created_at timestamptz not null default now()
);

insert into public.admin_allowlist (email, note)
values ('animeclubsimats@gmail.com', 'Club admin account');

-- ---------------------------------------------------------------------
-- Club-wide settings (single row).
-- ---------------------------------------------------------------------
create table public.club_settings (
  id                    int primary key default 1 check (id = 1),
  comment_premoderation boolean not null default true,  -- new comments wait for an admin
  updated_at            timestamptz not null default now(),
  updated_by            uuid
);
insert into public.club_settings (id) values (1);

-- ---------------------------------------------------------------------
-- Member profiles. One row per auth user, created by a trigger.
-- membership_status:
--   pending            signed in, has not filled in the name form yet
--   awaiting_approval  submitted name, waiting for an admin
--   approved           full member (can vote and comment)
--   rejected           admin declined the request (can re-apply)
--   suspended          admin suspended the member
-- ---------------------------------------------------------------------
create table public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  email               text not null,
  google_name         text,                       -- name supplied by Google, for reference
  avatar_url          text,
  full_name           text check (full_name is null or char_length(btrim(full_name)) between 2 and 80),
  year_of_study       text check (year_of_study is null or char_length(year_of_study) <= 30),
  department          text check (department is null or char_length(department) <= 80),
  membership_status   text not null default 'pending'
                      check (membership_status in ('pending','awaiting_approval','approved','rejected','suspended')),
  is_admin            boolean not null default false,
  requested_at        timestamptz,                -- when the name form was (last) submitted
  reviewed_at         timestamptz,
  reviewed_by         uuid references public.profiles (id) on delete set null,
  review_note         text check (review_note is null or char_length(review_note) <= 300),
  suspended_at        timestamptz,
  suspended_by        uuid references public.profiles (id) on delete set null,
  suspension_reason   text check (suspension_reason is null or char_length(suspension_reason) <= 300),
  admin_notified_at   timestamptz,                -- last approval-request email sent to the admin
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- an admin is always an approved member
  constraint admin_is_approved check (not is_admin or membership_status = 'approved')
);
create index profiles_status_idx on public.profiles (membership_status, requested_at desc);
create unique index profiles_email_idx on public.profiles (lower(email));

-- ---------------------------------------------------------------------
-- Events (imported from Google Drive or added by an admin).
-- ---------------------------------------------------------------------
create table public.events (
  id               uuid primary key default gen_random_uuid(),
  source           text not null default 'manual' check (source in ('drive','manual')),
  external_id      text,                           -- stable id from the Drive sheet
  title            text not null check (char_length(btrim(title)) between 2 and 140),
  starts_at        timestamptz not null,
  ends_at          timestamptz,
  venue            text check (venue is null or char_length(venue) <= 140),
  description      text check (description is null or char_length(description) <= 2000),
  image_url        text check (image_url is null or image_url ~* '^https://'),
  category         text check (category is null or char_length(category) <= 40),
  status           text not null default 'scheduled'
                   check (status in ('scheduled','postponed','cancelled','completed','hidden')),
  manual_override  boolean not null default false, -- admin edited a Drive event: sync leaves it alone
  content_hash     text,                           -- hash of the imported row, to detect changes
  last_synced_at   timestamptz,
  created_by       uuid references public.profiles (id) on delete set null,
  updated_by       uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint events_drive_needs_id check (source = 'manual' or external_id is not null),
  constraint events_end_after_start check (ends_at is null or ends_at >= starts_at)
);
create unique index events_source_external_idx on public.events (source, external_id) where external_id is not null;
create index events_starts_idx on public.events (starts_at);

-- ---------------------------------------------------------------------
-- Polls
-- ---------------------------------------------------------------------
create table public.polls (
  id           uuid primary key default gen_random_uuid(),
  question     text not null check (char_length(btrim(question)) between 3 and 200),
  description  text check (description is null or char_length(description) <= 1000),
  status       text not null default 'draft' check (status in ('draft','active','closed')),
  opens_at     timestamptz,
  closes_at    timestamptz,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint polls_close_after_open check (closes_at is null or opens_at is null or closes_at > opens_at)
);
create index polls_status_idx on public.polls (status, created_at desc);

create table public.poll_options (
  id         uuid primary key default gen_random_uuid(),
  poll_id    uuid not null references public.polls (id) on delete cascade,
  label      text not null check (char_length(btrim(label)) between 1 and 120),
  position   int  not null default 0,
  created_at timestamptz not null default now(),
  unique (id, poll_id)      -- lets votes prove the option belongs to the poll
);
create index poll_options_poll_idx on public.poll_options (poll_id, position);

-- One vote per member per poll, enforced by the primary key.
create table public.votes (
  poll_id    uuid not null references public.polls (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  option_id  uuid not null,
  created_at timestamptz not null default now(),
  primary key (poll_id, user_id),
  foreign key (option_id, poll_id) references public.poll_options (id, poll_id) on delete cascade
);
create index votes_option_idx on public.votes (option_id);
create index votes_created_idx on public.votes (created_at desc);

-- ---------------------------------------------------------------------
-- Comments on events.
-- status:
--   pending   waiting for an admin (when pre-moderation is on)
--   visible   shown to everyone
--   hidden    hidden by an admin (author still sees it, marked hidden)
--   removed   removed by an admin (kept for review, author sees a notice)
--   deleted   deleted by its author (soft delete, kept for review)
-- ---------------------------------------------------------------------
create table public.comments (
  id                 bigint generated always as identity primary key,
  event_id           uuid not null references public.events (id) on delete cascade,
  user_id            uuid not null references public.profiles (id) on delete cascade,
  body               text not null check (char_length(btrim(body)) between 2 and 500),
  status             text not null default 'pending'
                     check (status in ('pending','visible','hidden','removed','deleted')),
  edited_at          timestamptz,
  moderated_at       timestamptz,
  moderated_by       uuid references public.profiles (id) on delete set null,
  moderation_reason  text check (moderation_reason is null or char_length(moderation_reason) <= 300),
  created_at         timestamptz not null default now()
);
create index comments_event_idx on public.comments (event_id, created_at);
create index comments_user_idx on public.comments (user_id, created_at desc);
create index comments_status_idx on public.comments (status, created_at desc);

-- ---------------------------------------------------------------------
-- Audit log of admin actions. Append-only.
-- ---------------------------------------------------------------------
create table public.moderation_log (
  id           bigint generated always as identity primary key,
  actor_id     uuid references public.profiles (id) on delete set null,
  action       text not null,
  target_type  text not null check (target_type in ('member','comment','poll','event','settings','sync')),
  target_id    text,
  reason       text,
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index moderation_log_created_idx on public.moderation_log (created_at desc);
create index moderation_log_target_idx on public.moderation_log (target_type, target_id);

-- ---------------------------------------------------------------------
-- Google Drive sync history.
-- ---------------------------------------------------------------------
create table public.event_sync_logs (
  id            bigint generated always as identity primary key,
  trigger       text not null check (trigger in ('cron','manual')),
  triggered_by  uuid references public.profiles (id) on delete set null,
  status        text not null default 'running' check (status in ('running','success','failed')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  rows_read     int,
  inserted      int,
  updated       int,
  unchanged     int,
  hidden        int,
  skipped       int,
  error         text,
  details       jsonb not null default '{}'::jsonb
);
create index event_sync_logs_started_idx on public.event_sync_logs (started_at desc);

-- ---------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger events_touch   before update on public.events   for each row execute function public.touch_updated_at();
create trigger polls_touch    before update on public.polls    for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Role helpers used by policies and functions.
-- SECURITY DEFINER so they can read profiles regardless of RLS;
-- they only ever answer about the calling user.
-- ---------------------------------------------------------------------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select p.is_admin and p.membership_status = 'approved' from public.profiles p where p.id = auth.uid()),
    false)
$$;

create or replace function public.is_approved_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.membership_status = 'approved')
$$;

-- ---------------------------------------------------------------------
-- Create a profile when someone signs in for the first time.
-- Admin rights come only from admin_allowlist, and only for a verified
-- Google account, so nobody can make themselves admin from the browser.
-- ---------------------------------------------------------------------
create or replace function public._create_profile(u auth.users) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_email    text := lower(coalesce(u.email, ''));
  v_provider text := coalesce(u.raw_app_meta_data ->> 'provider', '');
  v_admin    boolean;
begin
  v_admin := v_provider = 'google'
             and u.email_confirmed_at is not null
             and exists (select 1 from public.admin_allowlist a where a.email = v_email);

  insert into public.profiles (id, email, google_name, avatar_url, full_name,
                               membership_status, is_admin, reviewed_at)
  values (
    u.id,
    v_email,
    left(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name'), 80),
    nullif(coalesce(u.raw_user_meta_data ->> 'avatar_url', u.raw_user_meta_data ->> 'picture'), ''),
    case when v_admin then left(coalesce(u.raw_user_meta_data ->> 'full_name', 'Club Admin'), 80) end,
    case when v_admin then 'approved' else 'pending' end,
    v_admin,
    case when v_admin then now() end
  )
  on conflict (id) do nothing;

  if v_admin and found then
    insert into public.moderation_log (actor_id, action, target_type, target_id, reason)
    values (u.id, 'admin_bootstrapped', 'member', u.id::text, 'Email is on admin_allowlist');
  end if;
end $$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public._create_profile(new);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Anyone who already signed in before these migrations ran gets a profile too.
select public._create_profile(u) from auth.users u;


-- ===================== 20261103000002_rls_policies.sql =====================
-- =====================================================================
-- Row Level Security.
--
-- Rule of thumb: the browser may READ through these policies, but it can
-- never INSERT/UPDATE/DELETE tables directly. Every write goes through a
-- SECURITY DEFINER function (next migration) that checks who is calling,
-- validates the input and writes the audit log in the same transaction.
-- =====================================================================

alter table public.admin_allowlist  enable row level security;
alter table public.club_settings    enable row level security;
alter table public.profiles         enable row level security;
alter table public.events           enable row level security;
alter table public.polls            enable row level security;
alter table public.poll_options     enable row level security;
alter table public.votes            enable row level security;
alter table public.comments         enable row level security;
alter table public.moderation_log   enable row level security;
alter table public.event_sync_logs  enable row level security;

-- Defence in depth: no direct writes from the website's roles at all.
revoke insert, update, delete, truncate on
  public.admin_allowlist, public.club_settings, public.profiles, public.events,
  public.polls, public.poll_options, public.votes, public.comments,
  public.moderation_log, public.event_sync_logs
from anon, authenticated;

-- The allowlist is never readable from the website.
revoke select on public.admin_allowlist from anon, authenticated;

-- ---------- club_settings: anyone can read ----------
create policy "settings readable" on public.club_settings
  for select to anon, authenticated using (true);

-- ---------- profiles ----------
-- Members see their own profile (so a suspended or pending member can see
-- their status); admins see everyone. Other members' names reach the page
-- only through the comment-listing function, never by reading this table.
create policy "own profile" on public.profiles
  for select to authenticated using (id = auth.uid());
create policy "admins read profiles" on public.profiles
  for select to authenticated using (public.is_admin());

-- ---------- events ----------
create policy "public events" on public.events
  for select to anon, authenticated using (status <> 'hidden');
create policy "admins read all events" on public.events
  for select to authenticated using (public.is_admin());

-- ---------- polls and options ----------
-- Drafts are admin-only; active and closed polls are public.
create policy "public polls" on public.polls
  for select to anon, authenticated using (status in ('active','closed'));
create policy "admins read all polls" on public.polls
  for select to authenticated using (public.is_admin());

create policy "public poll options" on public.poll_options
  for select to anon, authenticated
  using (exists (select 1 from public.polls p where p.id = poll_id and p.status in ('active','closed')));
create policy "admins read all options" on public.poll_options
  for select to authenticated using (public.is_admin());

-- ---------- votes ----------
-- You can see your own vote. Totals come from get_polls(), which never
-- reveals who voted for what.
create policy "own votes" on public.votes
  for select to authenticated using (user_id = auth.uid());
create policy "admins read votes" on public.votes
  for select to authenticated using (public.is_admin());

-- ---------- comments ----------
create policy "visible comments" on public.comments
  for select to anon, authenticated using (status = 'visible');
create policy "own comments" on public.comments
  for select to authenticated using (user_id = auth.uid() and status <> 'deleted');
create policy "admins read comments" on public.comments
  for select to authenticated using (public.is_admin());

-- ---------- audit and sync logs: admins only ----------
create policy "admins read moderation log" on public.moderation_log
  for select to authenticated using (public.is_admin());
create policy "admins read sync logs" on public.event_sync_logs
  for select to authenticated using (public.is_admin());


-- ===================== 20261103000003_member_admin_functions.sql =====================
-- =====================================================================
-- Server-side functions (called from the website with supabase.rpc()).
--
-- Every function checks the caller itself (auth.uid(), is_admin(),
-- membership status). Hiding a button in the page is never what stops a
-- request: a pending, rejected or suspended member who calls these
-- functions directly gets the same error the page would show.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Internal helpers (not callable from the website)
-- ---------------------------------------------------------------------
create or replace function public._log(p_action text, p_target_type text, p_target_id text,
                                       p_reason text default null, p_details jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.moderation_log (actor_id, action, target_type, target_id, reason, details)
  values (auth.uid(), p_action, p_target_type, p_target_id, nullif(btrim(p_reason), ''), coalesce(p_details, '{}'::jsonb));
$$;

create or replace function public._require_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Please sign in first.' using errcode = '42501';
  end if;
  if not public.is_admin() then
    raise exception 'Only club admins can do that.' using errcode = '42501';
  end if;
end $$;

-- Raises a clear message for every non-member state.
create or replace function public._require_member() returns void
language plpgsql stable security definer set search_path = public as $$
declare v_status text;
begin
  if auth.uid() is null then
    raise exception 'Please sign in first.' using errcode = '42501';
  end if;
  select membership_status into v_status from public.profiles where id = auth.uid();
  if v_status is null then
    raise exception 'Your profile was not found. Please sign out and sign in again.' using errcode = '42501';
  elsif v_status = 'pending' then
    raise exception 'Please tell us your name first, then an admin will approve your membership.' using errcode = '42501';
  elsif v_status = 'awaiting_approval' then
    raise exception 'Your membership is waiting for admin approval.' using errcode = '42501';
  elsif v_status = 'rejected' then
    raise exception 'Your membership request was not approved.' using errcode = '42501';
  elsif v_status = 'suspended' then
    raise exception 'Your account is suspended, so you cannot do that right now.' using errcode = '42501';
  end if;
end $$;

-- Collapse runs of spaces/tabs, trim each line, drop blank-line runs.
create or replace function public._clean_text(p text) returns text
language sql immutable as $$
  select nullif(btrim(regexp_replace(regexp_replace(coalesce(p, ''), '[ \t\r]+', ' ', 'g'), '\n{3,}', E'\n\n', 'g')), '')
$$;

-- ---------------------------------------------------------------------
-- MEMBERSHIP
-- ---------------------------------------------------------------------
create or replace function public.submit_membership(p_full_name text, p_year text default null, p_department text default null)
returns public.profiles
language plpgsql security definer set search_path = public as $$
declare
  v_me   public.profiles;
  v_name text := public._clean_text(replace(p_full_name, E'\n', ' '));
begin
  if auth.uid() is null then
    raise exception 'Please sign in first.' using errcode = '42501';
  end if;
  select * into v_me from public.profiles where id = auth.uid() for update;
  if not found then
    raise exception 'Your profile was not found. Please sign out and sign in again.';
  end if;
  if v_me.membership_status = 'approved' then
    raise exception 'You are already an approved member. Ask an admin if your name needs changing.';
  elsif v_me.membership_status = 'suspended' then
    raise exception 'Your account is suspended.';
  end if;
  if v_name is null or char_length(v_name) < 2 or char_length(v_name) > 80 or v_name !~ '[[:alpha:]]' then
    raise exception 'Please enter your full name (2 to 80 characters).';
  end if;

  update public.profiles set
    full_name         = v_name,
    year_of_study     = left(public._clean_text(p_year), 30),
    department        = left(public._clean_text(p_department), 80),
    requested_at      = case when membership_status = 'awaiting_approval' then requested_at else now() end,
    membership_status = 'awaiting_approval',
    review_note       = case when membership_status = 'rejected' then null else review_note end
  where id = auth.uid()
  returning * into v_me;
  return v_me;
end $$;

-- ---------------------------------------------------------------------
-- POLLS
-- ---------------------------------------------------------------------
create or replace function public._poll_phase(p public.polls) returns text
language sql stable as $$
  select case
    when p.status = 'draft'  then 'draft'
    when p.status = 'closed' then 'closed'
    when p.closes_at is not null and p.closes_at <= now() then 'closed'
    when p.opens_at  is not null and p.opens_at  >  now() then 'upcoming'
    else 'open' end
$$;

-- All polls the caller may see, with options, their vote, and totals.
-- Option counts are only returned once the caller has voted, the poll
-- has closed, or the caller is an admin, so nobody votes with the crowd.
create or replace function public.get_polls(p_include_drafts boolean default false)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_admin boolean := public.is_admin();
begin
  return coalesce((
    select jsonb_agg(x.j order by x.sort_key, x.sort_time desc)
    from (
      select
        case public._poll_phase(p) when 'open' then 0 when 'upcoming' then 1 when 'draft' then 2 else 3 end as sort_key,
        coalesce(p.closes_at, p.created_at) as sort_time,
        jsonb_build_object(
          'id', p.id,
          'question', p.question,
          'description', p.description,
          'status', p.status,
          'phase', public._poll_phase(p),
          'opens_at', p.opens_at,
          'closes_at', p.closes_at,
          'created_at', p.created_at,
          'total_votes', (select count(*) from public.votes v where v.poll_id = p.id),
          'my_option_id', (select v.option_id from public.votes v where v.poll_id = p.id and v.user_id = v_uid),
          'results_visible', (v_admin or public._poll_phase(p) = 'closed'
                              or exists (select 1 from public.votes v where v.poll_id = p.id and v.user_id = v_uid)),
          'options', coalesce((
            select jsonb_agg(jsonb_build_object(
                     'id', o.id,
                     'label', o.label,
                     'votes', case when (v_admin or public._poll_phase(p) = 'closed'
                                         or exists (select 1 from public.votes v where v.poll_id = p.id and v.user_id = v_uid))
                                   then (select count(*) from public.votes v where v.option_id = o.id) end)
                   order by o.position, o.created_at)
            from public.poll_options o where o.poll_id = p.id), '[]'::jsonb)
        ) as j
      from public.polls p
      where p.status in ('active','closed') or (v_admin and p_include_drafts)
    ) x), '[]'::jsonb);
end $$;

create or replace function public.cast_vote(p_poll uuid, p_option uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_poll public.polls;
begin
  perform public._require_member();
  select * into v_poll from public.polls where id = p_poll;
  if not found or v_poll.status = 'draft' then
    raise exception 'That poll does not exist.';
  end if;
  case public._poll_phase(v_poll)
    when 'closed'   then raise exception 'This poll is closed.';
    when 'upcoming' then raise exception 'This poll has not opened yet.';
    else null;
  end case;
  if not exists (select 1 from public.poll_options where id = p_option and poll_id = p_poll) then
    raise exception 'That option is not part of this poll.';
  end if;
  begin
    insert into public.votes (poll_id, user_id, option_id) values (p_poll, auth.uid(), p_option);
  exception when unique_violation then
    raise exception 'You have already voted in this poll.';
  end;
end $$;

-- ---------------------------------------------------------------------
-- COMMENTS
-- ---------------------------------------------------------------------
create or replace function public.list_event_comments(p_event uuid)
returns table (id bigint, body text, status text, created_at timestamptz, edited_at timestamptz,
               author_name text, author_avatar text, is_mine boolean, moderation_reason text)
language sql stable security definer set search_path = public as $$
  select c.id, c.body, c.status, c.created_at, c.edited_at,
         coalesce(p.full_name, 'Member'), p.avatar_url,
         c.user_id = auth.uid(),
         case when c.user_id = auth.uid() then c.moderation_reason end
  from public.comments c
  join public.profiles p on p.id = c.user_id
  join public.events e on e.id = c.event_id and e.status <> 'hidden'
  where c.event_id = p_event
    and (c.status = 'visible' or (c.user_id = auth.uid() and c.status <> 'deleted'))
  order by c.created_at
  limit 300
$$;

create or replace function public.event_comment_counts()
returns table (event_id uuid, comments bigint)
language sql stable security definer set search_path = public as $$
  select c.event_id, count(*) from public.comments c
  join public.events e on e.id = c.event_id and e.status <> 'hidden'
  where c.status = 'visible' group by c.event_id
$$;

create or replace function public._check_comment_body(p_body text) returns text
language plpgsql stable as $$
declare v text := public._clean_text(p_body);
begin
  if v is null or char_length(v) < 2 then
    raise exception 'Write a little more before posting.';
  elsif char_length(v) > 500 then
    raise exception 'Comments can be at most 500 characters.';
  elsif (select count(*) from regexp_matches(v, 'https?://|www\.', 'gi')) > 2 then
    raise exception 'Please include at most two links in a comment.';
  elsif v ~ '(.)\1{24,}' then
    raise exception 'That looks like spam. Please write a normal comment.';
  end if;
  return v;
end $$;

create or replace function public.post_comment(p_event uuid, p_body text)
returns public.comments
language plpgsql security definer set search_path = public as $$
declare
  v_body text;
  v_row  public.comments;
  v_pre  boolean;
begin
  perform public._require_member();
  if not exists (select 1 from public.events where id = p_event and status <> 'hidden') then
    raise exception 'That event does not exist.';
  end if;
  v_body := public._check_comment_body(p_body);

  -- spam protection: 5 comments per 10 minutes, no repeats within a day
  if (select count(*) from public.comments where user_id = auth.uid() and created_at > now() - interval '10 minutes') >= 5 then
    raise exception 'You are commenting very fast. Please wait a few minutes.';
  end if;
  if exists (select 1 from public.comments where user_id = auth.uid() and lower(body) = lower(v_body)
             and created_at > now() - interval '1 day' and status <> 'deleted') then
    raise exception 'You already posted that comment.';
  end if;

  select comment_premoderation into v_pre from public.club_settings where id = 1;
  insert into public.comments (event_id, user_id, body, status)
  values (p_event, auth.uid(), v_body, case when coalesce(v_pre, true) and not public.is_admin() then 'pending' else 'visible' end)
  returning * into v_row;
  return v_row;
end $$;

create or replace function public.edit_my_comment(p_id bigint, p_body text)
returns public.comments
language plpgsql security definer set search_path = public as $$
declare
  v_row  public.comments;
  v_body text;
  v_pre  boolean;
begin
  perform public._require_member();
  select * into v_row from public.comments where id = p_id for update;
  if not found or v_row.user_id <> auth.uid() then
    raise exception 'You can only edit your own comments.' using errcode = '42501';
  end if;
  if v_row.status not in ('pending','visible') then
    raise exception 'This comment was moderated and can no longer be edited.';
  end if;
  v_body := public._check_comment_body(p_body);
  select comment_premoderation into v_pre from public.club_settings where id = 1;
  update public.comments set
    body = v_body,
    edited_at = now(),
    -- with pre-moderation on, an edited comment is checked again
    status = case when coalesce(v_pre, true) and not public.is_admin() then 'pending' else status end
  where id = p_id
  returning * into v_row;
  return v_row;
end $$;

create or replace function public.delete_my_comment(p_id bigint)
returns void
language plpgsql security definer set search_path = public as $$
declare v_row public.comments;
begin
  if auth.uid() is null then
    raise exception 'Please sign in first.' using errcode = '42501';
  end if;
  select * into v_row from public.comments where id = p_id for update;
  if not found or v_row.user_id <> auth.uid() then
    raise exception 'You can only delete your own comments.' using errcode = '42501';
  end if;
  if v_row.status = 'removed' then
    raise exception 'This comment was already removed by a moderator.';
  end if;
  update public.comments set status = 'deleted' where id = p_id;   -- soft delete, kept for review
end $$;

-- ---------------------------------------------------------------------
-- ADMIN: overview
-- ---------------------------------------------------------------------
create or replace function public.admin_overview()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform public._require_admin();
  select jsonb_build_object(
    'members_approved',  (select count(*) from public.profiles where membership_status = 'approved'),
    'members_awaiting',  (select count(*) from public.profiles where membership_status = 'awaiting_approval'),
    'members_no_name',   (select count(*) from public.profiles where membership_status = 'pending'),
    'members_suspended', (select count(*) from public.profiles where membership_status = 'suspended'),
    'members_total',     (select count(*) from public.profiles),
    'active_polls',      (select count(*) from public.polls p where public._poll_phase(p) = 'open'),
    'votes_7d',          (select count(*) from public.votes where created_at > now() - interval '7 days'),
    'comments_7d',       (select count(*) from public.comments where created_at > now() - interval '7 days'),
    'comments_pending',  (select count(*) from public.comments where status = 'pending'),
    'upcoming_events',   (select count(*) from public.events where status in ('scheduled','postponed')
                            and coalesce(ends_at, starts_at) >= now()),
    'last_sync_success', (select max(finished_at) from public.event_sync_logs where status = 'success'),
    'last_sync',         (select jsonb_build_object('status', status, 'started_at', started_at, 'finished_at', finished_at, 'error', error)
                            from public.event_sync_logs order by started_at desc limit 1),
    'comment_premoderation', (select comment_premoderation from public.club_settings where id = 1),
    -- votes are listed without the voter's name: ballots stay private
    'recent_votes', coalesce((select jsonb_agg(r) from (
        select p.question, o.label, v.created_at from public.votes v
        join public.polls p on p.id = v.poll_id join public.poll_options o on o.id = v.option_id
        order by v.created_at desc limit 8) r), '[]'::jsonb),
    'recent_comments', coalesce((select jsonb_agg(r) from (
        select c.id, c.body, c.status, c.created_at, pr.full_name as author, e.title as event_title
        from public.comments c join public.profiles pr on pr.id = c.user_id join public.events e on e.id = c.event_id
        order by c.created_at desc limit 6) r), '[]'::jsonb),
    'next_events', coalesce((select jsonb_agg(r) from (
        select id, title, starts_at, venue, status, source from public.events
        where status in ('scheduled','postponed') and coalesce(ends_at, starts_at) >= now()
        order by starts_at limit 5) r), '[]'::jsonb)
  ) into v;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- ADMIN: members
-- ---------------------------------------------------------------------
create or replace function public.admin_review_member(p_user uuid, p_approve boolean, p_note text default null)
returns public.profiles
language plpgsql security definer set search_path = public as $$
declare v public.profiles;
begin
  perform public._require_admin();
  select * into v from public.profiles where id = p_user for update;
  if not found then raise exception 'Member not found.'; end if;
  if p_approve then
    if v.membership_status not in ('awaiting_approval','rejected') then
      raise exception 'Only members waiting for approval (or previously rejected) can be approved.';
    end if;
    if v.full_name is null then raise exception 'This member has not given their name yet.'; end if;
  else
    if v.membership_status <> 'awaiting_approval' then
      raise exception 'Only members waiting for approval can be rejected.';
    end if;
  end if;
  update public.profiles set
    membership_status = case when p_approve then 'approved' else 'rejected' end,
    reviewed_at = now(), reviewed_by = auth.uid(),
    review_note = left(public._clean_text(p_note), 300)
  where id = p_user returning * into v;
  perform public._log(case when p_approve then 'member_approved' else 'member_rejected' end,
                      'member', p_user::text, p_note,
                      jsonb_build_object('name', v.full_name, 'email', v.email));
  return v;
end $$;

create or replace function public.admin_bulk_approve(p_users uuid[])
returns int
language plpgsql security definer set search_path = public as $$
declare u uuid; n int := 0;
begin
  perform public._require_admin();
  foreach u in array coalesce(p_users, '{}') loop
    if exists (select 1 from public.profiles where id = u and membership_status = 'awaiting_approval' and full_name is not null) then
      perform public.admin_review_member(u, true, 'Bulk approval');
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

create or replace function public.admin_suspend_member(p_user uuid, p_reason text)
returns public.profiles
language plpgsql security definer set search_path = public as $$
declare v public.profiles; v_reason text := public._clean_text(p_reason);
begin
  perform public._require_admin();
  if p_user = auth.uid() then raise exception 'You cannot suspend yourself.'; end if;
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'Please give a reason for the suspension.';
  end if;
  select * into v from public.profiles where id = p_user for update;
  if not found then raise exception 'Member not found.'; end if;
  if v.is_admin then raise exception 'Remove admin rights before suspending an admin.'; end if;
  if v.membership_status <> 'approved' then
    raise exception 'Only approved members can be suspended. Use Reject for pending requests.';
  end if;
  update public.profiles set membership_status = 'suspended', suspended_at = now(),
    suspended_by = auth.uid(), suspension_reason = left(v_reason, 300)
  where id = p_user returning * into v;
  perform public._log('member_suspended', 'member', p_user::text, v_reason,
                      jsonb_build_object('name', v.full_name, 'email', v.email));
  return v;
end $$;

create or replace function public.admin_restore_member(p_user uuid, p_note text default null)
returns public.profiles
language plpgsql security definer set search_path = public as $$
declare v public.profiles;
begin
  perform public._require_admin();
  select * into v from public.profiles where id = p_user for update;
  if not found then raise exception 'Member not found.'; end if;
  if v.membership_status <> 'suspended' then raise exception 'This member is not suspended.'; end if;
  perform public._log('member_restored', 'member', p_user::text, p_note,
                      jsonb_build_object('name', v.full_name, 'email', v.email,
                                         'suspended_at', v.suspended_at, 'suspension_reason', v.suspension_reason));
  update public.profiles set membership_status = 'approved', suspended_at = null,
    suspended_by = null, suspension_reason = null
  where id = p_user returning * into v;
  return v;
end $$;

create or replace function public.admin_set_admin(p_user uuid, p_make_admin boolean)
returns public.profiles
language plpgsql security definer set search_path = public as $$
declare v public.profiles;
begin
  perform public._require_admin();
  select * into v from public.profiles where id = p_user for update;
  if not found then raise exception 'Member not found.'; end if;
  if p_make_admin and v.membership_status <> 'approved' then
    raise exception 'Only approved members can be made admins.';
  end if;
  if not p_make_admin and v.is_admin
     and (select count(*) from public.profiles where is_admin and membership_status = 'approved') <= 1 then
    raise exception 'The club must keep at least one admin.';
  end if;
  update public.profiles set is_admin = p_make_admin where id = p_user returning * into v;
  perform public._log(case when p_make_admin then 'admin_granted' else 'admin_revoked' end,
                      'member', p_user::text, null, jsonb_build_object('name', v.full_name, 'email', v.email));
  return v;
end $$;

-- ---------------------------------------------------------------------
-- ADMIN: polls
-- p_options: [{"id": "<uuid or null>", "label": "Anime quiz"}, ...] in display order
-- ---------------------------------------------------------------------
create or replace function public.admin_save_poll(p_poll_id uuid, p_question text, p_description text,
                                                  p_opens_at timestamptz, p_closes_at timestamptz, p_options jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id      uuid := p_poll_id;
  v_q       text := public._clean_text(replace(p_question, E'\n', ' '));
  v_opt     jsonb;
  v_label   text;
  v_keep    uuid[] := '{}';
  v_pos     int := 0;
  v_optid   uuid;
  v_labels  text[] := '{}';
  v_blocked text;
begin
  perform public._require_admin();
  if v_q is null or char_length(v_q) < 3 then raise exception 'Write a poll question.'; end if;
  if jsonb_typeof(p_options) <> 'array' or jsonb_array_length(p_options) < 2 then
    raise exception 'A poll needs at least two options.';
  end if;
  if jsonb_array_length(p_options) > 12 then raise exception 'A poll can have at most 12 options.'; end if;
  if p_closes_at is not null and p_opens_at is not null and p_closes_at <= p_opens_at then
    raise exception 'The closing time must be after the opening time.';
  end if;
  for v_opt in select * from jsonb_array_elements(p_options) loop
    v_label := public._clean_text(replace(v_opt ->> 'label', E'\n', ' '));
    if v_label is null then raise exception 'Every option needs a label.'; end if;
    if lower(v_label) = any (v_labels) then raise exception 'Option "%" is listed twice.', v_label; end if;
    v_labels := v_labels || lower(v_label);
  end loop;

  if v_id is null then
    insert into public.polls (question, description, opens_at, closes_at, created_by)
    values (v_q, public._clean_text(p_description), p_opens_at, p_closes_at, auth.uid())
    returning id into v_id;
  else
    update public.polls set question = v_q, description = public._clean_text(p_description),
      opens_at = p_opens_at, closes_at = p_closes_at
    where id = v_id;
    if not found then raise exception 'Poll not found.'; end if;
  end if;

  -- keep options that are still listed (by id); refuse to drop options that have votes
  for v_opt in select * from jsonb_array_elements(p_options) loop
    if nullif(v_opt ->> 'id', '') is not null then
      v_keep := v_keep || (v_opt ->> 'id')::uuid;
    end if;
  end loop;
  select string_agg(o.label, ', ') into v_blocked from public.poll_options o
  where o.poll_id = v_id and not (o.id = any (v_keep))
    and exists (select 1 from public.votes v where v.option_id = o.id);
  if v_blocked is not null then
    raise exception 'These options already have votes and cannot be removed: %', v_blocked;
  end if;
  delete from public.poll_options o where o.poll_id = v_id and not (o.id = any (v_keep));

  for v_opt in select * from jsonb_array_elements(p_options) loop
    v_label := public._clean_text(replace(v_opt ->> 'label', E'\n', ' '));
    v_optid := nullif(v_opt ->> 'id', '')::uuid;
    if v_optid is null then
      insert into public.poll_options (poll_id, label, position) values (v_id, v_label, v_pos);
    else
      update public.poll_options set label = v_label, position = v_pos where id = v_optid and poll_id = v_id;
      if not found then raise exception 'An option does not belong to this poll.'; end if;
    end if;
    v_pos := v_pos + 1;
  end loop;

  perform public._log(case when p_poll_id is null then 'poll_created' else 'poll_edited' end, 'poll', v_id::text, null,
                      jsonb_build_object('question', v_q, 'options', v_labels));
  return v_id;
end $$;

create or replace function public.admin_set_poll_status(p_poll uuid, p_status text)
returns void
language plpgsql security definer set search_path = public as $$
declare v public.polls;
begin
  perform public._require_admin();
  if p_status not in ('draft','active','closed') then raise exception 'Unknown poll status.'; end if;
  select * into v from public.polls where id = p_poll for update;
  if not found then raise exception 'Poll not found.'; end if;
  if p_status = 'draft' and exists (select 1 from public.votes where poll_id = p_poll) then
    raise exception 'A poll that already has votes cannot go back to draft.';
  end if;
  if p_status = 'active' and (select count(*) from public.poll_options where poll_id = p_poll) < 2 then
    raise exception 'Add at least two options before publishing.';
  end if;
  update public.polls set status = p_status,
    -- reopening a poll whose closing time has passed clears that time
    closes_at = case when p_status = 'active' and closes_at is not null and closes_at <= now() then null else closes_at end
  where id = p_poll;
  perform public._log(case p_status when 'active' then (case when v.status = 'closed' then 'poll_reopened' else 'poll_published' end)
                                    when 'closed' then 'poll_closed' else 'poll_unpublished' end,
                      'poll', p_poll::text, null, jsonb_build_object('question', v.question, 'from', v.status, 'to', p_status));
end $$;

create or replace function public.admin_delete_poll(p_poll uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v public.polls; n bigint;
begin
  perform public._require_admin();
  select * into v from public.polls where id = p_poll;
  if not found then raise exception 'Poll not found.'; end if;
  select count(*) into n from public.votes where poll_id = p_poll;
  perform public._log('poll_deleted', 'poll', p_poll::text, null,
    jsonb_build_object('question', v.question, 'status', v.status, 'votes', n,
      'results', (select jsonb_object_agg(o.label, (select count(*) from public.votes x where x.option_id = o.id))
                  from public.poll_options o where o.poll_id = p_poll)));
  delete from public.polls where id = p_poll;
end $$;

-- ---------------------------------------------------------------------
-- ADMIN: comments
-- ---------------------------------------------------------------------
create or replace function public.admin_list_comments(p_status text default null, p_limit int default 100)
returns table (id bigint, body text, status text, created_at timestamptz, edited_at timestamptz,
               event_id uuid, event_title text, author_id uuid, author_name text, author_email text,
               author_status text, moderated_at timestamptz, moderator_name text, moderation_reason text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_admin();
  return query
  select c.id, c.body, c.status, c.created_at, c.edited_at, c.event_id, e.title,
         c.user_id, p.full_name, p.email, p.membership_status, c.moderated_at, m.full_name, c.moderation_reason
  from public.comments c
  join public.profiles p on p.id = c.user_id
  join public.events e on e.id = c.event_id
  left join public.profiles m on m.id = c.moderated_by
  where p_status is null or c.status = p_status
  order by c.created_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
end $$;

create or replace function public.admin_moderate_comment(p_id bigint, p_action text, p_reason text default null)
returns public.comments
language plpgsql security definer set search_path = public as $$
declare v public.comments; v_new text;
begin
  perform public._require_admin();
  select * into v from public.comments where id = p_id for update;
  if not found then raise exception 'Comment not found.'; end if;
  v_new := case p_action
    when 'approve' then 'visible'
    when 'restore' then 'visible'
    when 'hide'    then 'hidden'
    when 'remove'  then 'removed'
    else null end;
  if v_new is null then raise exception 'Unknown moderation action.'; end if;
  if p_action = 'approve' and v.status <> 'pending' then raise exception 'Only pending comments can be approved.'; end if;
  if p_action = 'restore' and v.status not in ('hidden','removed','deleted') then
    raise exception 'Only hidden or removed comments can be restored.';
  end if;
  update public.comments set status = v_new, moderated_at = now(), moderated_by = auth.uid(),
    moderation_reason = left(public._clean_text(p_reason), 300)
  where id = p_id returning * into v;
  perform public._log('comment_' || case p_action when 'approve' then 'approved' when 'restore' then 'restored'
                                               when 'hide' then 'hidden' else 'removed' end,
                      'comment', p_id::text, p_reason,
                      jsonb_build_object('body', left(v.body, 200), 'author', v.user_id, 'event', v.event_id));
  return v;
end $$;

create or replace function public.admin_set_comment_premoderation(p_on boolean)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin();
  update public.club_settings set comment_premoderation = p_on, updated_at = now(), updated_by = auth.uid() where id = 1;
  perform public._log(case when p_on then 'premoderation_on' else 'premoderation_off' end, 'settings', 'comment_premoderation');
end $$;

-- ---------------------------------------------------------------------
-- ADMIN: events
-- ---------------------------------------------------------------------
create or replace function public.admin_save_event(p_id uuid, p_title text, p_starts_at timestamptz, p_ends_at timestamptz,
                                                   p_venue text, p_description text, p_image_url text,
                                                   p_category text, p_status text default 'scheduled')
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := p_id; v_old public.events; v_title text := public._clean_text(replace(p_title, E'\n', ' '));
        v_img text := public._clean_text(p_image_url);
begin
  perform public._require_admin();
  if v_title is null or char_length(v_title) < 2 then raise exception 'Give the event a title.'; end if;
  if p_starts_at is null then raise exception 'Give the event a start date and time.'; end if;
  if p_ends_at is not null and p_ends_at < p_starts_at then raise exception 'The event cannot end before it starts.'; end if;
  if v_img is not null and v_img !~* '^https://' then raise exception 'The image link must start with https://'; end if;
  if coalesce(p_status, 'scheduled') not in ('scheduled','postponed','cancelled','completed','hidden') then
    raise exception 'Unknown event status.';
  end if;

  if v_id is null then
    insert into public.events (source, title, starts_at, ends_at, venue, description, image_url, category, status, created_by, updated_by)
    values ('manual', v_title, p_starts_at, p_ends_at, public._clean_text(p_venue), public._clean_text(p_description),
            v_img, upper(public._clean_text(p_category)), coalesce(p_status, 'scheduled'), auth.uid(), auth.uid())
    returning id into v_id;
    perform public._log('event_created', 'event', v_id::text, null, jsonb_build_object('title', v_title, 'starts_at', p_starts_at));
  else
    select * into v_old from public.events where id = v_id for update;
    if not found then raise exception 'Event not found.'; end if;
    update public.events set title = v_title, starts_at = p_starts_at, ends_at = p_ends_at,
      venue = public._clean_text(p_venue), description = public._clean_text(p_description), image_url = v_img,
      category = upper(public._clean_text(p_category)), status = coalesce(p_status, 'scheduled'),
      manual_override = (source = 'drive') or manual_override, updated_by = auth.uid()
    where id = v_id;
    perform public._log('event_edited', 'event', v_id::text, null,
      jsonb_build_object('title', v_title, 'source', v_old.source,
                         'before', jsonb_build_object('title', v_old.title, 'starts_at', v_old.starts_at, 'status', v_old.status)));
  end if;
  return v_id;
end $$;

create or replace function public.admin_delete_event(p_id uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare v public.events;
begin
  perform public._require_admin();
  select * into v from public.events where id = p_id for update;
  if not found then raise exception 'Event not found.'; end if;
  if v.source = 'drive' then
    -- a Drive event would come back on the next sync, so hide it and stop syncing it instead
    update public.events set status = 'hidden', manual_override = true, updated_by = auth.uid() where id = p_id;
    perform public._log('event_hidden', 'event', p_id::text, 'Drive event removed by admin', jsonb_build_object('title', v.title));
    return 'hidden';
  end if;
  perform public._log('event_deleted', 'event', p_id::text, null, jsonb_build_object('title', v.title, 'starts_at', v.starts_at));
  delete from public.events where id = p_id;
  return 'deleted';
end $$;

-- Hand an edited Drive event back to the sync (its sheet row wins again on the next run).
create or replace function public.admin_release_event_override(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v public.events;
begin
  perform public._require_admin();
  select * into v from public.events where id = p_id for update;
  if not found or v.source <> 'drive' then raise exception 'Only Drive events can be handed back to the sync.'; end if;
  update public.events set manual_override = false, content_hash = null where id = p_id;
  perform public._log('event_override_released', 'event', p_id::text, null, jsonb_build_object('title', v.title));
end $$;

-- ---------------------------------------------------------------------
-- ADMIN: audit log with names
-- ---------------------------------------------------------------------
create or replace function public.admin_list_log(p_target_type text default null, p_target_id text default null, p_limit int default 100)
returns table (id bigint, created_at timestamptz, action text, target_type text, target_id text,
               reason text, details jsonb, actor_name text, actor_email text, target_name text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_admin();
  return query
  select l.id, l.created_at, l.action, l.target_type, l.target_id, l.reason, l.details,
         a.full_name, a.email,
         case when l.target_type = 'member' then (select coalesce(t.full_name, t.email) from public.profiles t where t.id::text = l.target_id) end
  from public.moderation_log l
  left join public.profiles a on a.id = l.actor_id
  where (p_target_type is null or l.target_type = p_target_type)
    and (p_target_id is null or l.target_id = p_target_id)
  order by l.created_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
end $$;

-- ---------------------------------------------------------------------
-- Who may call what.
-- Postgres lets everyone execute new functions by default, so start by
-- taking that away, then grant exactly what the website needs.
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

-- readable by visitors who are not signed in
grant execute on function public.get_polls(boolean)             to anon, authenticated;
grant execute on function public.list_event_comments(uuid)      to anon, authenticated;
grant execute on function public.event_comment_counts()         to anon, authenticated;
grant execute on function public.is_admin()                     to anon, authenticated;
grant execute on function public.is_approved_member()           to anon, authenticated;

-- signed-in users (each function checks membership status itself)
grant execute on function public.submit_membership(text, text, text) to authenticated;
grant execute on function public.cast_vote(uuid, uuid)               to authenticated;
grant execute on function public.post_comment(uuid, text)            to authenticated;
grant execute on function public.edit_my_comment(bigint, text)       to authenticated;
grant execute on function public.delete_my_comment(bigint)           to authenticated;

-- admin functions (each checks is_admin() itself)
grant execute on function public.admin_overview()                                  to authenticated;
grant execute on function public.admin_review_member(uuid, boolean, text)          to authenticated;
grant execute on function public.admin_bulk_approve(uuid[])                        to authenticated;
grant execute on function public.admin_suspend_member(uuid, text)                  to authenticated;
grant execute on function public.admin_restore_member(uuid, text)                  to authenticated;
grant execute on function public.admin_set_admin(uuid, boolean)                    to authenticated;
grant execute on function public.admin_save_poll(uuid, text, text, timestamptz, timestamptz, jsonb) to authenticated;
grant execute on function public.admin_set_poll_status(uuid, text)                 to authenticated;
grant execute on function public.admin_delete_poll(uuid)                           to authenticated;
grant execute on function public.admin_list_comments(text, int)                    to authenticated;
grant execute on function public.admin_moderate_comment(bigint, text, text)        to authenticated;
grant execute on function public.admin_set_comment_premoderation(boolean)          to authenticated;
grant execute on function public.admin_save_event(uuid, text, timestamptz, timestamptz, text, text, text, text, text) to authenticated;
grant execute on function public.admin_delete_event(uuid)                          to authenticated;
grant execute on function public.admin_release_event_override(uuid)               to authenticated;
grant execute on function public.admin_list_log(text, text, int)                   to authenticated;


-- ===================== 20261103000004_event_sync.sql =====================
-- =====================================================================
-- Google Drive -> events sync.
-- Called only by the Vercel function /api/sync-events with the service
-- role key. The website's roles cannot run it.
--
-- p_rows: [{ "external_id", "title", "starts_at", "ends_at", "venue",
--            "description", "image_url", "category", "status", "hash" }]
--
-- Behaviour
--   * new sheet rows are inserted, changed rows updated (by external_id)
--   * events an admin edited (manual_override) are left alone
--   * manually created events are never touched
--   * Drive events missing from the sheet are hidden, not deleted
--   * everything happens in one transaction: if anything fails, the
--     events table keeps its last good state
-- =====================================================================
create or replace function public.apply_event_sync(p_log_id bigint, p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r          jsonb;
  v_existing public.events;
  v_ids      text[] := '{}';
  n_ins int := 0; n_upd int := 0; n_same int := 0; n_kept int := 0; n_hidden int := 0;
  v_result   jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtext('simats_event_sync')) then
    raise exception 'Another event sync is already running.';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    -- an empty sheet is treated as a failure so a broken import never wipes the events
    raise exception 'The Drive source returned no valid events; keeping the current events.';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_ids := v_ids || (r ->> 'external_id');
    select * into v_existing from public.events where source = 'drive' and external_id = r ->> 'external_id' for update;
    if not found then
      insert into public.events (source, external_id, title, starts_at, ends_at, venue, description,
                                 image_url, category, status, content_hash, last_synced_at)
      values ('drive', r ->> 'external_id', r ->> 'title', (r ->> 'starts_at')::timestamptz,
              nullif(r ->> 'ends_at', '')::timestamptz, nullif(r ->> 'venue', ''), nullif(r ->> 'description', ''),
              nullif(r ->> 'image_url', ''), nullif(r ->> 'category', ''), coalesce(nullif(r ->> 'status', ''), 'scheduled'),
              r ->> 'hash', now());
      n_ins := n_ins + 1;
    elsif v_existing.manual_override then
      n_kept := n_kept + 1;
    elsif v_existing.content_hash is not distinct from (r ->> 'hash') then
      update public.events set last_synced_at = now() where id = v_existing.id;
      n_same := n_same + 1;
    else
      update public.events set
        title = r ->> 'title', starts_at = (r ->> 'starts_at')::timestamptz,
        ends_at = nullif(r ->> 'ends_at', '')::timestamptz, venue = nullif(r ->> 'venue', ''),
        description = nullif(r ->> 'description', ''), image_url = nullif(r ->> 'image_url', ''),
        category = nullif(r ->> 'category', ''), status = coalesce(nullif(r ->> 'status', ''), 'scheduled'),
        content_hash = r ->> 'hash', last_synced_at = now()
      where id = v_existing.id;
      n_upd := n_upd + 1;
    end if;
  end loop;

  with gone as (
    update public.events set status = 'hidden', last_synced_at = now()
    where source = 'drive' and not manual_override and status <> 'hidden'
      and not (external_id = any (v_ids))
    returning 1)
  select count(*) into n_hidden from gone;

  v_result := jsonb_build_object('inserted', n_ins, 'updated', n_upd, 'unchanged', n_same,
                                 'kept_admin_edits', n_kept, 'hidden', n_hidden);
  update public.event_sync_logs set
    status = 'success', finished_at = now(), inserted = n_ins, updated = n_upd,
    unchanged = n_same + n_kept, hidden = n_hidden,
    details = details || v_result
  where id = p_log_id;
  return v_result;
end $$;

revoke execute on function public.apply_event_sync(bigint, jsonb) from public, anon, authenticated;
-- service_role is Supabase's server-only role; it keeps execute.
grant execute on function public.apply_event_sync(bigint, jsonb) to service_role;


-- ===================== 20261103000005_admin_promotion.sql =====================
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



-- ===================== 20261105000006_positions_notices.sql =====================
-- =====================================================================
-- SIMATS Anime Club — office bearers, notices and meeting cancellation
--   * profiles.office: President / Vice President / Secretary / Treasurer
--     (one holder each, assigned by admins only)
--   * notices: club-wide messages for approved members, with a "seen" marker
--     for the bell icon, and cancellation notices linked to an event
--   * cancelling a meeting needs a reason, takes it off the calendar,
--     keeps the sync from bringing it back and posts a notice
-- Safe to run more than once.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------
alter table public.profiles add column if not exists office text;
alter table public.profiles drop constraint if exists profiles_position_check;
alter table public.profiles add constraint profiles_position_check
  check (office is null or office in ('president','vice_president','secretary','treasurer'));
create unique index if not exists profiles_one_holder_per_position on public.profiles (office) where office is not null;
alter table public.profiles add column if not exists notices_seen_at timestamptz;

alter table public.events add column if not exists cancel_reason text;
alter table public.events drop constraint if exists events_cancel_reason_check;
alter table public.events add constraint events_cancel_reason_check
  check (cancel_reason is null or char_length(cancel_reason) <= 500);
alter table public.events add column if not exists cancelled_at timestamptz;
alter table public.events add column if not exists cancelled_by uuid references public.profiles (id) on delete set null;

alter table public.moderation_log drop constraint if exists moderation_log_target_type_check;
alter table public.moderation_log add constraint moderation_log_target_type_check
  check (target_type in ('member','comment','poll','event','settings','sync','notice'));

-- ---------------------------------------------------------------------
-- Notices
-- ---------------------------------------------------------------------
create table if not exists public.notices (
  id           bigint generated always as identity primary key,
  kind         text not null default 'notice' check (kind in ('notice','cancellation')),
  title        text not null check (char_length(btrim(title)) between 3 and 120),
  body         text not null check (char_length(btrim(body)) between 3 and 4000),
  event_id     uuid references public.events (id) on delete set null,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  deleted_by   uuid references public.profiles (id) on delete set null,
  emailed_at   timestamptz,                -- claimed by /api/notify-members so each notice is emailed once
  email_count  int,
  email_error  text
);
create index if not exists notices_recent on public.notices (created_at desc) where deleted_at is null;

alter table public.notices enable row level security;
revoke all on public.notices from anon;
revoke insert, update, delete on public.notices from authenticated;
drop policy if exists "admins read notices" on public.notices;
create policy "admins read notices" on public.notices for select to authenticated using (public.is_admin());
-- members read notices through list_notices(), which checks they are approved

-- ---------------------------------------------------------------------
-- Members: notices and the bell
-- ---------------------------------------------------------------------
create or replace function public.list_notices(p_limit int default 50)
returns table (id bigint, kind text, title text, body text, event_id uuid, created_at timestamptz,
               author_name text, author_position text, is_new boolean)
language plpgsql stable security definer set search_path = public as $$
declare v_seen timestamptz;
begin
  perform public._require_member();
  select notices_seen_at into v_seen from public.profiles where profiles.id = auth.uid();
  return query
    select n.id, n.kind, n.title, n.body, n.event_id, n.created_at,
           coalesce(p.full_name, 'Club admin'), p.office,
           n.created_at > coalesce(v_seen, '-infinity'::timestamptz)
    from public.notices n
    left join public.profiles p on p.id = n.created_by
    where n.deleted_at is null
    order by n.created_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200);
end $$;

-- 0 for anyone who is not an approved member, so the bell can ask safely
create or replace function public.notice_unread_count() returns int
language sql stable security definer set search_path = public as $$
  select case when public.is_approved_member() then (
    select count(*)::int from public.notices n
    where n.deleted_at is null
      and n.created_at > coalesce((select notices_seen_at from public.profiles where id = auth.uid()), '-infinity'::timestamptz))
  else 0 end
$$;

create or replace function public.mark_notices_seen() returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_member();
  update public.profiles set notices_seen_at = now() where id = auth.uid();
end $$;

-- Office bearers, for everyone (names and titles only; no emails)
create or replace function public.list_office_bearers()
returns table (office text, full_name text, avatar_url text)
language sql stable security definer set search_path = public as $$
  select p.office, coalesce(p.full_name, p.google_name, 'Member'), p.avatar_url
  from public.profiles p
  where p.office is not null and p.membership_status = 'approved'
  order by array_position(array['president','vice_president','secretary','treasurer'], p.office)
$$;

-- Comments now carry the author's office-bearer title
drop function if exists public.list_event_comments(uuid);
create function public.list_event_comments(p_event uuid)
returns table (id bigint, body text, status text, created_at timestamptz, edited_at timestamptz,
               author_name text, author_avatar text, is_mine boolean, moderation_reason text, author_position text)
language sql stable security definer set search_path = public as $$
  select c.id, c.body, c.status, c.created_at, c.edited_at,
         coalesce(p.full_name, 'Member'), p.avatar_url,
         c.user_id = auth.uid(),
         case when c.user_id = auth.uid() then c.moderation_reason end,
         case when p.membership_status = 'approved' then p.office end
  from public.comments c
  join public.profiles p on p.id = c.user_id
  join public.events e on e.id = c.event_id and e.status <> 'hidden'
  where c.event_id = p_event
    and (c.status = 'visible' or (c.user_id = auth.uid() and c.status <> 'deleted'))
  order by c.created_at
  limit 300
$$;

-- ---------------------------------------------------------------------
-- Admins: positions
-- ---------------------------------------------------------------------
create or replace function public.admin_set_position(p_user uuid, p_position text)
returns public.profiles
language plpgsql security definer set search_path = public as $$
declare
  v      public.profiles;
  v_prev public.profiles;
  v_pos  text := nullif(lower(btrim(coalesce(p_position, ''))), '');
  v_old  text;
begin
  perform public._require_admin();
  if v_pos is not null and v_pos not in ('president','vice_president','secretary','treasurer') then
    raise exception 'Unknown office-bearer title.';
  end if;
  select * into v from public.profiles where id = p_user for update;
  if not found then raise exception 'Member not found.'; end if;
  if v_pos is not null and v.membership_status <> 'approved' then
    raise exception 'Only approved members can hold an office-bearer title.';
  end if;
  v_old := v.office;
  if v_old is not distinct from v_pos then return v; end if;

  -- one holder per office: take it from whoever has it now
  if v_pos is not null then
    select * into v_prev from public.profiles where office = v_pos and id <> p_user for update;
    if found then
      update public.profiles set office = null where id = v_prev.id;
      perform public._log('position_removed', 'member', v_prev.id::text,
        'Given to ' || coalesce(v.full_name, v.email),
        jsonb_build_object('name', v_prev.full_name, 'position', v_pos));
    end if;
  end if;

  update public.profiles set office = v_pos where id = p_user returning * into v;
  perform public._log(case when v_pos is null then 'position_removed' else 'position_assigned' end,
    'member', p_user::text, null,
    jsonb_build_object('name', v.full_name, 'position', coalesce(v_pos, v_old), 'previous', v_old));
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Admins: notices
-- ---------------------------------------------------------------------
create or replace function public.admin_post_notice(p_title text, p_body text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id    bigint;
  v_title text := public._clean_text(replace(coalesce(p_title, ''), E'\n', ' '));
  v_body  text := public._clean_text(p_body);
begin
  perform public._require_admin();
  if v_title is null or char_length(v_title) < 3 then raise exception 'Give the notice a title (at least 3 characters).'; end if;
  if char_length(v_title) > 120 then raise exception 'Keep the title under 120 characters.'; end if;
  if v_body is null or char_length(v_body) < 3 then raise exception 'Write the notice message.'; end if;
  if char_length(v_body) > 4000 then raise exception 'Keep the message under 4000 characters.'; end if;
  insert into public.notices (kind, title, body, created_by)
  values ('notice', v_title, v_body, auth.uid()) returning id into v_id;
  perform public._log('notice_posted', 'notice', v_id::text, null, jsonb_build_object('title', v_title));
  return v_id;
end $$;

create or replace function public.admin_delete_notice(p_id bigint, p_reason text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare v public.notices;
begin
  perform public._require_admin();
  select * into v from public.notices where id = p_id for update;
  if not found or v.deleted_at is not null then raise exception 'Notice not found.'; end if;
  update public.notices set deleted_at = now(), deleted_by = auth.uid() where id = p_id;
  perform public._log('notice_deleted', 'notice', p_id::text, p_reason, jsonb_build_object('title', v.title));
end $$;

create or replace function public.admin_list_notices(p_limit int default 100)
returns table (id bigint, kind text, title text, body text, event_id uuid, created_at timestamptz,
               author_name text, deleted_at timestamptz, emailed_at timestamptz, email_count int, email_error text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_admin();
  return query
    select n.id, n.kind, n.title, n.body, n.event_id, n.created_at, coalesce(p.full_name, 'Club admin'),
           n.deleted_at, n.emailed_at, n.email_count, n.email_error
    from public.notices n left join public.profiles p on p.id = n.created_by
    order by n.created_at desc
    limit least(greatest(coalesce(p_limit, 100), 1), 500);
end $$;

-- ---------------------------------------------------------------------
-- Admins: cancel a meeting (reason required)
-- ---------------------------------------------------------------------
create or replace function public.admin_cancel_event(p_id uuid, p_reason text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v        public.events;
  v_reason text := public._clean_text(p_reason);
  v_local  timestamp;
  v_when   text;
  v_nid    bigint;
begin
  perform public._require_admin();
  if v_reason is null or char_length(v_reason) < 5 then
    raise exception 'Say why the meeting is cancelled (at least 5 characters).';
  end if;
  if char_length(v_reason) > 500 then raise exception 'Keep the reason under 500 characters.'; end if;
  select * into v from public.events where id = p_id for update;
  if not found then raise exception 'Event not found.'; end if;
  if v.status = 'cancelled' then raise exception 'This meeting is already cancelled.'; end if;
  if v.status = 'hidden' then raise exception 'This event is hidden, so there is nothing to cancel.'; end if;

  update public.events set status = 'cancelled', cancel_reason = v_reason, cancelled_at = now(), cancelled_by = auth.uid(),
    manual_override = (source = 'drive') or manual_override,   -- the weekly sync must not bring it back
    updated_by = auth.uid()
  where id = p_id;

  v_local := v.starts_at at time zone 'Asia/Kolkata';
  v_when := to_char(v_local, 'FMDay, FMDD Mon YYYY')
            || case when v_local::time = '00:00' then '' else ', ' || to_char(v_local, 'FMHH12:MI AM') end;
  insert into public.notices (kind, title, body, event_id, created_by)
  values ('cancellation',
          left('Cancelled: ' || v.title, 120),
          'The meeting "' || v.title || '" on ' || v_when || coalesce(' at ' || v.venue, '') || ' is cancelled.'
            || E'\n\nReason: ' || v_reason,
          p_id, auth.uid())
  returning id into v_nid;

  perform public._log('event_cancelled', 'event', p_id::text, v_reason,
    jsonb_build_object('title', v.title, 'starts_at', v.starts_at, 'notice_id', v_nid));
  return v_nid;
end $$;

-- Editing an event can no longer cancel it without a reason; un-cancelling clears the reason.
create or replace function public.admin_save_event(p_id uuid, p_title text, p_starts_at timestamptz, p_ends_at timestamptz,
                                                   p_venue text, p_description text, p_image_url text,
                                                   p_category text, p_status text default 'scheduled')
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := p_id; v_old public.events; v_title text := public._clean_text(replace(p_title, E'\n', ' '));
        v_img text := public._clean_text(p_image_url); v_status text := coalesce(p_status, 'scheduled');
begin
  perform public._require_admin();
  if v_title is null or char_length(v_title) < 2 then raise exception 'Give the event a title.'; end if;
  if p_starts_at is null then raise exception 'Give the event a start date and time.'; end if;
  if p_ends_at is not null and p_ends_at < p_starts_at then raise exception 'The event cannot end before it starts.'; end if;
  if v_img is not null and v_img !~* '^https://' then raise exception 'The image link must start with https://'; end if;
  if v_status not in ('scheduled','postponed','cancelled','completed','hidden') then
    raise exception 'Unknown event status.';
  end if;
  if v_id is not null then
    select * into v_old from public.events where id = v_id for update;
    if not found then raise exception 'Event not found.'; end if;
  end if;
  if v_status = 'cancelled' and (v_id is null or v_old.status <> 'cancelled') then
    raise exception 'To cancel a meeting, use the Cancel meeting button so members get the reason.';
  end if;

  if v_id is null then
    insert into public.events (source, title, starts_at, ends_at, venue, description, image_url, category, status, created_by, updated_by)
    values ('manual', v_title, p_starts_at, p_ends_at, public._clean_text(p_venue), public._clean_text(p_description),
            v_img, upper(public._clean_text(p_category)), v_status, auth.uid(), auth.uid())
    returning id into v_id;
    perform public._log('event_created', 'event', v_id::text, null, jsonb_build_object('title', v_title, 'starts_at', p_starts_at));
  else
    update public.events set title = v_title, starts_at = p_starts_at, ends_at = p_ends_at,
      venue = public._clean_text(p_venue), description = public._clean_text(p_description), image_url = v_img,
      category = upper(public._clean_text(p_category)), status = v_status,
      cancel_reason = case when v_status = 'cancelled' then cancel_reason end,
      cancelled_at  = case when v_status = 'cancelled' then cancelled_at end,
      cancelled_by  = case when v_status = 'cancelled' then cancelled_by end,
      manual_override = (source = 'drive') or manual_override, updated_by = auth.uid()
    where id = v_id;
    perform public._log(case when v_old.status = 'cancelled' and v_status <> 'cancelled' then 'event_uncancelled' else 'event_edited' end,
      'event', v_id::text, null,
      jsonb_build_object('title', v_title, 'source', v_old.source,
                         'before', jsonb_build_object('title', v_old.title, 'starts_at', v_old.starts_at, 'status', v_old.status)));
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Who may call what (Supabase grants new functions to everyone by default)
-- ---------------------------------------------------------------------
revoke execute on function public.list_notices(int)                    from public, anon, authenticated;
revoke execute on function public.notice_unread_count()                from public, anon, authenticated;
revoke execute on function public.mark_notices_seen()                  from public, anon, authenticated;
revoke execute on function public.list_office_bearers()                from public, anon, authenticated;
revoke execute on function public.list_event_comments(uuid)            from public, anon, authenticated;
revoke execute on function public.admin_set_position(uuid, text)       from public, anon, authenticated;
revoke execute on function public.admin_post_notice(text, text)        from public, anon, authenticated;
revoke execute on function public.admin_delete_notice(bigint, text)    from public, anon, authenticated;
revoke execute on function public.admin_list_notices(int)              from public, anon, authenticated;
revoke execute on function public.admin_cancel_event(uuid, text)       from public, anon, authenticated;

grant execute on function public.list_office_bearers()                 to anon, authenticated;
grant execute on function public.list_event_comments(uuid)             to anon, authenticated;
grant execute on function public.list_notices(int)                     to authenticated;
grant execute on function public.notice_unread_count()                 to authenticated;
grant execute on function public.mark_notices_seen()                   to authenticated;
grant execute on function public.admin_set_position(uuid, text)        to authenticated;
grant execute on function public.admin_post_notice(text, text)         to authenticated;
grant execute on function public.admin_delete_notice(bigint, text)     to authenticated;
grant execute on function public.admin_list_notices(int)               to authenticated;
grant execute on function public.admin_cancel_event(uuid, text)        to authenticated;

select 'SIMATS Anime Club database is ready. Sign in as animeclubsimats@gmail.com to become admin.' as result;
