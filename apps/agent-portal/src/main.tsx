import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/inter';
import '@fontsource-variable/outfit';
import './i18n/index.js';
import './index.css';
import { App } from './App.js';
import { EnvironmentBanner } from '@yiji/ui';
import { runtimeConfig } from '@yiji/shared-config';

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
      <EnvironmentBanner environment={runtimeConfig().ENVIRONMENT} />
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
