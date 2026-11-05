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
