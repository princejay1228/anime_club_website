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
