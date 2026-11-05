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
