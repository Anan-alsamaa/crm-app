import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// Urbanist, self-hosted: the portals' CSP is `font-src 'self'`.
import '@fontsource-variable/urbanist';
import './i18n/index.js';
import './index.css';
import { App } from './App.js';
import { EnvironmentBanner } from '@yiji/ui';
import { runtimeConfig } from '@yiji/shared-config';

/* Same freshness rule as the admin portal: poll while visible, stop when the
   tab is hidden, refresh on focus. */
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
