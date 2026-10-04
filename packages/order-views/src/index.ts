/**
 * @yiji/order-views — the one rendering of a Yiji order, shared by both portals.
 *
 * Created 2026-10-04 because the admin late-orders report and the agent
 * late-orders queue had grown two different "cart and tracking" panels, and ops
 * asked for them to be *"a resonance and mirror image and exactly"* the same —
 * *"the data displayed, the style everything"*. Two components cannot stay
 * identical; one can.
 *
 * It holds ONLY the views that take an order and render it. `LatestOrder` and
 * `CustomerOrders` stay in the agent portal: they stamp the conversation
 * (`useStampConversationOrder`), read the inbox's query keys (`inboxOrdersKey`)
 * and keep the agent's pinned orders, none of which exists in the admin portal.
 *
 * The commerce calls come from `OrderCommerceProvider`, which each app fills
 * with its OWN `src/lib/commerce-client.ts` — the two clients hit the same
 * gateway endpoints but authenticate through different Directus sessions, so
 * importing one into shared code would tie a portal to the other's auth.
 */
export {
  OrderCommerceProvider,
  useOrderCommerce,
  type OrderCommerceClient,
} from './commerce-context.js';
export { OrderDetails, OrderHeader, money, orderTone, titleize } from './OrderViews.js';
export { LateOrderDetail } from './LateOrderDetail.js';
