/**
 * The one cart-item -> order-item projection.
 *
 * Every path that turns a cart line into a request payload uses this, so a
 * variant cannot be carried by one builder and dropped by another. The server
 * resolves and prices the variant from the database; only the id is sent.
 */

import type { CartItem } from '@/lib/types';

export interface OrderItemAddonPayload {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

export interface OrderItemPayload {
  product_id: string;
  variant_id: string | null;
  quantity: number;
  addons: OrderItemAddonPayload[] | null;
  special_instructions: string | null;
  /** Only set when true; the backend defaults it to false. */
  weight_pending?: boolean;
}

/** The cart-item fields a payload is built from; callers holding a staged or
 * draft line pass the same shape without a cart identity. */
export type OrderItemSource = Pick<
  CartItem,
  'product' | 'quantity' | 'addons' | 'special_instructions' | 'variant' | 'weight_pending'
>;

export function cartItemToOrderItem(item: OrderItemSource): OrderItemPayload {
  return {
    product_id: item.product.id,
    variant_id: item.variant?.id ?? null,
    quantity: item.quantity,
    addons:
      item.addons.length > 0
        ? item.addons.map((addon) => ({
            id: addon.id,
            name: addon.name,
            price: addon.price,
            quantity: addon.quantity || 1,
          }))
        : null,
    special_instructions: item.special_instructions || null,
    ...(item.weight_pending ? { weight_pending: true } : {}),
  };
}
