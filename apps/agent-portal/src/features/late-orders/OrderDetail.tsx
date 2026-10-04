/**
 * The late order's cart and tracking — now ONE component for both portals.
 *
 * `LateOrderDetail` was defined here. It moved to `@yiji/order-views` on
 * 2026-10-04 because ops asked that the admin late-orders report's Cart and
 * Tracking be *"a resonance and mirror image and exactly of the cart and
 * tracking in the late orders page in the agent portal. the data displayed, the
 * style everything"*. The admin report had its own thinner panel
 * (`OrderSnapshotPanel`, since deleted); two components cannot stay identical,
 * so there is now one and both portals render it.
 *
 * This file stays as the re-export so `LateOrdersPage` keeps importing the
 * component from where it has always lived. The agent portal's commerce client
 * is handed to it by the `OrderCommerceProvider` mounted in `App.tsx` — the
 * package deliberately imports no portal module, because each portal's client
 * authenticates through that app's own Directus session.
 */
export { LateOrderDetail } from '@yiji/order-views';
