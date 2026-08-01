// import { create } from "zustand";
// import { persist } from "zustand/middleware";

// export type CartItem = {
//   key: string; // unique per config
//   pizzaId: string;
//   name: string;
//   image: string;
//   size: string;
//   sizeLabel: string;
//   crust: string;
//   crustLabel: string;
//   toppings: string[];
//   unitPrice: number;
//   qty: number;
// };

// // Transient confirmation shown after an item lands in the cart. Never persisted.
// export type LastAdded = {
//   id: number;
//   name: string;
//   image: string;
//   qty: number;
//   lineTotal: number;
// };

// type State = {
//   cart: CartItem[];
//   favorites: string[];
//   lastAdded: LastAdded | null;
//   // Supabase auth user id this cart/favorites snapshot currently belongs to.
//   // null = no one signed in yet on this device/browser.
//   scopedUserId: string | null;
//   addToCart: (item: CartItem) => void;
//   dismissLastAdded: () => void;
//   removeFromCart: (key: string) => void;
//   setQty: (key: string, qty: number) => void;
//   clearCart: () => void;
//   toggleFavorite: (id: string) => void;
//   /**
//    * Call whenever the signed-in Supabase user changes (sign in, sign out,
//    * or switching accounts on a shared device). If the account differs from
//    * whoever this cart/favorites snapshot currently belongs to, wipe them —
//    * this is what stops one customer's cart/favorites from leaking into the
//    * next customer's session on a shared phone/tablet/kiosk.
//    */
//   syncAccount: (userId: string | null) => void;
//   /**
//    * Cloud-sync only (see @/lib/cloud-sync): replace cart/favorites with the
//    * latest server state — an initial pull after sign-in, a guest/cloud
//    * merge result, or a realtime update pushed from another device. Never
//    * touches scopedUserId, since it doesn't represent an account change.
//    */
//   hydrateFromCloud: (cart: CartItem[], favorites: string[]) => void;
// };

// export const useStore = create<State>()(
//   persist(
//     (set, get) => ({
//       cart: [],
//       favorites: [],
//       lastAdded: null,
//       scopedUserId: null,
//       addToCart: (item) =>
//         set((s) => {
//           const lastAdded: LastAdded = {
//             id: Date.now(),
//             name: item.name,
//             image: item.image,
//             qty: item.qty,
//             lineTotal: item.unitPrice * item.qty,
//           };
//           const existing = s.cart.find((c) => c.key === item.key);
//           if (existing) {
//             return {
//               lastAdded,
//               cart: s.cart.map((c) => (c.key === item.key ? { ...c, qty: c.qty + item.qty } : c)),
//             };
//           }
//           return { lastAdded, cart: [...s.cart, item] };
//         }),
//       dismissLastAdded: () => set({ lastAdded: null }),
//       removeFromCart: (key) => set((s) => ({ cart: s.cart.filter((c) => c.key !== key) })),
//       setQty: (key, qty) =>
//         set((s) => ({
//           cart: qty <= 0 ? s.cart.filter((c) => c.key !== key) : s.cart.map((c) => (c.key === key ? { ...c, qty } : c)),
//         })),
//       clearCart: () => set({ cart: [] }),
//       toggleFavorite: (id) =>
//         set((s) => ({
//           favorites: s.favorites.includes(id) ? s.favorites.filter((f) => f !== id) : [...s.favorites, id],
//         })),
//       syncAccount: (userId) =>
//         set((s) => {
//           if (s.scopedUserId === userId) return {};
//           return { scopedUserId: userId, cart: [], favorites: [] };
//         }),
//       hydrateFromCloud: (cart, favorites) => set({ cart, favorites }),
//     }),
//     {
//       name: "pizza-uz-store",
//       partialize: (s) => ({ cart: s.cart, favorites: s.favorites, scopedUserId: s.scopedUserId }),
//     },
//   ),
// );

// export const cartTotal = (cart: CartItem[]) => cart.reduce((sum, i) => sum + i.unitPrice * i.qty, 0);
// export const cartCount = (cart: CartItem[]) => cart.reduce((sum, i) => sum + i.qty, 0);


import { create } from "zustand";
import { persist } from "zustand/middleware";

export type CartItem = {
  key: string; // unique per config
  pizzaId: string;
  name: string;
  image: string;
  size: string;
  sizeLabel: string;
  crust: string;
  crustLabel: string;
  toppings: string[];
  unitPrice: number;
  qty: number;
};

export type LastAdded = {
  id: number;
  name: string;
  image: string;
  qty: number;
  lineTotal: number;
};

type State = {
  cart: CartItem[];
  favorites: string[];
  lastAdded: LastAdded | null;
  scopedUserId: string | null;
  addToCart: (item: CartItem) => void;
  dismissLastAdded: () => void;
  removeFromCart: (key: string) => void;
  setQty: (key: string, qty: number) => void;
  clearCart: () => void;
  toggleFavorite: (id: string) => void;
  syncAccount: (userId: string | null) => void;
  hydrateFromCloud: (cart: CartItem[], favorites: string[]) => void;
};

// Функция, которая объединяет одинаковые товары и не даёт им удваиваться
function deduplicateCart(cart: CartItem[]): CartItem[] {
  const map = new Map<string, CartItem>();
  for (const item of cart) {
    if (map.has(item.key)) {
      const existing = map.get(item.key)!;
      map.set(item.key, { ...existing, qty: existing.qty + item.qty });
    } else {
      map.set(item.key, item);
    }
  }
  return Array.from(map.values());
}
export const useStore = create<State>()(
  persist(
    (set, get) => ({
      cart: [],
      favorites: [],
      lastAdded: null,
      scopedUserId: null,
      addToCart: (item) =>
        set((s) => {
          const lastAdded: LastAdded = {
            id: Date.now(),
            name: item.name,
            image: item.image,
            qty: item.qty,
            lineTotal: item.unitPrice * item.qty,
          };
          const existing = s.cart.find((c) => c.key === item.key);
          if (existing) {
            return {
              lastAdded,
              cart: s.cart.map((c) => (c.key === item.key ? { ...c, qty: c.qty + item.qty } : c)),
            };
          }
          return { lastAdded, cart: [...s.cart, item] };
        }),
      dismissLastAdded: () => set({ lastAdded: null }),
      removeFromCart: (key) => set((s) => ({ cart: s.cart.filter((c) => c.key !== key) })),
      setQty: (key, qty) =>
        set((s) => ({
          cart: qty <= 0 ? s.cart.filter((c) => c.key !== key) : s.cart.map((c) => (c.key === key ? { ...c, qty } : c)),
        })),
      clearCart: () => set({ cart: [] }),
      toggleFavorite: (id) =>
        set((s) => ({
          favorites: Array.from(new Set(s.favorites.includes(id) ? s.favorites.filter((f) => f !== id) : [...s.favorites, id])),
        })),
      syncAccount: (userId) =>
        set((s) => {
          if (s.scopedUserId === userId) return {};
          return { scopedUserId: userId, cart: [], favorites: [] };
        }),
      // ✅ Главное исправление: очищаем дубли при загрузке из облака
      hydrateFromCloud: (cart, favorites) =>
        set({
          cart: deduplicateCart(cart),
          favorites: Array.from(new Set(favorites)),
        }),
    }),
    {
      name: "pizza-uz-store",
      partialize: (s) => ({ cart: s.cart, favorites: s.favorites, scopedUserId: s.scopedUserId }),
    },
  ),
);

export const cartTotal = (cart: CartItem[]) => cart.reduce((sum, i) => sum + i.unitPrice * i.qty, 0);
export const cartCount = (cart: CartItem[]) => cart.reduce((sum, i) => sum + i.qty, 0);