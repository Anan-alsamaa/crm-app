import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/inter';
import '@fontsource-variable/outfit';
import './i18n/index.js';
import './index.css';
import { App } from './App.js';
import { EnvironmentBanner } from '@yiji/ui';
import { OrderCommerceProvider } from '@yiji/order-views';
import { runtimeConfig } from '@yiji/shared-config';
import { commerce } from './lib/commerce-client.js';

/**
 * The admin portal keeps itself current without a reload.
 *
 * It has no socket — the agent portal has one because a chat is a live
 * conversation, but opening and maintaining one here for dashboards and
 * approval queues is a large piece of machinery for data that changes on the
 * order of seconds, not milliseconds. Polling at the client level gives every
 * screen the same freshness without 41 call sites each deciding for itself.
 *
 * WHY THESE NUMBERS:
 *
 * `refetchInterval` 30s — the same cadence the notification bell already chose
 * for the thing that matters most here, a coupon waiting on a human approval.
 *
 * `refetchIntervalInBackground: false` — a hidden tab stops polling entirely.
 * An admin with the portal open on a second monitor all day should not be
 * generating a request every 30 seconds against a shared Directus.
 *
 * `refetchOnWindowFocus` — coming back to the tab refreshes immediately, which
 * is the moment an operator actually looks. This is also react-query's default;
 * it is written out because the polling above only makes sense paired with it.
 *
 * `staleTime` 10s — a short floor so that switching between screens, or several
 * components asking for the same data, does not fan out into duplicate
 * requests. Queries that want something slower (reports, month aggregates) set
 * their own and are unaffected: a per-query value always wins over these
 * defaults.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      staleTime: 10_000,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {/*
        THIS PORTAL'S COMMERCE CLIENT, handed to the shared order views.

        The late-orders report renders `LateOrderDetail` from
        `@yiji/order-views` — the same component the agent portal's queue uses,
        so the Cart and Tracking are the same thing rather than two lookalikes
        that drift (ops, 2026-10-04). The package imports no portal module: this
        app's client carries this app's Directus session, and the component is
        given one rather than choosing one.

        Mounted at the root, INSIDE `QueryClientProvider`, because the views are
        react-query callers.
      */}
      <OrderCommerceProvider client={commerce}>
        <EnvironmentBanner environment={runtimeConfig().ENVIRONMENT} />
        <App />
      </OrderCommerceProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
