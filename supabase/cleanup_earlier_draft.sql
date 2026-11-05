-- =====================================================================
-- ONLY run this if you already pasted the early draft SQL from chat
-- (tables profiles, polls, poll_options, poll_votes, comments and the
-- is_admin / handle_new_user functions) into the Supabase SQL editor.
-- It removes those draft objects so the real migrations can run.
-- The draft tables held test data only. Signed-in users (auth.users) are kept.
-- =====================================================================
drop trigger if exists on_auth_user_created on auth.users;
drop table if exists public.poll_votes cascade;
drop table if exists public.poll_options cascade;
drop table if exists public.polls cascade;
drop table if exists public.comments cascade;
drop table if exists public.profiles cascade;
drop function if exists public.handle_new_user() cascade;
drop function if exists public.is_admin() cascade;
drop function if exists public.is_approved_member() cascade;
