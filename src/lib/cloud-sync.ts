// Keeps a signed-in customer's cart and favorites in sync with Supabase so
// the same basket and saved items follow them across every device. Local
// zustand state (see @/lib/store) stays the source of truth for instant UI
// updates; this module mirrors it to `cart_items` / `favorites` (both RLS
// scoped to `auth.uid() = user_id`, see the cart_favorites_cloud_sync
// migration) and listens for realtime changes made from other devices.
//
// Call `initCloudSync()` once on app boot, then `handleAuthChange(userId)`
// whenever the signed-in user changes (initial session load, sign-in,
// sign-out, or switching accounts on a shared device).

import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { useStore, type CartItem } from "@/lib/store";

type CartRow = Database["public"]["Tables"]["cart_items"]["Row"];

const PUSH_DEBOUNCE_MS = 600;
const PULL_DEBOUNCE_MS = 400;

// Guards against the store-subscribe listener re-pushing state that we just
// wrote *into* the store ourselves (initial pull, merge result, realtime
// update from another device) — that would otherwise loop forever.
let applyingRemote = false;
// The account currently allowed to push local changes to the cloud. Kept in
// sync with store.scopedUserId, but tracked separately so we can suspend
// pushes during a transition (e.g. mid account-switch) without racing the
// store's own wipe.
let activeUserId: string | null = null;

let channel: RealtimeChannel | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pullTimer: ReturnType<typeof setTimeout> | null = null;
let watcherStarted = false;
// Bumped on every handleAuthChange call so an older, still-in-flight call
// (e.g. the initial getSession() racing the first onAuthStateChange event)
// can detect it's stale and bail out instead of clobbering newer state.
let authChangeToken = 0;

function rowToCartItem(row: CartRow): CartItem {
  return {
    key: row.item_key,
    pizzaId: row.pizza_id,
    name: row.name,
    image: row.image,
    size: row.size,
    sizeLabel: row.size_label,
    crust: row.crust,
    crustLabel: row.crust_label,
    toppings: row.toppings ?? [],
    unitPrice: Number(row.unit_price),
    qty: row.qty,
  };
}

/** Sums quantities for items that exist on both sides so nothing is dropped. */
function mergeCarts(a: CartItem[], b: CartItem[]): CartItem[] {
  const map = new Map<string, CartItem>();
  for (const item of b) map.set(item.key, { ...item });
  for (const item of a) {
    const existing = map.get(item.key);
    map.set(item.key, existing ? { ...existing, qty: existing.qty + item.qty } : { ...item });
  }
  return Array.from(map.values());
}

async function fetchCloudState(userId: string): Promise<{ cart: CartItem[]; favorites: string[] }> {
  const [cartRes, favRes] = await Promise.all([
    supabase.from("cart_items").select("*").eq("user_id", userId),
    supabase.from("favorites").select("pizza_id").eq("user_id", userId),
  ]);
  if (cartRes.error) console.error("[cloud-sync] failed to load cart", cartRes.error);
  if (favRes.error) console.error("[cloud-sync] failed to load favorites", favRes.error);
  return {
    cart: (cartRes.data ?? []).map(rowToCartItem),
    favorites: (favRes.data ?? []).map((r) => r.pizza_id),
  };
}

/** Replaces the user's cloud cart with exactly `cart` (upsert + delete the rest). */
async function reconcileCart(userId: string, cart: CartItem[]) {
  try {
    const { data: existing, error: readError } = await supabase
      .from("cart_items")
      .select("item_key")
      .eq("user_id", userId);
    if (readError) {
      console.error("[cloud-sync] cart read before reconcile failed", readError);
      return;
    }
    const keep = new Set(cart.map((i) => i.key));
    const toDelete = (existing ?? []).map((r) => r.item_key).filter((k) => !keep.has(k));
    if (toDelete.length > 0) {
      const { error } = await supabase.from("cart_items").delete().eq("user_id", userId).in("item_key", toDelete);
      if (error) console.error("[cloud-sync] cart delete failed", error);
    }
    if (cart.length > 0) {
      const { error } = await supabase.from("cart_items").upsert(
        cart.map((i) => ({
          user_id: userId,
          item_key: i.key,
          pizza_id: i.pizzaId,
          name: i.name,
          image: i.image,
          size: i.size,
          size_label: i.sizeLabel,
          crust: i.crust,
          crust_label: i.crustLabel,
          toppings: i.toppings,
          unit_price: i.unitPrice,
          qty: i.qty,
        })),
        { onConflict: "user_id,item_key" },
      );
      if (error) console.error("[cloud-sync] cart upsert failed", error);
    }
  } catch (e) {
    console.error("[cloud-sync] cart reconcile error", e);
  }
}

/** Replaces the user's cloud favorites with exactly `favorites`. */
async function reconcileFavorites(userId: string, favorites: string[]) {
  try {
    const { data: existing, error: readError } = await supabase
      .from("favorites")
      .select("pizza_id")
      .eq("user_id", userId);
    if (readError) {
      console.error("[cloud-sync] favorites read before reconcile failed", readError);
      return;
    }
    const keep = new Set(favorites);
    const toDelete = (existing ?? []).map((r) => r.pizza_id).filter((id) => !keep.has(id));
    if (toDelete.length > 0) {
      const { error } = await supabase.from("favorites").delete().eq("user_id", userId).in("pizza_id", toDelete);
      if (error) console.error("[cloud-sync] favorites delete failed", error);
    }
    if (favorites.length > 0) {
      const { error } = await supabase
        .from("favorites")
        .upsert(
          favorites.map((id) => ({ user_id: userId, pizza_id: id })),
          { onConflict: "user_id,pizza_id" },
        );
      if (error) console.error("[cloud-sync] favorites upsert failed", error);
    }
  } catch (e) {
    console.error("[cloud-sync] favorites reconcile error", e);
  }
}

function hydrate(cart: CartItem[], favorites: string[]) {
  applyingRemote = true;
  useStore.getState().hydrateFromCloud(cart, favorites);
  // The store-subscribe listener below fires synchronously inside the call
  // above, so it's safe to drop the guard right after.
  queueMicrotask(() => {
    applyingRemote = false;
  });
}

function schedulePush(userId: string) {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    // Read fresh state at fire time (not schedule time) so rapid taps
    // coalesce into a single write of the latest state.
    const state = useStore.getState();
    if (activeUserId !== userId || state.scopedUserId !== userId) return;
    void reconcileCart(userId, state.cart);
    void reconcileFavorites(userId, state.favorites);
  }, PUSH_DEBOUNCE_MS);
}

function schedulePull(userId: string) {
  if (pullTimer) clearTimeout(pullTimer);
  pullTimer = setTimeout(() => {
    pullTimer = null;
    void (async () => {
      if (activeUserId !== userId) return;
      const cloud = await fetchCloudState(userId);
      if (activeUserId !== userId) return;
      hydrate(cloud.cart, cloud.favorites);
    })();
  }, PULL_DEBOUNCE_MS);
}

function teardownChannel() {
  if (channel) {
    void supabase.removeChannel(channel);
    channel = null;
  }
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  if (pullTimer) {
    clearTimeout(pullTimer);
    pullTimer = null;
  }
}

function setupChannel(userId: string) {
  channel = supabase
    .channel(`cloud-sync:${userId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "cart_items", filter: `user_id=eq.${userId}` },
      () => schedulePull(userId),
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "favorites", filter: `user_id=eq.${userId}` },
      () => schedulePull(userId),
    )
    .subscribe();
}

/** Registers the local-change watcher once. Safe to call multiple times. */
export function initCloudSync() {
  if (watcherStarted) return;
  watcherStarted = true;
  useStore.subscribe((state, prev) => {
    if (applyingRemote) return;
    if (!activeUserId || state.scopedUserId !== activeUserId) return;
    if (state.cart === prev.cart && state.favorites === prev.favorites) return;
    schedulePush(activeUserId);
  });
}

/**
 * Call whenever the signed-in Supabase user changes. Wipes/merges local
 * state exactly like `store.syncAccount`, then pulls (and, for a fresh
 * sign-in or same-user reconnect, merges) the user's cloud cart/favorites,
 * and opens a realtime subscription so other devices' changes show up here.
 */




export async function handleAuthChange(userId: string | null) {
  const myToken = ++authChangeToken;

  const before = useStore.getState();
  const prevScopedUserId = before.scopedUserId;
  const localCart = before.cart;
  const localFavorites = before.favorites;

  // 👈 ЕСЛИ ЭТО ТОТ ЖЕ САМЫЙ ПОЛЬЗОВАТЕЛЬ (например, сворачивание вкладки или повторный фокус),
  // мы НЕ делаем повторный merge локального с облаком, чтобы товары не удваивались!
  const isSameUserReconnect = prevScopedUserId === userId && userId !== null;

  // Suspend pushes/realtime while we transition
  activeUserId = null;
  teardownChannel();

  useStore.getState().syncAccount(userId);

  if (!userId) return; // signed out

  const cloud = await fetchCloudState(userId);
  if (myToken !== authChangeToken) return;

  let finalCart = cloud.cart;
  let finalFavorites = cloud.favorites;
  let needsPush = false;

  // Если это повторный коннект того же пользователя, доверяем тому, что уже есть в стейте/облаке, 
  // без агрессивного повторного мерджа (чтобы избежать дублей).
  if (isSameUserReconnect) {
    // Просто берем то, что в стейте, если там что-то есть, или облачное
    finalCart = localCart.length > 0 ? localCart : cloud.cart;
    finalFavorites = localFavorites.length > 0 ? localFavorites : cloud.favorites;
  } else {
    // Первый вход (гость стал пользователем или первая загрузка)
    const shouldMergeLocal = prevScopedUserId === null;
    if (shouldMergeLocal && (localCart.length > 0 || localFavorites.length > 0)) {
      finalCart = mergeCarts(localCart, cloud.cart);
      finalFavorites = Array.from(new Set([...cloud.favorites, ...localFavorites]));
      needsPush = true;
    }
  }

  hydrate(finalCart, finalFavorites);
  activeUserId = userId;
  setupChannel(userId);

  if (needsPush) {
    void reconcileCart(userId, finalCart);
    void reconcileFavorites(userId, finalFavorites);
  }
}














// export async function handleAuthChange(userId: string | null) {
//   const myToken = ++authChangeToken;

//   const before = useStore.getState();
//   const prevScopedUserId = before.scopedUserId;
//   const localCart = before.cart;
//   const localFavorites = before.favorites;
//   // Local data is safe to merge in when it's this same account's cache
//   // (reconnect/reload) or nobody's yet (guest → signed in). A switch to a
//   // *different* known account must never leak the previous customer's
//   // basket, so we don't merge there — store.syncAccount below wipes it.
//   const shouldMergeLocal = prevScopedUserId === null || prevScopedUserId === userId;

//   // Suspend pushes/realtime while we transition so the wipe below (or the
//   // pull that follows) can never be mistaken for a real local edit.
//   activeUserId = null;
//   teardownChannel();

//   useStore.getState().syncAccount(userId);

//   if (!userId) return; // signed out — nothing left to sync

//   const cloud = await fetchCloudState(userId);
//   if (myToken !== authChangeToken) return; // a newer auth change superseded this one

//   let finalCart = cloud.cart;
//   let finalFavorites = cloud.favorites;
//   let needsPush = false;

//   if (shouldMergeLocal && (localCart.length > 0 || localFavorites.length > 0)) {
//     finalCart = mergeCarts(localCart, cloud.cart);
//     finalFavorites = Array.from(new Set([...cloud.favorites, ...localFavorites]));
//     needsPush = true;
//   }

//   hydrate(finalCart, finalFavorites);
//   activeUserId = userId;
//   setupChannel(userId);

//   if (needsPush) {
//     // Persist the merge result immediately rather than waiting on the
//     // debounce, so a second device opened right away already sees it.
//     void reconcileCart(userId, finalCart);
//     void reconcileFavorites(userId, finalFavorites);
//   }
// }
