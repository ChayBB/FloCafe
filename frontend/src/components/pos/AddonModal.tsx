'use client';

import { useState } from 'react';
import { X, Plus, Minus } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'use-intl';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { formatCurrencyForTenant } from '@/lib/countries';
import {
  fractionalQuantityStep,
  maximumQuantity,
  minimumQuantity,
  quantityNudge,
  roundToQuantityPrecision,
} from '@/lib/utils';
import { addonStockCeiling, isAddonLowStock, isAddonSoldOut } from '@/lib/addon-inventory';
import { activeVariants, isVariantSoldOut, selectDefaultVariant } from '@/lib/product-variants';
import { cartVariantUnitPrice } from '@/lib/cart-price';
import type { Product, Addon, AddonGroup, ProductVariant } from '@/lib/types';

interface Props {
  product: Product;
  currency: string;
  /** Overrides the signed-in tenant's currency formatting (e.g. for standalone pages with no auth store). */
  country?: string;
  onAdd: (
    product: Product,
    quantity: number,
    addons: Addon[],
    specialInstructions: string,
    variant: ProductVariant | null,
  ) => void;
  onClose: () => void;
  initialQuantity?: number;
  initialAddons?: Addon[];
  initialInstructions?: string;
  initialVariant?: ProductVariant | null;
  mode?: 'add' | 'edit';
  /** Quote the variant's online platform price, matching the order this line becomes. */
  onlinePlatformSelected?: boolean;
}

function groupInitialAddons(addons: Addon[]): Record<string | number, Addon[]> {
  const grouped: Record<string | number, Addon[]> = {};
  for (const addon of addons) {
    const groupId = addon.addon_group_id;
    if (groupId == null) continue;
    grouped[groupId] = [...(grouped[groupId] || []), addon];
  }
  return grouped;
}

function variantPillClassName(isSelected: boolean, soldOut: boolean): string {
  if (soldOut) return 'border-border opacity-50 cursor-not-allowed';
  if (isSelected)
    return 'border-brand bg-[var(--color-brand-light)] text-brand dark:text-orange-300';
  return 'border-border hover:border-brand/40';
}

function addonRowClassName(isSelected: boolean, soldOut: boolean): string {
  if (isSelected)
    return 'border-brand bg-[var(--color-brand-light)] text-brand dark:text-orange-300';
  if (soldOut) return 'border-border opacity-50 cursor-not-allowed';
  return 'border-border hover:border-gray-300 dark:hover:border-border dark:border-border';
}

/**
 * The stock badges for one add-on row. Sold out wins over running low, so a
 * zero-stock add-on never carries both.
 */
function addonStockBadges(
  soldOut: boolean,
  lowStock: boolean,
  labels: { outOfStock: string; lowStock: string },
) {
  if (!soldOut && !lowStock) return null;
  return (
    <>
      {soldOut && (
        <span className="rounded-full bg-red-100 dark:bg-red-950/40 px-2 py-0.5 text-[10px] font-bold text-red-700 dark:text-red-300">
          {labels.outOfStock}
        </span>
      )}
      {lowStock && (
        <span className="rounded-full bg-orange-100 dark:bg-orange-950/40 px-2 py-0.5 text-[10px] font-bold text-orange-700 dark:text-orange-300">
          {labels.lowStock}
        </span>
      )}
    </>
  );
}

export default function AddonModal({
  product,
  currency,
  country,
  onAdd,
  onClose,
  initialQuantity = 1,
  initialAddons = [],
  initialInstructions = '',
  initialVariant = null,
  mode = 'add',
  onlinePlatformSelected = false,
}: Props) {
  const t = useTranslations('pos');
  const tenantFmt = useFormatCurrency();
  const fmt = country ? (n: number) => formatCurrencyForTenant(n, country, currency) : tenantFmt;
  const [selected, setSelected] = useState<Record<string | number, Addon[]>>(() =>
    groupInitialAddons(initialAddons),
  );
  const step = fractionalQuantityStep(product);
  // A shop that will not weigh out 20 grams of fish sets a floor. The field
  // never opens below it: a quantity under the floor is not a sale, and the
  // backend refuses it, so offering one would only fail on save.
  const minQuantity = minimumQuantity(product, step);
  // What + and - move by. Coarser than the precision on purpose: see quantityNudge.
  const nudge = quantityNudge(step);
  // Null when the product sets no cap, in which case nothing here limits it.
  const maxQuantity = maximumQuantity(product);
  const clampQuantity = (value: number) =>
    maxQuantity == null ? value : Math.min(value, maxQuantity);
  const openingQuantity = Math.max(initialQuantity, minQuantity);
  const [quantity, setQuantity] = useState(openingQuantity);
  // A weighed line opens blank. Every fish weighs something different, so a
  // prefilled 1 is a number nobody chose that still prices the line.
  const [qtyDraft, setQtyDraft] = useState(() =>
    step == null || initialQuantity !== 1 ? String(openingQuantity) : '',
  );
  const [instructions, setInstructions] = useState(initialInstructions);

  const variants = activeVariants(product.variants);
  const defaultVariant = selectDefaultVariant(variants, initialVariant?.id);
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(
    defaultVariant?.id ?? null,
  );
  const selectedVariant = variants.find((variant) => variant.id === selectedVariantId) ?? null;
  const variantUnitPrice = (variant: ProductVariant | null) =>
    cartVariantUnitPrice({ variant, product }, onlinePlatformSelected);
  const basePrice = variantUnitPrice(selectedVariant);
  const setQty = (next: number) => {
    setQuantity(next);
    setQtyDraft(String(next));
  };

  const commitQtyDraft = () => {
    if (step == null) return;
    // Left blank stays blank: the line cannot be added until a weight is read.
    if (qtyDraft.trim() === '') return;
    const parsed = Number(qtyDraft);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setQtyDraft(String(quantity));
      return;
    }
    const rounded = clampQuantity(Math.max(minQuantity, roundToQuantityPrecision(parsed, step)));
    setQuantity(rounded);
    setQtyDraft(String(rounded));
  };

  const groups = product.addon_groups || [];

  const getGroupTotalQuantity = (groupId: string | number): number => {
    const list = selected[groupId] || [];
    return list.reduce((sum, a) => sum + (a.quantity || 1), 0);
  };

  const updateAddonQuantity = (group: AddonGroup, addon: Addon, delta: number) => {
    const groupId = group.id;
    const currentList = selected[groupId] || [];
    const existingIndex = currentList.findIndex((a) => a.id === addon.id);
    const currentQty = existingIndex >= 0 ? currentList[existingIndex].quantity || 1 : 0;
    const newQty = currentQty + delta;

    if (newQty <= 0) {
      const updatedList = currentList.filter((a) => a.id !== addon.id);
      setSelected({ ...selected, [groupId]: updatedList });
    } else {
      const currentGroupTotal = currentList.reduce((sum, a) => sum + (a.quantity || 1), 0);
      const newGroupTotal = currentGroupTotal + delta;
      const max = group.max_selection || 999;
      if (delta > 0 && newGroupTotal > max) {
        toast.error(t('maxSelectionReached', { count: max }));
        return;
      }

      const rawCeiling = addonStockCeiling(addon);
      const stockCeiling =
        rawCeiling == null ? null : Math.floor(rawCeiling / (quantity > 0 ? quantity : 1));
      if (delta > 0 && stockCeiling != null && newQty > stockCeiling) {
        return;
      }

      if (existingIndex >= 0) {
        const updatedList = [...currentList];
        updatedList[existingIndex] = { ...updatedList[existingIndex], quantity: newQty };
        setSelected({ ...selected, [groupId]: updatedList });
      } else {
        setSelected({ ...selected, [groupId]: [...currentList, { ...addon, quantity: newQty }] });
      }
    }
  };

  const toggleAddonCheckbox = (group: AddonGroup, addon: Addon) => {
    const currentList = selected[group.id] || [];
    const exists = currentList.some((a) => a.id === addon.id);
    if (exists) {
      updateAddonQuantity(group, addon, -1);
    } else {
      updateAddonQuantity(group, addon, 1);
    }
  };

  const getAddonQuantity = (groupId: string | number, addonId: string | number): number => {
    const list = selected[groupId] || [];
    const item = list.find((a) => a.id === addonId);
    return item ? item.quantity || 1 : 0;
  };

  const allAddons = Object.values(selected).flat();
  const addonTotal = allAddons.reduce((sum, a) => sum + Number(a.price) * (a.quantity || 1), 0);
  /**
   * What `handleAdd` would charge right now.
   *
   * On a weighed product the typed draft is the weight, and it is only folded
   * into `quantity` on confirm. Pricing the line off `quantity` meanwhile showed
   * the customer a total for the wrong weight — the one number they are watching
   * while the scale is read out.
   */
  const weightEntered = step == null || qtyDraft.trim() !== '';
  const effectiveQuantity = (() => {
    if (step == null) return quantity;
    const parsed = Number(qtyDraft);
    if (!Number.isFinite(parsed) || parsed <= 0) return quantity;
    return clampQuantity(Math.max(minQuantity, roundToQuantityPrecision(parsed, step)));
  })();
  const itemTotal = (basePrice + addonTotal) * effectiveQuantity;

  const canQuantityCoverAddons = (targetQty: number): boolean => {
    if (targetQty <= 0) return false;
    for (const addon of allAddons) {
      const rawCeiling = addonStockCeiling(addon);
      if (rawCeiling == null) continue;
      const required = (addon.quantity || 1) * targetQty;
      if (required > rawCeiling) return false;
    }
    return true;
  };

  const nextItemQty =
    step == null ? quantity + 1 : roundToQuantityPrecision(quantity + nudge, step);
  const canIncreaseItemQty = canQuantityCoverAddons(nextItemQty);

  const groupsSatisfied = groups.every((g) => {
    const count = getGroupTotalQuantity(g.id);
    const requiredMin = Boolean(g.is_required)
      ? Math.max(1, g.min_selection || 1)
      : g.min_selection || 0;
    if (count < requiredMin) return false;
    if (g.max_selection && count > g.max_selection) return false;
    return true;
  });
  // A product with variants cannot be sold without one, and a fully sold-out
  // variant set cannot be sold at all.
  const isValid =
    weightEntered &&
    groupsSatisfied &&
    (variants.length === 0 || Boolean(selectedVariant)) &&
    canQuantityCoverAddons(quantity);

  const handleAdd = () => {
    if (!isValid) return;
    if (step != null && effectiveQuantity !== quantity) {
      setQuantity(effectiveQuantity);
      setQtyDraft(String(effectiveQuantity));
    }
    onAdd(product, effectiveQuantity, allAddons, instructions, selectedVariant);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-2xl w-full max-w-lg max-h-[92vh] flex flex-col">
        <div className="flex justify-between items-center p-5 border-b border-border">
          <div>
            <h2 className="text-lg font-bold text-foreground">{product.name}</h2>
            <p className="text-brand font-semibold">{fmt(basePrice)}</p>
          </div>
          <button
            onClick={onClose}
            className="touch-target rounded-full text-muted-foreground hover:text-foreground active:bg-muted"
            aria-label={t('close')}
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {variants.length > 0 && (
            <div role="radiogroup" aria-label={product.name}>
              <div className="flex flex-wrap gap-2">
                {variants.map((variant) => {
                  const soldOut = isVariantSoldOut(variant);
                  const isSel = variant.id === selectedVariantId;
                  return (
                    <button
                      key={variant.id}
                      type="button"
                      role="radio"
                      aria-checked={isSel}
                      disabled={soldOut}
                      onClick={() => setSelectedVariantId(variant.id)}
                      className={`touch-target inline-flex items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors ${variantPillClassName(isSel, soldOut)}`}
                    >
                      <span className="font-medium text-foreground">{variant.name}</span>
                      <span
                        className={`text-xs ${isSel ? 'text-brand dark:text-orange-300 font-semibold' : 'text-muted-foreground'}`}
                      >
                        {fmt(variantUnitPrice(variant))}
                      </span>
                      {soldOut && (
                        <span className="rounded-full bg-red-100 dark:bg-red-950/40 px-2 py-0.5 text-[10px] font-bold text-red-700 dark:text-red-300">
                          {t('outOfStock')}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {groups.map((group) => {
            const count = getGroupTotalQuantity(group.id);
            const activeAddons = (group.addons || []).filter((a) => a.is_active);
            const allowMultiple = Boolean(group.allow_multiple_quantities);

            return (
              <div key={group.id}>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold text-sm text-foreground">{group.name}</h3>
                  <span className="flex items-center gap-2">
                    {Boolean(group.is_required) && (
                      <span className="text-xs font-medium text-red-500 dark:text-red-400">
                        {t('required')}
                      </span>
                    )}
                    {group.max_selection
                      ? (() => {
                          const remaining = Math.max(0, group.max_selection - count);
                          const isZero = remaining === 0;
                          return (
                            <span
                              className={`font-semibold transition-all ${
                                isZero ? 'text-sm text-amber-500' : 'text-xs text-sky-500'
                              }`}
                            >
                              {isZero
                                ? t('selectionComplete')
                                : t('remainingCount', { count: remaining })}
                            </span>
                          );
                        })()
                      : null}
                  </span>
                </div>
                {group.description && (
                  <p className="text-xs text-muted-foreground mb-2">{group.description}</p>
                )}
                <div className="space-y-1">
                  {activeAddons.map((addon) => {
                    const addonQty = getAddonQuantity(group.id, addon.id);
                    const isSel = addonQty > 0;
                    const soldOut = isAddonSoldOut(addon);
                    const lowStock = isAddonLowStock(addon);
                    const rawCeiling = addonStockCeiling(addon);
                    const stockCeiling =
                      rawCeiling == null
                        ? null
                        : Math.floor(rawCeiling / (quantity > 0 ? quantity : 1));
                    // The cashier may only dial up to what is left, but never past
                    // the group cap, and an untracked add-on is never limited.
                    const atStockCeiling = stockCeiling != null && addonQty >= stockCeiling;
                    const plusDisabled = soldOut || atStockCeiling;
                    const priceTone = isSel
                      ? 'text-brand dark:text-orange-300 font-semibold'
                      : 'text-muted-foreground';
                    const counterButton =
                      'touch-target rounded flex items-center justify-center text-brand dark:text-orange-300 hover:bg-brand-light dark:hover:bg-[var(--color-brand-light)] active:bg-brand-light dark:active:bg-[var(--color-brand-light)]';
                    const badges = addonStockBadges(soldOut, lowStock, {
                      outOfStock: t('outOfStock'),
                      lowStock: t('lowStock'),
                    });

                    if (allowMultiple) {
                      return (
                        <div
                          key={addon.id}
                          className={`w-full min-h-14 flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border text-sm transition-colors ${addonRowClassName(isSel, soldOut)}`}
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-foreground">{addon.name}</span>
                            <span className={`text-xs ${priceTone}`}>
                              {Number(addon.price) === 0
                                ? t('freeAddon')
                                : `+${fmt(Number(addon.price))}`}
                            </span>
                            {badges}
                          </div>
                          <div className="flex items-center gap-2">
                            {isSel ? (
                              <div className="flex items-center gap-1.5 bg-card border border-brand rounded-lg p-0.5">
                                <button
                                  type="button"
                                  onClick={() => updateAddonQuantity(group, addon, -1)}
                                  className={counterButton}
                                >
                                  <Minus size={14} />
                                </button>
                                <span className="text-sm font-bold w-5 text-center text-brand dark:text-orange-300 tabular-nums">
                                  {addonQty}
                                </span>
                                <button
                                  type="button"
                                  disabled={plusDisabled}
                                  onClick={() => updateAddonQuantity(group, addon, 1)}
                                  className={`${counterButton} disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent`}
                                >
                                  <Plus size={14} />
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                disabled={plusDisabled}
                                onClick={() => updateAddonQuantity(group, addon, 1)}
                                className={`touch-target rounded-full bg-muted flex items-center justify-center text-muted-foreground hover:bg-muted active:bg-muted disabled:cursor-not-allowed disabled:opacity-50`}
                              >
                                <Plus size={14} />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={addon.id}
                        className={`w-full min-h-14 flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border text-sm transition-colors ${addonRowClassName(isSel, soldOut)}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground">{addon.name}</span>
                          <span className={`text-xs ${priceTone}`}>
                            {Number(addon.price) === 0
                              ? t('freeAddon')
                              : `+${fmt(Number(addon.price))}`}
                          </span>
                          {badges}
                        </div>
                        <div className="flex items-center gap-2">
                          {isSel ? (
                            <div className="flex items-center gap-1.5 bg-card border border-brand rounded-lg p-0.5">
                              <button
                                type="button"
                                onClick={() => toggleAddonCheckbox(group, addon)}
                                className={counterButton}
                              >
                                <Minus size={14} />
                              </button>
                              <span className="text-sm font-bold w-5 text-center text-brand dark:text-orange-300 tabular-nums">
                                1
                              </span>
                              <button
                                type="button"
                                disabled
                                className="touch-target rounded flex items-center justify-center text-muted-foreground cursor-not-allowed opacity-50"
                              >
                                <Plus size={14} />
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              disabled={plusDisabled}
                              onClick={() => toggleAddonCheckbox(group, addon)}
                              className={`touch-target rounded-full bg-muted flex items-center justify-center text-muted-foreground hover:bg-muted active:bg-muted disabled:cursor-not-allowed disabled:opacity-50`}
                            >
                              <Plus size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {(() => {
                  const requiredMin = Boolean(group.is_required)
                    ? Math.max(1, group.min_selection || 1)
                    : group.min_selection || 0;
                  if (requiredMin > 0 && count < requiredMin) {
                    return (
                      <p className="mt-1 text-xs text-red-500 dark:text-red-400">
                        {t('selectAtLeast', { count: requiredMin })}
                      </p>
                    );
                  }
                  return null;
                })()}
              </div>
            );
          })}

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {t('specialInstructions')}
            </label>
            <input
              type="text"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value.slice(0, 100))}
              placeholder={t('specialInstructionsPlaceholder')}
              maxLength={100}
              className="w-full min-h-11 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:ring-2 focus:ring-brand"
            />
            <p className="text-xs text-muted-foreground text-end mt-0.5">
              {instructions.length}/100
            </p>
          </div>
        </div>

        <div className="p-5 border-t border-border">
          <div className="flex items-center justify-center gap-4 mb-4">
            <button
              onClick={() =>
                step == null
                  ? setQty(Math.max(1, quantity - 1))
                  : setQty(Math.max(minQuantity, roundToQuantityPrecision(quantity - nudge, step)))
              }
              className="touch-target rounded-full bg-muted flex items-center justify-center hover:bg-muted active:bg-muted"
              aria-label={t('remove')}
            >
              <Minus size={18} />
            </button>
            {/* Counts, not weights. No two fish weigh the same, so offering 1, 2
                and 3 beside a kilogram field only invites the wrong number. */}
            <div className={`grid grid-cols-3 gap-2 ${step == null ? '' : 'hidden'}`}>
              {[1, 2, 3].map((quickQty) => {
                const disabled = !canQuantityCoverAddons(quickQty);
                return (
                  <button
                    key={quickQty}
                    type="button"
                    disabled={disabled}
                    onClick={() => setQty(quickQty)}
                    className={`touch-target rounded-lg border px-3 text-sm font-bold tabular-nums disabled:cursor-not-allowed disabled:opacity-50 ${
                      quantity === quickQty
                        ? 'border-brand bg-brand text-white'
                        : 'border-border bg-card text-foreground'
                    }`}
                  >
                    {quickQty}
                  </button>
                );
              })}
            </div>
            {step == null ? (
              <span className="text-lg font-bold w-10 text-center tabular-nums">{quantity}</span>
            ) : (
              // The unit sits beside the field because the number is a weight read
              // off a scale, not a count. Without it the box reads as "how many",
              // which is the question it used to be asked.
              <span className="flex items-center gap-1">
                <input
                  type="number"
                  inputMode="decimal"
                  min={minQuantity}
                  max={maxQuantity ?? undefined}
                  step={step}
                  value={qtyDraft}
                  onChange={(e) => setQtyDraft(e.target.value)}
                  onBlur={commitQtyDraft}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitQtyDraft();
                  }}
                  placeholder={t('enterWeight')}
                  aria-label={t('enterWeight')}
                  className="w-20 text-lg font-bold text-center tabular-nums border border-border bg-background rounded-md px-1 py-0.5 outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand placeholder:text-xs placeholder:font-normal placeholder:text-muted-foreground"
                />
                <span className="text-sm font-medium text-muted-foreground">
                  {product.sale_unit}
                </span>
              </span>
            )}
            <button
              onClick={() =>
                step == null
                  ? setQty(clampQuantity(quantity + 1))
                  : setQty(clampQuantity(roundToQuantityPrecision(quantity + nudge, step)))
              }
              disabled={!canIncreaseItemQty}
              className="touch-target rounded-full bg-muted flex items-center justify-center hover:bg-muted active:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={t('addItems')}
            >
              <Plus size={18} />
            </button>
          </div>
          <Button onClick={handleAdd} disabled={!isValid} className="w-full" size="lg">
            {mode === 'edit'
              ? t('saveItemChanges', { total: fmt(itemTotal) })
              : t('addToCart', { total: fmt(itemTotal) })}
          </Button>
        </div>
      </div>
    </div>
  );
}
