import { textLanguage } from '@yiji/shared-types';

/**
 * The language an Enhance request is written in (owner, 2026-10-25).
 *
 * The DRAFT decides: an agent who typed Arabic gets an Arabic improvement back,
 * whatever language the portal is in. Only a draft with no letters (an order
 * number, an emoji) falls back to the portal language.
 */
export function enhanceLocale(draft: string, portalLanguage: string | undefined): 'ar' | 'en' {
  return textLanguage(draft) ?? (portalLanguage?.toLowerCase().startsWith('ar') ? 'ar' : 'en');
}
