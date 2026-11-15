import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import type { MarketingEngine } from '@yiji/shared-types';
import { directus } from '../lib/directus.js';
import { useAuth } from '../lib/auth/AuthContext.js';
import { SampleMarketingEngine } from './sample.js';
import { LiveMarketingEngine } from './live.js';

/**
 * WHICH ENGINE (owner, 2026-11-15: "once it is built in Yiji v2, within 2
 * hours we go live"). The portal runs on the SAMPLE engine until the switch
 * is flipped: the Administrator sets `app_settings.marketing_engine` to
 * `live` (Global settings) once the gateway holds v2's URL and key. No
 * rebuild, no release - every page already talks to the same interface.
 * `VITE_MARKETING_ENGINE=live|sample` pins it for a build (local dev, tests).
 */
export const MARKETING_ENGINE_SETTING_KEY = 'marketing_engine';
export type EngineChoice = 'sample' | 'live';

const Ctx = createContext<MarketingEngine | null>(null);

async function readEngineChoice(): Promise<EngineChoice> {
  const pinned = (import.meta.env.VITE_MARKETING_ENGINE as string | undefined)?.trim();
  if (pinned === 'live' || pinned === 'sample') return pinned;
  try {
    const rows = (await directus.request(
      readItems(
        'app_settings' as never,
        {
          filter: { key: { _eq: MARKETING_ENGINE_SETTING_KEY } },
          fields: ['value'],
          limit: 1,
        } as never,
      ),
    )) as unknown as Array<{ value: unknown }>;
    const v = String(rows[0]?.value ?? '')
      .replace(/^"|"$/g, '')
      .trim()
      .toLowerCase();
    return v === 'live' ? 'live' : 'sample';
  } catch {
    return 'sample';
  }
}

export function useEngineChoice(): { choice: EngineChoice; known: boolean } {
  const q = useQuery({
    queryKey: ['marketing-engine-choice'],
    queryFn: readEngineChoice,
    staleTime: 60_000,
  });
  return { choice: q.data ?? 'sample', known: q.data !== undefined };
}

export function EngineProvider({
  children,
  engine,
}: {
  children: ReactNode;
  engine?: MarketingEngine;
}) {
  const { user } = useAuth();
  const { choice } = useEngineChoice();
  const me = user?.id ?? 'me';
  const value = useMemo<MarketingEngine>(() => {
    if (engine) return engine;
    return choice === 'live' ? new LiveMarketingEngine() : new SampleMarketingEngine(() => me);
  }, [engine, choice, me]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEngine(): MarketingEngine {
  const e = useContext(Ctx);
  if (!e) throw new Error('useEngine must be used within EngineProvider');
  return e;
}
