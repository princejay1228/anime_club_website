-- =====================================================================
-- SIMATS Anime Club — "Recent meets" gallery from Google Drive
--   * gallery_items: photos and videos listed from the club's Drive
--     folder(s); the home page shows the ones that are not hidden
--   * drive_connection: the club Google account's Drive authorisation for
--     uploads from the admin dashboard. The token is stored AES-256-GCM
--     encrypted by the server; the website roles cannot read this table.
-- Safe to run more than once.
-- =====================================================================

alter table public.moderation_log drop constraint if exists moderation_log_target_type_check;
alter table public.moderation_log add constraint moderation_log_target_type_check
  check (target_type in ('member','comment','poll','event','settings','sync','notice','gallery'));

create table if not exists public.gallery_items (
  id            uuid primary key default gen_random_uuid(),
  drive_id      text not null unique check (drive_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  folder_id     text check (folder_id is null or folder_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  name          text check (name is null or char_length(name) <= 300),
  kind          text not null check (kind in ('photo','video')),
  mime_type     text check (mime_type is null or char_length(mime_type) <= 100),
  width         int,
  height        int,
  sort_time     timestamptz not null default now(),   -- when the photo was taken (or uploaded)
  hidden        boolean not null default false,
  last_seen_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index if not exists gallery_items_shown on public.gallery_items (sort_time desc) where not hidden;

alter table public.gallery_items enable row level security;
revoke insert, update, delete on public.gallery_items from anon, authenticated;
drop policy if exists "public gallery" on public.gallery_items;
create policy "public gallery" on public.gallery_items for select to anon, authenticated using (not hidden);
drop policy if exists "admins read gallery" on public.gallery_items;
create policy "admins read gallery" on public.gallery_items for select to authenticated using (public.is_admin());

create table if not exists public.drive_connection (
  id                 int primary key default 1 check (id = 1),
  refresh_token_enc  text not null,                    -- encrypted by the server, never readable from the website
  account_email      text,
  upload_folder_id   text,
  connected_by       uuid references public.profiles (id) on delete set null,
  connected_at       timestamptz not null default now()
);
alter table public.drive_connection enable row level security;
revoke all on public.drive_connection from anon, authenticated;
-- no policies: only the server (service role) uses it

-- ---------------------------------------------------------------------
-- Server only: replace the gallery list with what is in the Drive folders now.
-- p_items: [{"drive_id","folder_id","name","kind","mime_type","width","height","sort_time"}]
-- Files that disappeared from the listed folders are removed; admin "hidden" choices are kept.
-- ---------------------------------------------------------------------
create or replace function public.apply_gallery_sync(p_items jsonb, p_folders text[])
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_added int := 0; v_updated int := 0; v_removed int := 0; v_item jsonb; v_id text; v_new boolean;
begin
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then raise exception 'Items must be a list.'; end if;
  perform pg_advisory_xact_lock(hashtext('gallery_sync'));
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_id := v_item ->> 'drive_id';
    if v_id is null or v_id !~ '^[A-Za-z0-9_-]{10,200}$' or (v_item ->> 'kind') not in ('photo','video') then continue; end if;
    select not exists (select 1 from public.gallery_items where drive_id = v_id) into v_new;
    insert into public.gallery_items (drive_id, folder_id, name, kind, mime_type, width, height, sort_time, last_seen_at)
    values (v_id, v_item ->> 'folder_id', left(v_item ->> 'name', 300), v_item ->> 'kind', left(v_item ->> 'mime_type', 100),
            nullif(v_item ->> 'width', '')::int, nullif(v_item ->> 'height', '')::int,
            coalesce(nullif(v_item ->> 'sort_time', '')::timestamptz, now()), now())
    on conflict (drive_id) do update set folder_id = excluded.folder_id, name = excluded.name, kind = excluded.kind,
      mime_type = excluded.mime_type, width = excluded.width, height = excluded.height, sort_time = excluded.sort_time,
      last_seen_at = now();
    if v_new then v_added := v_added + 1; else v_updated := v_updated + 1; end if;
  end loop;
  delete from public.gallery_items g
  where g.folder_id = any(coalesce(p_folders, '{}'))
    and not exists (select 1 from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x where x ->> 'drive_id' = g.drive_id);
  get diagnostics v_removed = row_count;
  return jsonb_build_object('added', v_added, 'updated', v_updated, 'removed', v_removed,
                            'total', (select count(*) from public.gallery_items));
end $$;

create or replace function public.admin_set_gallery_hidden(p_id uuid, p_hidden boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare v public.gallery_items;
begin
  perform public._require_admin();
  select * into v from public.gallery_items where id = p_id for update;
  if not found then raise exception 'Gallery item not found.'; end if;
  update public.gallery_items set hidden = coalesce(p_hidden, false) where id = p_id;
  perform public._log(case when p_hidden then 'gallery_hidden' else 'gallery_shown' end, 'gallery', p_id::text, null,
                      jsonb_build_object('name', v.name, 'kind', v.kind));
end $$;

revoke execute on function public.apply_gallery_sync(jsonb, text[])      from public, anon, authenticated;
revoke execute on function public.admin_set_gallery_hidden(uuid, boolean) from public, anon, authenticated;
grant execute on function public.apply_gallery_sync(jsonb, text[])       to service_role;
grant execute on function public.admin_set_gallery_hidden(uuid, boolean)  to authenticated;
