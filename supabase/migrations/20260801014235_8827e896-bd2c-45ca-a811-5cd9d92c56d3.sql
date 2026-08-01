-- 1. Relax conflicting uniqueness so upsert/update always succeed
alter table public.telegram_accounts drop constraint if exists telegram_accounts_phone_key;
create index if not exists telegram_accounts_phone_idx on public.telegram_accounts(phone);

-- 2. Status + strict chat binding on login requests
alter table public.telegram_login_requests
  add column if not exists status text not null default 'pending',
  add column if not exists claimed_chat_id bigint,
  add column if not exists updated_at timestamptz not null default now();

alter table public.telegram_login_requests
  drop constraint if exists telegram_login_requests_status_check;
alter table public.telegram_login_requests
  add constraint telegram_login_requests_status_check
  check (status in ('pending','code_sent','verified','consumed','expired','rejected'));

create index if not exists tg_login_phone_status_idx
  on public.telegram_login_requests(phone, status, created_at desc);

drop trigger if exists trg_tg_login_updated on public.telegram_login_requests;
create trigger trg_tg_login_updated before update on public.telegram_login_requests
  for each row execute function public.set_updated_at();

-- 3. Secure status lookup for the waiting screen (no table access granted)
create or replace function public.telegram_login_status(_start_token text)
returns table (status text, has_code boolean, telegram_first_name text, expires_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select r.status,
         (r.code_hash is not null) as has_code,
         r.telegram_first_name,
         r.expires_at
  from public.telegram_login_requests r
  where r.start_token = _start_token
  limit 1
$$;
revoke all on function public.telegram_login_status(text) from public;
grant execute on function public.telegram_login_status(text) to anon, authenticated, service_role;