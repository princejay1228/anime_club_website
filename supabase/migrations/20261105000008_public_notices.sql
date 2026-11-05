-- =====================================================================
-- SIMATS Anime Club — notices are public
-- Everyone (visitors too) can read club notices; the "new" marker still
-- comes from the database for approved members (any device), and from the
-- visitor's own browser otherwise. Emails still go to approved members only.
-- Safe to run more than once.
-- =====================================================================
create or replace function public.list_notices(p_limit int default 50)
returns table (id bigint, kind text, title text, body text, event_id uuid, created_at timestamptz,
               author_name text, author_position text, is_new boolean)
language plpgsql stable security definer set search_path = public as $$
declare
  v_member boolean := public.is_approved_member();
  v_seen   timestamptz;
begin
  if v_member then
    select notices_seen_at into v_seen from public.profiles where profiles.id = auth.uid();
  end if;
  return query
    select n.id, n.kind, n.title, n.body, n.event_id, n.created_at,
           coalesce(p.full_name, 'Club admin'), p.office,
           v_member and n.created_at > coalesce(v_seen, '-infinity'::timestamptz)
    from public.notices n
    left join public.profiles p on p.id = n.created_by
    where n.deleted_at is null
    order by n.created_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200);
end $$;

revoke execute on function public.list_notices(int) from public, anon, authenticated;
grant execute on function public.list_notices(int) to anon, authenticated;
