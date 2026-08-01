-- Cloud sync for cart and favorites, so a signed-in customer's basket and
-- saved items follow them across every device instead of living only in
-- this browser's local storage. Mirrors the ownership + RLS shape already
-- used by public.orders: every row is tied to exactly one auth user and
-- only that user (or the service role) can ever read or write it.

create table public.cart_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Matches CartItem.key on the client: unique per exact configuration
  -- (pizza + size + crust + toppings), so re-adding the same combo bumps
  -- qty instead of creating a duplicate row.
  item_key text not null,
  pizza_id text not null,
  name text not null,
  image text not null,
  size text not null default '',
  size_label text not null default '',
  crust text not null default '',
  crust_label text not null default '',
  toppings text[] not null default '{}',
  unit_price numeric(12,2) not null,
  qty integer not null check (qty > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, item_key)
);
grant select, insert, update, delete on public.cart_items to authenticated;
grant all on public.cart_items to service_role;
alter table public.cart_items enable row level security;
create policy "cart_items_select_own" on public.cart_items for select to authenticated using (auth.uid() = user_id);
create policy "cart_items_insert_own" on public.cart_items for insert to authenticated with check (auth.uid() = user_id);
create policy "cart_items_update_own" on public.cart_items for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "cart_items_delete_own" on public.cart_items for delete to authenticated using (auth.uid() = user_id);
create index cart_items_user_idx on public.cart_items(user_id, updated_at desc);

create trigger trg_cart_items_updated before update on public.cart_items
  for each row execute function public.set_updated_at();

create table public.favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  pizza_id text not null,
  created_at timestamptz not null default now(),
  unique (user_id, pizza_id)
);
grant select, insert, delete on public.favorites to authenticated;
grant all on public.favorites to service_role;
alter table public.favorites enable row level security;
create policy "favorites_select_own" on public.favorites for select to authenticated using (auth.uid() = user_id);
create policy "favorites_insert_own" on public.favorites for insert to authenticated with check (auth.uid() = user_id);
create policy "favorites_delete_own" on public.favorites for delete to authenticated using (auth.uid() = user_id);
create index favorites_user_idx on public.favorites(user_id, created_at desc);

-- Let every signed-in device receive live postgres_changes events for its
-- own rows only (RLS still applies to realtime), so a cart update made on
-- one phone shows up instantly on another.
do $$
begin
  begin
    alter publication supabase_realtime add table public.cart_items;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.favorites;
  exception when duplicate_object then null;
  end;
end $$;
