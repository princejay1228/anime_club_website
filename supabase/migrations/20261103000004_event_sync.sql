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
