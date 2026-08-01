drop function if exists public.telegram_login_status(text);
create or replace function public.telegram_login_status(_start_token text)
returns table (status text, has_code boolean, expires_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select r.status, (r.code_hash is not null) as has_code, r.expires_at
  from public.telegram_login_requests r
  where r.start_token = _start_token
    and length(_start_token) >= 16
  limit 1
$$;
revoke all on function public.telegram_login_status(text) from public;
grant execute on function public.telegram_login_status(text) to anon, authenticated, service_role;