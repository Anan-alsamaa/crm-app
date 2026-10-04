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

/*
 * THE AGENT PORTAL POLLS, like the admin portal already does.
 *
 * This was a bare `new QueryClient()`: no refetch interval, no refetch on
 * focus. Every list therefore showed whatever it had loaded when the page
 * opened, and an agent watching the inbox saw stale assignments, stale
 * statuses and stale orders until they pressed refresh by hand (owner,
 * 2026-09-15). The realtime socket covers messages and inbox activity, but
 * nothing else on the page listens to it.
 *
 * `refetchIntervalInBackground: false` on purpose: a hidden tab stops
 * polling, which keeps a parked portal from hammering the API all night.
 * Focus refetch is what makes the data correct the instant somebody looks
 * at it again.
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

        `@yiji/order-views` renders the order card both portals show and
        deliberately imports no portal module: each app's client authenticates
        through that app's own Directus session and reads that app's own `VITE_`
        config, so the component is given one rather than choosing one (ops,
        2026-10-04).

        Mounted at the root, INSIDE `QueryClientProvider`: the views are
        react-query callers, and an order card can appear on the inbox sidebar,
        a contact panel or the late-orders queue — three unrelated trees.
      */}
      <OrderCommerceProvider client={commerce}>
        <EnvironmentBanner environment={runtimeConfig().ENVIRONMENT} />
        <App />
      </OrderCommerceProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
