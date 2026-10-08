import { createContext, useContext, type ReactNode } from 'react';
import type { YijiOrder, YijiOrderCart, YijiOrderTimeline } from '@yiji/shared-types';

/**
 * The three calls an order view makes, and nothing else.
 *
 * WHY A CONTEXT AND NOT AN IMPORT (ops, 2026-10-04: the admin report's cart and
 * tracking *"should be a resonance and mirror image"* of the agent portal's).
 *
 * Each portal owns its own `src/lib/commerce-client.ts`. They hit the same
 * ai-gateway proxy with the same method shapes, but they authenticate through
 * that app's own Directus session and read that app's own `VITE_` environment —
 * so a shared component cannot import either one without dragging one portal's
 * auth and build config into the other. Importing the agent portal's client
 * from the admin portal is exactly what the old `OrderSnapshotPanel` avoided by
 * being a separate, thinner component; the seam belongs at the client, not at
 * the component.
 *
 * This interface is the SUBSET these views actually call, deliberately narrower
 * than either portal's `CommerceClient`: the agent's also holds `getInboxOrders`
 * and the admin's holds `customerExists`, and neither is any of this component's
 * business. Both clients satisfy it structurally, so each portal passes its own
 * and nothing is adapted.
 */
export interface OrderCommerceClient {
  /** One order with its line items. `null` when the vendor has no such order. */
  getOrder(vendorId: string, orderId: string): Promise<YijiOrder | null>;
  /**
   * The order's cart: every line, the choices behind it, and the courier's
   * tracking URL. Keyed by ORDER ID — no order lookup needed — which is what
   * lets it answer even when the order lookup cannot. `vendorId` (MV-1) picks
   * WHOSE platform; omitted, the gateway answers for the legacy vendor.
   */
  getOrderCart(orderId: string, vendorId?: string | null): Promise<YijiOrderCart | null>;
  /** The order's status timeline. `derived: true` means it was inferred. */
  getOrderTimeline(vendorId: string, orderId: string): Promise<YijiOrderTimeline | null>;
}

/*
 * NO DEFAULT CLIENT, deliberately.
 *
 * A fallback that returned empty data would render a complete-looking order
 * panel with nothing in it — the "plausible zero" shape this codebase keeps
 * meeting (see [[silent-empty-failures]]). An unwrapped render should fail
 * loudly in development instead, so the missing provider is found once rather
 * than shipped as a blank panel.
 */
const CommerceClientContext = createContext<OrderCommerceClient | null>(null);

/**
 * Hands this portal's commerce client to the order views below it.
 *
 * Mounted high — at the portal's provider stack, or around the one screen that
 * renders an order — so no individual view has to be given the client by prop.
 */
export function OrderCommerceProvider({
  client,
  children,
}: {
  client: OrderCommerceClient;
  children: ReactNode;
}) {
  return <CommerceClientContext.Provider value={client}>{children}</CommerceClientContext.Provider>;
}

/**
 * The client, or a thrown error naming the missing provider.
 *
 * Throwing rather than returning null: every caller would otherwise need the
 * same null check, and the one that forgot it would render an order panel that
 * silently never loads.
 */
export function useOrderCommerce(): OrderCommerceClient {
  const client = useContext(CommerceClientContext);
  if (!client) {
    throw new Error(
      'Order views need a commerce client: wrap this tree in <OrderCommerceProvider client={commerce}>.',
    );
  }
  return client;
}
