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
