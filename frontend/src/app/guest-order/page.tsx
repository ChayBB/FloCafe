'use client';

import axios from 'axios';
import { Check, Loader2, Minus, Plus, Search, Send, ShoppingCart, UtensilsCrossed, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import toast, { Toaster } from 'react-hot-toast';
import { formatCurrencyForTenant } from '@/lib/countries';
import { nameToColor } from '@/lib/image-utils';

interface MenuProduct {
  id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  price: number;
  has_image: boolean;
  updated_at: string;
}

interface TicketItem {
  id: number;
  product_name: string;
  quantity: number;
  status: string;
  special_instructions: string | null;
}

interface GuestSession {
  table: { name: string };
  currency: string;
  country: string;
  categories: { id: string; name: string }[];
  products: MenuProduct[];
  ticket: { order_number: string; items: TicketItem[] } | null;
}

// Mirrors the kitchen statuses a guest is allowed to see.
const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-600',
  preparing: 'bg-orange-100 text-orange-700',
  ready: 'bg-emerald-100 text-emerald-700',
  served: 'bg-blue-100 text-blue-700',
};

const STATUS_LABELS_TH: Record<string, string> = {
  pending: 'รอดำเนินการ',
  preparing: 'กำลังดำเนินการ',
  ready: 'พร้อมเสิร์ฟ',
  served: 'เสิร์ฟแล้ว',
};

function readToken(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('t') || '';
}

export default function GuestOrderPage() {
  const [token, setToken] = useState('');
  const [session, setSession] = useState<GuestSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState('all');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [cartOpen, setCartOpen] = useState(false);
  const [sending, setSending] = useState(false);

  // Proof that this phone belongs to the sitting that is currently at the table.
  // A ref rather than state: nothing renders from it, and it must not be in the
  // URL, where it would end up in screenshots and referrer logs.
  const roundTokenRef = useRef<string | null>(null);
  const roundHeader = () => (roundTokenRef.current ? { 'X-Flo-Round': roundTokenRef.current } : undefined);

  // The token only exists in the URL the customer scanned, so it is read once on
  // mount; every state write happens in an async callback to keep the first
  // render free of cascading updates.
  useEffect(() => {
    let cancelled = false;
    const scanned = readToken();
    if (!scanned) {
      void Promise.resolve().then(() => { if (!cancelled) setLoading(false); });
      return () => { cancelled = true; };
    }
    axios.get(`/api/guest/${encodeURIComponent(scanned)}/session`)
      .then(({ data }) => {
        if (cancelled) return;
        // Issued for this sitting only. Settling the bill retires it, so an old
        // phone stops ordering while the printed code keeps working for the
        // next party. Held in a ref, never in the URL.
        roundTokenRef.current = data.round_token ?? null;
        setToken(scanned);
        setSession(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(axios.isAxiosError(err) ? (err.response?.data?.error || 'Could not load the menu') : 'Could not load the menu');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // The ticket is the only thing that changes without the guest acting, and a
  // phone in a pocket should not hold a socket open; a slow poll is enough.
  useEffect(() => {
    if (!token || !session) return;
    const timer = setInterval(() => {
      axios.get(`/api/guest/${encodeURIComponent(token)}/ticket`, { headers: roundHeader() })
        .then(({ data }) => setSession((current) => (current ? { ...current, ticket: data.ticket } : current)))
        .catch(() => { /* a dropped poll retries on the next tick */ });
    }, 20_000);
    return () => clearInterval(timer);
  }, [token, session]);

  const money = (value: number) => formatCurrencyForTenant(value, session?.country || '', session?.currency || 'THB');

  const products = useMemo(() => {
    if (!session) return [];
    const search = query.trim().toLowerCase();
    return session.products.filter((product) => {
      const matchesCategory = categoryId === 'all' || product.category_id === categoryId;
      const matchesSearch = !search || product.name.toLowerCase().includes(search);
      return matchesCategory && matchesSearch;
    });
  }, [session, query, categoryId]);

  const cartLines = useMemo(() => {
    if (!session) return [];
    return Object.entries(cart)
      .filter(([, quantity]) => quantity > 0)
      .map(([productId, quantity]) => ({
        product: session.products.find((item) => item.id === productId)!,
        quantity,
      }))
      .filter((line) => line.product);
  }, [cart, session]);

  const cartCount = cartLines.reduce((sum, line) => sum + line.quantity, 0);
  const cartTotal = cartLines.reduce((sum, line) => sum + line.product.price * line.quantity, 0);

  function changeQuantity(productId: string, delta: number) {
    setCart((current) => {
      const next = Math.max(0, (current[productId] || 0) + delta);
      const updated = { ...current, [productId]: next };
      if (next === 0) delete updated[productId];
      return updated;
    });
  }

  async function sendOrder() {
    if (cartLines.length === 0 || sending) return;
    setSending(true);
    try {
      const { data } = await axios.post(`/api/guest/${encodeURIComponent(token)}/order`, {
        items: cartLines.map((line) => ({ product_id: line.product.id, quantity: line.quantity })),
      }, { headers: roundHeader() });
      setCart({});
      setCartOpen(false);
      setSession((current) => (current ? { ...current, ticket: data.ticket } : current));
      toast.success('ส่งออเดอร์เข้าครัวแล้ว');
    } catch (err: unknown) {
      const message = axios.isAxiosError(err)
        ? (err.response?.data?.error || 'ส่งออเดอร์ไม่สำเร็จ')
        : 'ส่งออเดอร์ไม่สำเร็จ';
      toast.error(message);
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand" />
      </div>
    );
  }

  if (!token || error || !session) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <UtensilsCrossed size={40} className="text-muted-foreground" />
        <p className="text-base font-semibold">{error || 'ไม่พบโต๊ะ'}</p>
        <p className="text-sm text-muted-foreground">กรุณาสแกน QR บนโต๊ะอีกครั้ง หรือเรียกพนักงาน</p>
      </div>
    );
  }

  return (
    <div className="pb-28">
      <Toaster position="top-center" />

      <header className="sticky top-0 z-20 border-b border-border bg-card/95 px-4 py-3 backdrop-blur">
        <p className="text-xs text-muted-foreground">โต๊ะ</p>
        <h1 className="text-lg font-bold">{session.table.name}</h1>
      </header>

      {session.ticket && session.ticket.items.length > 0 && (
        <section className="border-b border-border bg-muted/40 px-4 py-3">
          <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
            รายการที่สั่งแล้ว · {session.ticket.order_number}
          </p>
          <ul className="space-y-1.5">
            {session.ticket.items.map((item) => (
              <li key={item.id} className="flex items-center gap-2 text-sm">
                <span className="w-8 shrink-0 font-bold">{item.quantity}×</span>
                <span className="min-w-0 flex-1 truncate">{item.product_name}</span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLES[item.status] || STATUS_STYLES.pending}`}>
                  {STATUS_LABELS_TH[item.status] || item.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="sticky top-[68px] z-10 space-y-2 border-b border-border bg-card px-4 py-3">
        <div className="relative">
          <Search size={16} className="absolute start-3 top-3 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="ค้นหาเมนู"
            className="h-10 w-full rounded-lg border border-border bg-background ps-9 pe-3 text-sm outline-none focus:border-brand"
          />
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          <button
            onClick={() => setCategoryId('all')}
            className={`h-9 shrink-0 rounded-lg px-3 text-sm ${categoryId === 'all' ? 'bg-brand text-white' : 'bg-muted'}`}
          >
            ทั้งหมด
          </button>
          {session.categories.map((category) => (
            <button
              key={category.id}
              onClick={() => setCategoryId(category.id)}
              className={`h-9 shrink-0 rounded-lg px-3 text-sm ${categoryId === category.id ? 'bg-brand text-white' : 'bg-muted'}`}
            >
              {category.name}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 p-4">
        {products.map((product) => {
          const inCart = cart[product.id] || 0;
          return (
            <div key={product.id} className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="relative aspect-square w-full overflow-hidden">
                <div
                  className="absolute inset-0 flex items-center justify-center"
                  style={{ backgroundColor: nameToColor(product.name) }}
                >
                  <span className="text-2xl font-bold text-white/80">{product.name.substring(0, 2).toUpperCase()}</span>
                </div>
                {product.has_image && (
                  <img
                    src={`/api/guest/${encodeURIComponent(token)}/products/${product.id}/image`}
                    alt={product.name}
                    className="absolute inset-0 h-full w-full object-cover"
                    onError={(event) => { (event.target as HTMLImageElement).style.display = 'none'; }}
                  />
                )}
              </div>
              <div className="p-3">
                <p className="line-clamp-2 text-sm font-semibold">{product.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">{money(product.price)}</p>
                {inCart > 0 ? (
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <button
                      onClick={() => changeQuantity(product.id, -1)}
                      aria-label="ลด"
                      className="flex h-9 w-9 items-center justify-center rounded-lg border border-border"
                    >
                      <Minus size={16} />
                    </button>
                    <span className="text-base font-bold">{inCart}</span>
                    <button
                      onClick={() => changeQuantity(product.id, 1)}
                      aria-label="เพิ่ม"
                      className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-white"
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => changeQuantity(product.id, 1)}
                    className="mt-2 flex h-9 w-full items-center justify-center gap-1 rounded-lg bg-brand text-sm font-semibold text-white"
                  >
                    <Plus size={16} />
                    เพิ่ม
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {products.length === 0 && (
          <p className="col-span-2 py-10 text-center text-sm text-muted-foreground">ไม่พบเมนู</p>
        )}
      </div>

      {cartCount > 0 && !cartOpen && (
        <button
          onClick={() => setCartOpen(true)}
          className="fixed inset-x-4 bottom-4 z-30 flex h-14 items-center justify-between rounded-xl bg-brand px-5 font-semibold text-white shadow-lg"
        >
          <span className="flex items-center gap-2">
            <ShoppingCart size={18} />
            {cartCount} รายการ
          </span>
          <span>{money(cartTotal)}</span>
        </button>
      )}

      {cartOpen && (
        <div className="fixed inset-0 z-40 flex items-end bg-black/50" onClick={() => setCartOpen(false)}>
          <div
            className="max-h-[85vh] w-full overflow-y-auto rounded-t-2xl bg-card p-5"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold">ตะกร้า</h2>
              <button onClick={() => setCartOpen(false)} aria-label="ปิด" className="flex h-10 w-10 items-center justify-center rounded-full text-gray-400">
                <X size={20} />
              </button>
            </div>

            <ul className="space-y-3">
              {cartLines.map((line) => (
                <li key={line.product.id} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{line.product.name}</span>
                  <div className="flex items-center gap-2">
                    <button onClick={() => changeQuantity(line.product.id, -1)} aria-label="ลด" className="flex h-9 w-9 items-center justify-center rounded-lg border border-border">
                      <Minus size={15} />
                    </button>
                    <span className="w-6 text-center font-bold">{line.quantity}</span>
                    <button onClick={() => changeQuantity(line.product.id, 1)} aria-label="เพิ่ม" className="flex h-9 w-9 items-center justify-center rounded-lg border border-border">
                      <Plus size={15} />
                    </button>
                  </div>
                  <span className="w-20 shrink-0 text-end text-sm font-semibold">{money(line.product.price * line.quantity)}</span>
                </li>
              ))}
            </ul>

            <div className="mt-5 flex items-center justify-between border-t border-border pt-4">
              <span className="text-sm text-muted-foreground">รวม</span>
              <span className="text-xl font-bold">{money(cartTotal)}</span>
            </div>

            <button
              onClick={sendOrder}
              disabled={sending}
              className="mt-4 flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-brand text-base font-bold text-white disabled:opacity-60"
            >
              {sending ? <Loader2 size={20} className="animate-spin" /> : <Send size={20} />}
              {sending ? 'กำลังส่ง...' : 'ส่งเข้าครัว'}
            </button>
            <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <Check size={13} />
              ชำระเงินที่เคาน์เตอร์หรือกับพนักงาน
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
