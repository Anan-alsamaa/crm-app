import {
  CAMPAIGN_OBJECTIVES,
  DEFAULT_MONEY_MODEL,
  OBJECTIVE_CATALOGUE,
  bundlePriceProblem,
  campaignUniquenessConflicts,
  canApproveCampaign,
  firstOrderCoupon,
  forecastCampaign,
  lockedFieldChanges,
  objectiveSpec,
  readCampaignDraft,
  simulateCampaignCheckout,
  type Campaign,
  type CampaignDraft,
  type CampaignForecast,
  type CampaignPerformance,
  type CampaignStatus,
  type CheckoutSimulation,
  type CustomerGroup,
  type EarningRule,
  type EngineCatalogue,
  type GiftCardActivity,
  type GiftCardProduct,
  type GiftCardStats,
  type HomeSummary,
  type IssuanceResult,
  type Liability,
  type MarketingEngine,
  type MoneyModel,
  type Opportunity,
  type OrdersExportRow,
  type Redemption,
  type RewardsCampaign,
  type RewardsItem,
  type RewardsMember,
  type RewardsStats,
  type Study,
} from '@yiji/shared-types';

/**
 * THE SAMPLE ENGINE: the whole portal, working, before Yiji v2 exists.
 *
 * Everything the live engine will answer is answered here from generated
 * data that looks like ours (four brands, Riyadh branches, pasta and bites),
 * deterministic from a seed so a screenshot today matches a screenshot
 * tomorrow. What a person CHANGES - campaigns, studies, gift-card products,
 * earning rules - is kept in this browser (localStorage), the way the
 * operations draft kept its prototype data. Nothing here is real money.
 */

const STORE_KEY = 'marketing-sample-engine:v1';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const r = rng(20261115);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(r() * arr.length)]!;
const between = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
const iso = (d: Date) => d.toISOString();
const dayOf = (d: Date) => iso(d).slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const plusDays = (d: string, n: number) => dayOf(new Date(Date.parse(d) + n * 86_400_000));

/* ── catalogue ───────────────────────────────────────────────────────────── */

const BRANDS = [
  { id: 'casapasta', name: 'CasaPasta', colour: '#e4572e' },
  { id: 'poshak', name: 'Poshak', colour: '#f3a712' },
  { id: 'okashi', name: 'Okashi', colour: '#7d8597' },
  { id: 'cnd', name: 'Chick N Dip', colour: '#a1c349' },
];
const CITIES = ['Riyadh', 'Jeddah', 'Dammam', 'Khobar', 'Makkah', 'Madinah'];
const PLACES = [
  'One Square',
  'Masief Plaza',
  'Marina Mall',
  'Granada',
  'Al Nakheel',
  'Hamra',
  'Rawdah',
  'Tahlia',
  'Olaya',
  'Sulaimaniyah',
];
const CATEGORIES: Record<string, string[]> = {
  casapasta: [
    'Drinks',
    'Risotto',
    'Original Pasta',
    'Signature Pasta',
    'Sides & Starters',
    'Kids Menu',
    'Pasta Box',
    'Combos',
  ],
  poshak: ['Drinks', 'Rolls', 'Platters', 'Sides', 'Desserts', 'Combos'],
  okashi: ['Drinks', 'Sushi', 'Rice Bowls', 'Ramen', 'Sides', 'Desserts'],
  cnd: ['Drinks', 'Bites', 'Sandwiches', 'Dips', 'Sides', 'Combos'],
};
const ITEMS: Record<string, string[]> = {
  Drinks: [
    'Mojito Pomegranate',
    'Mojito Mango',
    'Water',
    'Sweet Dream',
    'Blue Ocean',
    'Pepsi',
    'Diet Pepsi',
    'Mountain Dew',
    '7 Up',
    'Mirinda',
    'Juice Orange',
    'Juice Apple',
  ],
  Risotto: [
    'Creamy Tomato Risotto Chicken',
    'Wild Mushroom Risotto',
    'Creamy Tomato Risotto Shrimp',
    'Chicken Truffle Risotto',
  ],
  'Original Pasta': [
    'Vegetable Pasta',
    'Chicken Pasta',
    'Makrona Hamra',
    'Plain Pasta',
    'Spaghetti Bolognese',
    'Hotdog Pasta',
    'Pepperoni Pasta',
    'Shrimp Pasta',
  ],
  'Signature Pasta': [
    'Fettuccine Alfredo Chicken',
    'Truffle Pasta',
    'Cajun Chicken Pasta',
    'Cajun Pasta with Shrimp and Chicken',
    'Fettuccine Alfredo Shrimp',
    'Alfredo Pasta with Shrimp and Chicken',
  ],
  'Sides & Starters': [
    'Mix Box Garlic Bread',
    'Buffalo Sauce',
    'Garlic bread with cheese',
    'Garlic Bread Vegetable',
    'Truffle Garlic Bread',
  ],
  'Kids Menu': ['Bambino Pasta Combo', 'Bambino Chicken Bites Combo'],
  'Pasta Box': ['Pasta Preparation Box', 'CasaPasta Box'],
  Combos: ['Buffalo Pasta Combo', 'Family Combo', 'Duo Combo'],
  Rolls: ['Chicken Tikka Roll', 'Beef Seekh Roll', 'Paneer Roll'],
  Platters: ['Biryani Platter', 'Mixed Grill Platter'],
  Sides: ['Fries', 'Coleslaw', 'Edamame'],
  Desserts: ['Gulab Jamun', 'Mochi', 'Cheesecake'],
  Sushi: ['Salmon Roll', 'California Roll', 'Dragon Roll'],
  'Rice Bowls': ['Teriyaki Chicken Bowl', 'Salmon Poke Bowl'],
  Ramen: ['Tonkotsu Ramen', 'Spicy Miso Ramen'],
  Bites: ['Chicken Bites 6', 'Chicken Bites 12', 'Spicy Bites 9'],
  Sandwiches: ['Classic Chicken Sandwich', 'Spicy Chicken Sandwich'],
  Dips: ['Cheese Dip', 'Garlic Dip', 'BBQ Dip'],
};

function buildCatalogue(): EngineCatalogue {
  const branches = BRANDS.flatMap((b, bi) =>
    Array.from({ length: 6 }, (_, i) => ({
      id: `${b.id.toUpperCase().slice(0, 3)}-${String(bi * 10 + i + 1).padStart(3, '0')}`,
      brandId: b.id,
      name: `${PLACES[(bi * 3 + i) % PLACES.length]} ${i + 1}`,
      city: CITIES[(bi + i) % CITIES.length]!,
    })),
  );
  const categories = BRANDS.flatMap((b) =>
    CATEGORIES[b.id]!.map((c, i) => ({ id: `${b.id}:${i}`, brandId: b.id, name: c })),
  );
  const products = categories.flatMap((c, ci) =>
    (ITEMS[c.name] ?? ['Item A', 'Item B']).map((n, i) => ({
      id: `${c.brandId.slice(0, 2).toUpperCase()}-${String(ci * 20 + i + 1).padStart(3, '0')}`,
      brandId: c.brandId,
      categoryId: c.id,
      name: n,
      priceSar: c.name === 'Drinks' ? between(4, 12) : between(14, 42),
      orderTypes: ['DELIVERY', 'PICKUP', 'CARHOP'] as const,
    })),
  );
  return {
    brands: BRANDS,
    branches,
    categories,
    products: products.map((p) => ({ ...p, orderTypes: [...p.orderTypes] })),
  };
}
const CATALOGUE = buildCatalogue();

/* ── the stored part ─────────────────────────────────────────────────────── */

interface Stored {
  campaigns: Campaign[];
  studies: Study[];
  giftProducts: GiftCardProduct[];
  earningRules: EarningRule[];
}

const USERS = { ayman: 'ayman', manager: 'marketing-manager', fahad: 'fahad' };

function seedCampaign(
  n: number,
  partial: Partial<CampaignDraft> & {
    objective: CampaignDraft['objective'];
    offer: CampaignDraft['offer'];
  },
  status: CampaignStatus,
  createdBy: string,
  daysBack: number,
  names: { en: string; ar: string },
): Campaign {
  const spec = objectiveSpec(partial.objective);
  const start = dayOf(daysAgo(daysBack));
  const draft = CampaignDraftFromSpec(spec, {
    ...partial,
    name: names,
    schedule: partial.schedule ?? scheduleFor(start, spec.recommended.validityDays),
    /* what the customer is told, on every channel the goal recommends */
    communication: partial.communication ?? {
      push: { title: names, body: names },
      banner: { text: names },
      sms: { text: names },
      sendTime: 'ON_ISSUE',
      frequencyCap: 'THREE_PER_WEEK',
      quietHours: true,
      respectConsent: true,
    },
  });
  const forecast = forecastCampaign(draft, {
    customersMatched: between(800, 6000),
    redemptionRatePct: between(8, 30),
    avgOrderSar: between(55, 95),
  });
  const created = iso(daysAgo(daysBack + 2));
  const decided = ['approved', 'live', 'paused', 'ended', 'rejected'].includes(status);
  return {
    ...draft,
    id: `CMP-${String(1000 + n)}`,
    status,
    createdBy,
    createdAt: created,
    updatedAt: created,
    approval: {
      requestedBy: status === 'draft' ? null : createdBy,
      requestedAt: status === 'draft' ? null : iso(daysAgo(daysBack + 1)),
      decidedBy: decided ? USERS.manager : null,
      decidedAt: decided ? iso(daysAgo(daysBack)) : null,
      note:
        status === 'rejected'
          ? 'Discount too deep for this segment; try 25%.'
          : decided
            ? 'Approved within budget.'
            : null,
    },
    snapshot: decided && status !== 'rejected' ? forecast : null,
    changeLog: [{ at: created, by: createdBy, what: 'created' }],
  };
}

/** A whole-day schedule of `days` from `start`, the coupon living as long as the campaign. */
export function scheduleFor(start: string, days: number): CampaignDraft['schedule'] {
  return {
    startDate: start,
    endDate: plusDays(start, days),
    allDay: true,
    timeWindow: {},
    onlyDuringBranchHours: false,
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    expiresAfterIssueDays: Math.min(365, Math.max(1, days)),
    limitedTime: { enabled: false },
  };
}

/**
 * A complete draft from a goal's recommended set-up plus overrides. Every
 * field the design has is present: what the goal does not set gets the
 * schema's default (readCampaignDraft), so the form never meets a hole.
 */
export function CampaignDraftFromSpec(
  spec: (typeof OBJECTIVE_CATALOGUE)[number],
  over: Partial<CampaignDraft> & {
    name: CampaignDraft['name'];
    schedule: CampaignDraft['schedule'];
  },
): CampaignDraft {
  const base = {
    objective: spec.key,
    name: over.name,
    tenantId: 'yiji',
    funding: { source: 'YIJI_MARKETING', partnerSharePct: 0 },
    offer: {
      onRefund: 'RETURN_IF_VALID',
      onCancelBeforeCompletion: 'REISSUE_IF_VALID',
      ...spec.recommended.offer,
    },
    experiment: { enabled: false, splitPctA: 50, winnerMetric: 'PROFIT', autoWinnerAfterDays: 7 },
    trigger: {},
    audience: {
      mode: spec.recommended.audience.mode,
      conditions: spec.recommended.audience.conditions,
      match: 'ALL',
      phoneNumbers: [],
      visibility: 'TARGETED',
      controlGroupPct: 10,
      excludeDiscountSensitive: true,
    },
    rules: {
      minOrderSar: spec.recommended.minOrderSar,
      maxOrderSar: 0,
      previousOrders: 'ANY',
      firstOrderOnly: spec.key === 'FIRST_ORDER',
      paymentMethods: ['MADA', 'CARD', 'APPLE_PAY', 'CASH', 'WALLET'],
      binRanges: [],
    },
    scope: {
      allBrands: true,
      brandIds: [],
      branchIds: [],
      categoryIds: [],
      productIds: [],
      excludedProductIds: [],
      orderTypes: ['DELIVERY', 'PICKUP', 'CARHOP'],
    },
    limits: {
      perCustomerMode: 'ONE',
      totalRedemptions: 3000,
      dailyRedemptions: 0,
      budgetSar: 20_000,
    },
    distribution: {
      codeType: 'NONE',
      channels: spec.recommended.channels,
      addMode: 'AUTO_WALLET',
      issueMode: 'ALL_AT_ONCE',
    },
    stacking: {
      combineWithOtherOffers: false,
      combineWithLoyalty: true,
      combineWithOtherCoupons: false,
    },
    /* the design: mandatory for first-order and new-customer coupons */
    fraud: { onePerPhoneAndDevice: firstOrderCoupon({ objective: spec.key }) },
    /* a stamp card needs a way to earn: five orders, the design's default */
    ...(spec.key === 'FREQUENT_ORDER' ? { loyalty: { type: 'STAMP', ordersRequired: 5 } } : {}),
    schedule: over.schedule,
  } as unknown as CampaignDraft;
  return readCampaignDraft({
    ...base,
    ...over,
    offer: { ...base.offer, ...(over.offer ?? {}) },
  });
}

function seed(): Stored {
  const campaigns: Campaign[] = [
    seedCampaign(
      1,
      {
        objective: 'FIRST_ORDER',
        offer: {
          type: 'PERCENT',
          percent: 40,
          maxDiscountSar: 25,
          onRefund: 'RETURN_IF_VALID',
          onCancelBeforeCompletion: 'REISSUE_IF_VALID',
        },
      },
      'live',
      USERS.ayman,
      20,
      { en: 'Welcome - 40% off first order', ar: 'ترحيب - خصم 40% على أول طلب' },
    ),
    seedCampaign(
      2,
      {
        objective: 'REPEAT_PURCHASE',
        offer: {
          type: 'FIXED',
          amountSar: 7,
          onRefund: 'RETURN_IF_VALID',
          onCancelBeforeCompletion: 'REISSUE_IF_VALID',
        },
      },
      'live',
      USERS.ayman,
      35,
      { en: 'Second order - SAR 7 off', ar: 'الطلب الثاني - خصم 7 ريال' },
    ),
    seedCampaign(
      3,
      {
        objective: 'LAPSED_REACTIVATION',
        offer: {
          type: 'FIXED',
          amountSar: 10,
          onRefund: 'RETURN_IF_VALID',
          onCancelBeforeCompletion: 'REISSUE_IF_VALID',
        },
      },
      'live',
      USERS.fahad,
      12,
      { en: 'Come back - SAR 10 off', ar: 'عُد إلينا - خصم 10 ريال' },
    ),
    seedCampaign(
      4,
      {
        objective: 'DELIVERY',
        offer: {
          type: 'FREE_DELIVERY',
          deliveryFeeCoveredSar: 'FULL',
          onRefund: 'RETURN_IF_VALID',
          onCancelBeforeCompletion: 'REISSUE_IF_VALID',
        },
        rules: {
          minOrderSar: 60,
          maxOrderSar: 0,
          previousOrders: 'ANY',
          firstOrderOnly: false,
          paymentMethods: ['MADA', 'CARD', 'APPLE_PAY', 'CASH', 'WALLET'],
          binRanges: [],
        },
      },
      'live',
      USERS.ayman,
      25,
      { en: 'Free delivery above SAR 60', ar: 'توصيل مجاني فوق 60 ريال' },
    ),
    seedCampaign(
      5,
      {
        objective: 'OCCASION',
        offer: {
          type: 'FIXED',
          amountSar: 15,
          onRefund: 'RETURN_IF_VALID',
          onCancelBeforeCompletion: 'REISSUE_IF_VALID',
        },
        trigger: {
          birthday: {
            occasion: 'BIRTHDAY',
            issueDaysBefore: 3,
            missingDateOfBirth: 'ASK',
            tierBoost: { enabled: true, extraSar: 10 },
          },
        },
      },
      'live',
      USERS.fahad,
      60,
      { en: 'Birthday gift - SAR 15 off', ar: 'هدية عيد ميلاد - خصم 15 ريال' },
    ),
    seedCampaign(
      6,
      {
        objective: 'FREQUENT_ORDER',
        offer: {
          type: 'FREE_ITEM',
          amountSar: 28,
          freeItem: { productId: 'CA-019', quantity: 1 },
          onRefund: 'RETURN_IF_VALID',
          onCancelBeforeCompletion: 'REISSUE_IF_VALID',
        },
        notes: 'Reward: Free Chicken Pasta',
        loyalty: {
          type: 'STAMP',
          ordersRequired: 5,
          stampExpiryDays: 60,
          milestones: ['5', '10', '25'],
          minOrderToCountSar: 30,
          countOrdersFrom: 'THIS_BRAND',
          repeat: true,
          progressMessages: true,
        },
        scope: {
          allBrands: false,
          brandIds: ['casapasta'],
          branchIds: [],
          categoryIds: [],
          productIds: [],
          excludedProductIds: [],
          orderTypes: ['DELIVERY', 'PICKUP', 'CARHOP'],
        },
      },
      'live',
      USERS.ayman,
      45,
      {
        en: 'CasaPasta stamp card - 5th order free pasta',
        ar: 'بطاقة كازا باستا - الطلب الخامس باستا مجانية',
      },
    ),
    seedCampaign(
      7,
      {
        objective: 'NEW_BRANCH',
        offer: {
          type: 'PERCENT',
          percent: 20,
          maxDiscountSar: 25,
          onRefund: 'RETURN_IF_VALID',
          onCancelBeforeCompletion: 'REISSUE_IF_VALID',
        },
      },
      'ended',
      USERS.fahad,
      50,
      { en: 'National Day 23-hour flash', ar: 'عرض اليوم الوطني 23 ساعة' },
    ),
    seedCampaign(
      8,
      {
        objective: 'LOYALTY_REWARD',
        offer: {
          type: 'FREE_ITEM',
          amountSar: 24,
          freeItem: { productId: 'CN-003', quantity: 1 },
          onRefund: 'RETURN_IF_VALID',
          onCancelBeforeCompletion: 'REISSUE_IF_VALID',
        },
        limits: {
          perCustomerMode: 'ONE',
          totalRedemptions: 1650,
          dailyRedemptions: 0,
          budgetSar: 30_000,
        },
      },
      'waiting_approval',
      USERS.ayman,
      2,
      { en: 'VIP - free Chick N Dip tiramisu', ar: 'كبار العملاء - تيراميسو مجاني' },
    ),
    seedCampaign(
      9,
      {
        objective: 'SLOW_HOURS',
        offer: {
          type: 'PERCENT',
          percent: 15,
          maxDiscountSar: 15,
          onRefund: 'RETURN_IF_VALID',
          onCancelBeforeCompletion: 'REISSUE_IF_VALID',
        },
        schedule: {
          ...scheduleFor(dayOf(daysAgo(3)), 30),
          allDay: false,
          timeWindow: { from: '14:00', to: '17:00' },
          daysOfWeek: [0, 1, 2, 3, 4],
        },
      },
      'draft',
      USERS.ayman,
      3,
      { en: 'Okashi lunch push', ar: 'دفعة غداء أوكاشي' },
    ),
    seedCampaign(
      10,
      {
        objective: 'MIN_ORDER_VALUE',
        offer: {
          type: 'FIXED',
          amountSar: 10,
          onRefund: 'RETURN_IF_VALID',
          onCancelBeforeCompletion: 'REISSUE_IF_VALID',
        },
      },
      'finance_review',
      USERS.fahad,
      4,
      { en: 'Weekend family bundle', ar: 'باقة العائلة لنهاية الأسبوع' },
    ),
    seedCampaign(
      11,
      {
        objective: 'PICKUP',
        offer: {
          type: 'FIXED',
          amountSar: 5,
          onRefund: 'RETURN_IF_VALID',
          onCancelBeforeCompletion: 'REISSUE_IF_VALID',
        },
      },
      'rejected',
      USERS.ayman,
      15,
      { en: 'Pickup Tuesdays', ar: 'استلام الثلاثاء' },
    ),
    seedCampaign(
      12,
      {
        objective: 'SERVICE_RECOVERY',
        offer: {
          type: 'FIXED',
          amountSar: 20,
          onRefund: 'RETURN_IF_VALID',
          onCancelBeforeCompletion: 'REISSUE_IF_VALID',
        },
        audience: {
          mode: 'LIST',
          conditions: [],
          match: 'ALL',
          phoneNumbers: [],
          listId: 'list-recovery-oct',
          visibility: 'TARGETED',
          controlGroupPct: 0,
          excludeDiscountSensitive: false,
        },
      },
      'paused',
      USERS.fahad,
      30,
      { en: 'October apologies', ar: 'اعتذارات أكتوبر' },
    ),
  ];
  const studies: Study[] = [
    makeStudy('STU-2611-0004', 'Okashi lunch push', 'draft', 'SLOW_HOURS', USERS.ayman, 3, null),
    makeStudy(
      'STU-2611-0003',
      'Weekend family bundle',
      'finance_review',
      'MIN_ORDER_VALUE',
      USERS.fahad,
      5,
      null,
    ),
    makeStudy(
      'STU-2610-0001',
      'Second order - SAR 7 off',
      'running',
      'REPEAT_PURCHASE',
      USERS.ayman,
      40,
      'CMP-1002',
    ),
    makeStudy(
      'STU-2609-0002',
      'National Day flash',
      'finished',
      'NEW_BRANCH',
      USERS.fahad,
      55,
      'CMP-1007',
    ),
  ];
  const giftProducts: GiftCardProduct[] = [50, 100, 200, 500].map((v, i) => ({
    id: `GC-${v}`,
    name: { en: `Gift card SAR ${v}`, ar: `بطاقة هدية ${v} ريال` },
    valueSar: v,
    priceSar: v,
    validityDays: 365,
    design: {
      background: ['#1d1b3a', '#2a1a4a', '#0f3b3a', '#3a1f1f'][i]!,
      accent: BRANDS[i]!.colour!,
      message: 'Enjoy a meal on us',
    },
    active: true,
    canCombineWithCoupons: false,
  }));
  const earningRules: EarningRule[] = [
    {
      id: 'ER-1',
      name: 'Standard cashback',
      cashbackPct: { DELIVERY: 5, PICKUP: 8, CARHOP: 10, DINE_IN: 5 },
      brandIds: [],
      active: true,
      validFrom: '2026-01-01',
      validTo: null,
    },
    {
      id: 'ER-2',
      name: 'Okashi launch boost',
      cashbackPct: { DELIVERY: 10, PICKUP: 12, CARHOP: 12, DINE_IN: 10 },
      brandIds: ['okashi'],
      active: true,
      validFrom: '2026-10-01',
      validTo: '2026-12-31',
    },
  ];
  return { campaigns, studies, giftProducts, earningRules };
}

function makeStudy(
  id: string,
  name: string,
  stage: Study['stage'],
  objective: Study['objective'],
  by: string,
  daysBack: number,
  campaignId: string | null,
): Study {
  const spec = objectiveSpec(objective);
  const start = dayOf(daysAgo(daysBack));
  const scenarios = [20, 30, 45].map((rate, i) => {
    const draft = CampaignDraftFromSpec(spec, {
      name: { en: `${name} - option ${i + 1}`, ar: `${name} - خيار ${i + 1}` },
      schedule: scheduleFor(start, spec.recommended.validityDays),
      offer:
        i === 0
          ? spec.recommended.offer
          : i === 1
            ? {
                ...spec.recommended.offer,
                ...(spec.recommended.offer.type === 'FIXED'
                  ? { amountSar: (spec.recommended.offer.amountSar ?? 10) + 3 }
                  : { percent: (spec.recommended.offer.percent ?? 20) + 5 }),
              }
            : {
                ...spec.recommended.offer,
                ...(spec.recommended.offer.type === 'FIXED'
                  ? { amountSar: (spec.recommended.offer.amountSar ?? 10) + 8 }
                  : { percent: (spec.recommended.offer.percent ?? 20) + 15 }),
              },
    } as Partial<CampaignDraft> & {
      name: CampaignDraft['name'];
      schedule: CampaignDraft['schedule'];
    });
    const input = { customersMatched: 2400 + i * 300, redemptionRatePct: rate, avgOrderSar: 67 };
    return {
      id: `${id}-s${i + 1}`,
      label: ['Cautious', 'Balanced', 'Aggressive'][i]!,
      draft,
      input,
      forecast: forecastCampaign(draft, input),
    };
  });
  return {
    id,
    name,
    stage,
    objective,
    createdBy: by,
    createdAt: iso(daysAgo(daysBack)),
    period: { from: dayOf(daysAgo(daysBack + 180)), to: dayOf(daysAgo(daysBack)) },
    data: {
      rowsRead: 50_447,
      completedOrders: 48_892,
      notCompleted: 1_555,
      brands: 4,
      cities: 6,
      customers: 8_939,
      revenueSar: 3_270_231,
    },
    scenarios,
    chosenScenarioId: stage === 'draft' ? null : `${id}-s2`,
    review:
      stage === 'draft'
        ? { by: null, at: null, note: null }
        : {
            by: 'finance',
            at: iso(daysAgo(daysBack - 1)),
            note: 'Assumptions checked against October actuals.',
          },
    approval: {
      requestedBy: stage === 'draft' ? null : by,
      requestedAt: stage === 'draft' ? null : iso(daysAgo(daysBack - 1)),
      decidedBy: ['approved', 'running', 'finished'].includes(stage) ? USERS.manager : null,
      decidedAt: ['approved', 'running', 'finished'].includes(stage)
        ? iso(daysAgo(daysBack - 2))
        : null,
      note: null,
    },
    campaignId,
  };
}

function load(): Stored {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORE_KEY) : null;
    if (raw) return upgradeStored(JSON.parse(raw) as Stored);
  } catch {
    /* a damaged store is replaced */
  }
  const fresh = seed();
  save(fresh);
  return fresh;
}
/**
 * A browser store written by an earlier build holds drafts in the shape
 * before field parity (`validity`, `stampsRequired`, ...): read them in
 * today's shape, the same way the CRM's engine reads its rows.
 */
function upgradeStored(s: Stored): Stored {
  return {
    ...s,
    campaigns: (s.campaigns ?? []).map((c) => ({ ...c, ...readCampaignDraft(c) })),
    studies: (s.studies ?? []).map((st) => ({
      ...st,
      scenarios: (st.scenarios ?? []).map((x) => ({ ...x, draft: readCampaignDraft(x.draft) })),
    })),
  };
}
function save(s: Stored): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* private window: in memory only */
  }
}
/** "Restore sample campaigns" (Ayman's prototype button). */
export function resetSampleEngine(): void {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* nothing to remove */
  }
}

/* ── performance numbers, derived (never stored) ────────────────────────── */

function performanceOf(c: Campaign): CampaignPerformance {
  const seed = rng(Number(c.id.replace(/\D/g, '')) + 7);
  const ageDays = Math.max(
    1,
    Math.min(60, Math.round((Date.now() - Date.parse(c.schedule.startDate)) / 86_400_000)),
  );
  const live = c.status === 'live' || c.status === 'ended' || c.status === 'paused';
  if (!live) {
    return {
      campaignId: c.id,
      issued: 0,
      redeemed: 0,
      revenueSar: 0,
      discountSar: 0,
      extraOrders: 0,
      extraProfitSar: 0,
      roiPct: 0,
      controlGroup: null,
      perDay: [],
      plan: c.snapshot,
    };
  }
  const perDay = Array.from({ length: ageDays }, (_, i) => {
    const day = plusDays(c.schedule.startDate, i);
    const issued = Math.round(60 + seed() * 140);
    const redeemed = Math.round(issued * (0.12 + seed() * 0.25));
    return { day, issued, redeemed, revenueSar: Math.round(redeemed * (55 + seed() * 40)) };
  });
  const issued = perDay.reduce((s, d) => s + d.issued, 0);
  const redeemed = perDay.reduce((s, d) => s + d.redeemed, 0);
  const revenueSar = perDay.reduce((s, d) => s + d.revenueSar, 0);
  const avg = redeemed ? revenueSar / redeemed : 0;
  const discountSar = Math.round(
    redeemed * Math.min(avg * 0.2, c.offer.amountSar ?? c.offer.maxDiscountSar ?? 15),
  );
  const control = {
    size: Math.round(issued * 0.1),
    orderRatePct: 21 + Math.round(seed() * 6),
    exposedOrderRatePct: 0,
  };
  control.exposedOrderRatePct = control.orderRatePct + 6 + Math.round(seed() * 14);
  const extraOrders = Math.round(
    redeemed * ((control.exposedOrderRatePct - control.orderRatePct) / control.exposedOrderRatePct),
  );
  const margin =
    1 -
    (DEFAULT_MONEY_MODEL.foodCostPct +
      DEFAULT_MONEY_MODEL.packagingPct +
      DEFAULT_MONEY_MODEL.channelCostPct.DELIVERY) /
      100;
  const extraProfitSar = Math.round(extraOrders * avg * margin);
  const roiPct = discountSar ? Math.round(((extraProfitSar - discountSar) / discountSar) * 100) : 0;
  return {
    campaignId: c.id,
    issued,
    redeemed,
    revenueSar,
    discountSar,
    extraOrders,
    extraProfitSar,
    roiPct,
    controlGroup: control,
    perDay,
    plan: c.snapshot,
  };
}

/* ── the engine ──────────────────────────────────────────────────────────── */

const wait = (ms = 120) => new Promise((res) => setTimeout(res, ms));

export class SampleMarketingEngine implements MarketingEngine {
  readonly kind = 'sample' as const;
  private store: Stored;
  constructor(private readonly currentUser: () => string) {
    this.store = load();
  }
  private commit() {
    save(this.store);
  }

  async home(): Promise<HomeSummary> {
    await wait();
    const cs = this.store.campaigns;
    const perf = cs.map(performanceOf);
    const live = cs.filter((c) => c.status === 'live');
    const gift = await this.giftCardStats({ from: dayOf(daysAgo(30)), to: dayOf(new Date()) });
    const rewards = await this.rewardsStats();
    const alerts: HomeSummary['alerts'] = [];
    for (const c of live) {
      const p = performanceOf(c);
      if (p.plan && p.roiPct < p.plan.roiPct * 0.8)
        alerts.push({
          id: `roi-${c.id}`,
          area: 'performance',
          title: `ROI below target - ${c.name.en}`,
          body: `${p.roiPct}% vs target ${p.plan.roiPct}%.`,
          severity: 'warning',
        });
      if (p.discountSar > c.limits.budgetSar * 0.85)
        alerts.push({
          id: `budget-${c.id}`,
          area: 'coupons',
          title: `Budget nearly used - ${c.name.en}`,
          body: `SAR ${p.discountSar.toLocaleString()} of SAR ${c.limits.budgetSar.toLocaleString()}.`,
          severity: 'warning',
        });
    }
    if (gift.expiringSoon.cards)
      alerts.push({
        id: 'gift-expiring',
        area: 'gift_cards',
        title: `Gift card balances expiring in ${gift.expiringSoon.withinDays} days`,
        body: `${gift.expiringSoon.cards} cards, SAR ${gift.expiringSoon.valueSar.toLocaleString()} unused.`,
        severity: 'info',
      });
    alerts.push({
      id: 'points-liability',
      area: 'rewards',
      title: 'Points liability is rising',
      body: `Outstanding points grew 10% last month to ${rewards.outstandingPoints.toLocaleString()} points.`,
      severity: 'info',
    });
    return {
      asOf: iso(new Date()),
      coupons: {
        live: live.length,
        redeemed: perf.reduce((s, p) => s + p.redeemed, 0),
        discountSar: perf.reduce((s, p) => s + p.discountSar, 0),
        waitingApproval: cs.filter((c) => c.status === 'waiting_approval').length,
      },
      studies: {
        total: this.store.studies.length,
        inReview: this.store.studies.filter(
          (s) => s.stage === 'finance_review' || s.stage === 'waiting_approval',
        ).length,
        readyToLaunch: this.store.studies.filter((s) => s.stage === 'approved').length,
      },
      performance: {
        extraSalesSar: perf.reduce((s, p) => s + p.revenueSar, 0),
        roiPct: Math.round(
          perf.filter((p) => p.redeemed).reduce((s, p, _, a) => s + p.roiPct / a.length, 0),
        ),
        campaignsMeasured: perf.filter((p) => p.redeemed).length,
        alerts: alerts.length,
      },
      giftCards: { cards: gift.sold, soldSar: gift.salesSar, outstandingSar: gift.outstandingSar },
      rewards: {
        activeMembers: rewards.activeMembers,
        pointsIssued: rewards.issuedPoints6m,
        repeatRatePct: 68,
      },
      alerts,
    };
  }
  async catalogue(): Promise<EngineCatalogue> {
    await wait(40);
    return CATALOGUE;
  }
  async moneyModel(): Promise<MoneyModel> {
    return DEFAULT_MONEY_MODEL;
  }
  async listCampaigns(
    filter: { status?: CampaignStatus | 'all'; objective?: CampaignDraft['objective'] } = {},
  ): Promise<Campaign[]> {
    await wait();
    return this.store.campaigns
      .filter((c) => !filter.status || filter.status === 'all' || c.status === filter.status)
      .filter((c) => !filter.objective || c.objective === filter.objective)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getCampaign(id: string): Promise<Campaign | null> {
    await wait(40);
    return this.store.campaigns.find((c) => c.id === id) ?? null;
  }
  async saveCampaign(draft: CampaignDraft, id?: string): Promise<Campaign> {
    await wait();
    const now = iso(new Date());
    const me = this.currentUser();
    /* The engine's rules, not the page's: the same refusals as the CRM's engine. */
    const taken = campaignUniquenessConflicts(draft, id, this.store.campaigns);
    if (taken.length) throw new Error(`already used by another campaign: ${taken.join(', ')}`);
    const bundle = bundlePriceProblem(draft.offer, CATALOGUE.products);
    if (bundle) throw new Error(bundle);
    if (id) {
      const i = this.store.campaigns.findIndex((c) => c.id === id);
      if (i < 0) throw new Error('campaign not found');
      const prev = this.store.campaigns[i]!;
      /* LOCKED WHEN LIVE: once customers hold the coupon the discount, the
         audience, the code, the rules and the start date cannot change. */
      const changed = lockedFieldChanges(prev, draft);
      if (changed.length) throw new Error(`locked while live: ${changed.join(', ')}`);
      const next: Campaign = {
        ...prev,
        ...draft,
        updatedAt: now,
        changeLog: [...prev.changeLog, { at: now, by: me, what: 'edited' }],
      };
      this.store.campaigns[i] = next;
      this.commit();
      return next;
    }
    const n = 1000 + this.store.campaigns.length + 1;
    const c: Campaign = {
      ...draft,
      id: `CMP-${n}`,
      status: 'draft',
      createdBy: me,
      createdAt: now,
      updatedAt: now,
      approval: {
        requestedBy: null,
        requestedAt: null,
        decidedBy: null,
        decidedAt: null,
        note: null,
      },
      snapshot: null,
      changeLog: [{ at: now, by: me, what: 'created' }],
    };
    this.store.campaigns.unshift(c);
    this.commit();
    return c;
  }
  async submitForApproval(id: string, forecast: CampaignForecast): Promise<Campaign> {
    const c = await this.mutate(
      id,
      (x) => ({
        ...x,
        status: 'waiting_approval',
        snapshot: forecast,
        approval: { ...x.approval, requestedBy: this.currentUser(), requestedAt: iso(new Date()) },
      }),
      'sent for approval',
    );
    return c;
  }
  async decideCampaign(
    id: string,
    decision: 'approve' | 'reject',
    note: string,
  ): Promise<Campaign> {
    /* THE ENGINE'S RULES, not the page's: the creator never decides their own
       campaign and only one waiting for approval can be decided - the live
       engine refuses the same way (403 / 409), so the sample must too. */
    const existing = this.store.campaigns.find((c) => c.id === id);
    if (!existing) throw new Error('campaign not found');
    const gate = canApproveCampaign(existing, this.currentUser());
    if (!gate.ok)
      throw new Error(
        gate.reason === 'own'
          ? 'the creator cannot decide their own campaign'
          : 'the campaign is not waiting for approval',
      );
    return this.mutate(
      id,
      (x) => ({
        ...x,
        status: decision === 'approve' ? 'approved' : 'rejected',
        approval: {
          ...x.approval,
          decidedBy: this.currentUser(),
          decidedAt: iso(new Date()),
          note,
        },
      }),
      decision === 'approve' ? 'approved' : 'rejected',
    );
  }
  async setCampaignStatus(id: string, status: 'live' | 'paused' | 'ended'): Promise<Campaign> {
    return this.mutate(id, (x) => ({ ...x, status }), status);
  }
  private async mutate(id: string, fn: (c: Campaign) => Campaign, what: string): Promise<Campaign> {
    await wait();
    const i = this.store.campaigns.findIndex((c) => c.id === id);
    if (i < 0) throw new Error('campaign not found');
    const now = iso(new Date());
    const next = fn(this.store.campaigns[i]!);
    next.updatedAt = now;
    next.changeLog = [...next.changeLog, { at: now, by: this.currentUser(), what }];
    this.store.campaigns[i] = next;
    this.commit();
    return next;
  }
  async issue(campaignId: string, customerIds: string[]): Promise<IssuanceResult> {
    await wait(300);
    const skipped = customerIds
      .filter((_, i) => i % 23 === 0)
      .map((customerId) => ({ customerId, reason: 'already holds this coupon' }));
    return {
      batchId: `BATCH-${Date.now().toString(36)}`,
      requested: customerIds.length,
      issued: customerIds.length - skipped.length,
      skipped,
    };
  }
  async performance(campaignId: string): Promise<CampaignPerformance> {
    await wait();
    const c = this.store.campaigns.find((x) => x.id === campaignId);
    if (!c) throw new Error('campaign not found');
    return performanceOf(c);
  }
  async redemptions(campaignId: string, limit = 50): Promise<Redemption[]> {
    await wait();
    const seed = rng(Number(campaignId.replace(/\D/g, '')) + 99);
    return Array.from({ length: limit }, (_, i) => ({
      id: `RED-${campaignId}-${i + 1}`,
      campaignId,
      customerId: `u-${Math.floor(seed() * 9000) + 1000}`,
      orderId: String(1_380_000 + Math.floor(seed() * 20_000)),
      branchId: CATALOGUE.branches[Math.floor(seed() * CATALOGUE.branches.length)]!.id,
      amountSar: Math.round(5 + seed() * 20),
      at: iso(new Date(Date.now() - seed() * 20 * 86_400_000)),
      reversed: seed() < 0.03,
    })).sort((a, b) => b.at.localeCompare(a.at));
  }
  async liability(): Promise<Liability> {
    await wait();
    const live = this.store.campaigns.filter((c) => c.status === 'live');
    const coupons = live.reduce(
      (s, c) => s + (c.limits.budgetSar - performanceOf(c).discountSar),
      0,
    );
    const by: Liability['byProduct'] = [
      {
        product: 'coupons',
        faceValueSar: coupons,
        atCostSar: Math.round(coupons * 0.36),
        count: live.length,
      },
      { product: 'compensation', faceValueSar: 18_420, atCostSar: 6_631, count: 412 },
      { product: 'gift_cards', faceValueSar: 6_711, atCostSar: 2_416, count: 86 },
      { product: 'points', faceValueSar: 2_027_505, atCostSar: 729_900, count: 21_400 },
    ];
    return {
      asOf: iso(new Date()),
      byProduct: by,
      totalFaceValueSar: by.reduce((s, x) => s + x.faceValueSar, 0),
    };
  }
  async giftCardProducts(): Promise<GiftCardProduct[]> {
    await wait(40);
    return this.store.giftProducts;
  }
  async saveGiftCardProduct(p: Omit<GiftCardProduct, 'id'>, id?: string): Promise<GiftCardProduct> {
    await wait();
    if (id) {
      const i = this.store.giftProducts.findIndex((x) => x.id === id);
      if (i < 0) throw new Error('gift card product not found');
      this.store.giftProducts[i] = { ...p, id };
      this.commit();
      return this.store.giftProducts[i]!;
    }
    const next = { ...p, id: `GC-${Date.now().toString(36).toUpperCase()}` };
    this.store.giftProducts.push(next);
    this.commit();
    return next;
  }
  async giftCardStats(range: { from: string; to: string }): Promise<GiftCardStats> {
    await wait();
    const seed = rng(Date.parse(range.from) / 86_400_000);
    const days = Math.max(
      1,
      Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1,
    );
    const perDay = Array.from({ length: Math.min(days, 60) }, (_, i) => ({
      day: plusDays(range.from, i),
      salesSar: Math.round(seed() * 400),
      redeemedSar: Math.round(seed() * 350),
    }));
    const salesSar = perDay.reduce((s, d) => s + d.salesSar, 0);
    const redeemedSar = perDay.reduce((s, d) => s + d.redeemedSar, 0);
    const sold = Math.max(1, Math.round(salesSar / 75));
    return {
      sold,
      salesSar,
      redeemedSar,
      redemptions: Math.round(redeemedSar / 34),
      outstandingSar: 6_711,
      activeCards: 86,
      unusedCards: 44,
      unusedSar: 4_682,
      sentAsGift: Math.round(sold * 0.67),
      boughtForSelf: sold - Math.round(sold * 0.67),
      perDay,
      expiringSoon: { cards: 15, valueSar: 392, withinDays: 30 },
    };
  }
  async giftCardActivity(limit = 40): Promise<GiftCardActivity[]> {
    await wait();
    const seed = rng(4242);
    const kinds: GiftCardActivity['kind'][] = [
      'sold',
      'sold',
      'redeemed',
      'redeemed',
      'redeemed',
      'expired',
      'refunded',
    ];
    return Array.from({ length: limit }, (_, i) => ({
      id: `GCA-${i + 1}`,
      at: iso(new Date(Date.now() - seed() * 30 * 86_400_000)),
      kind: kinds[Math.floor(seed() * kinds.length)]!,
      cardId: `GC-${String(1000 + Math.floor(seed() * 900))}`,
      amountSar: [50, 100, 200][Math.floor(seed() * 3)]!,
      customer: `+9665${String(Math.floor(seed() * 1e8)).padStart(8, '0')}`,
    })).sort((a, b) => b.at.localeCompare(a.at));
  }
  async earningRules(): Promise<EarningRule[]> {
    await wait(40);
    return this.store.earningRules;
  }
  async saveEarningRule(rule: Omit<EarningRule, 'id'>, id?: string): Promise<EarningRule> {
    await wait();
    if (id) {
      const i = this.store.earningRules.findIndex((x) => x.id === id);
      if (i < 0) throw new Error('rule not found');
      this.store.earningRules[i] = { ...rule, id };
      this.commit();
      return this.store.earningRules[i]!;
    }
    const next = { ...rule, id: `ER-${this.store.earningRules.length + 1}` };
    this.store.earningRules.push(next);
    this.commit();
    return next;
  }
  async rewardsCampaigns(): Promise<RewardsCampaign[]> {
    await wait(40);
    return [
      {
        id: 'RW-1',
        name: 'Welcome 500 points',
        kind: 'ACQUISITION',
        points: 500,
        budgetPoints: 2_000_000,
        usedPoints: 860_000,
        active: true,
      },
      {
        id: 'RW-2',
        name: 'Double points weekends',
        kind: 'RETENTION',
        points: 0,
        budgetPoints: 1_500_000,
        usedPoints: 1_215_000,
        active: true,
      },
      {
        id: 'RW-3',
        name: 'Birthday 250 points',
        kind: 'RETENTION',
        points: 250,
        budgetPoints: 600_000,
        usedPoints: 306_000,
        active: true,
      },
      {
        id: 'RW-4',
        name: 'We miss you - 300 points',
        kind: 'REACTIVATION',
        points: 300,
        budgetPoints: 900_000,
        usedPoints: 120_000,
        active: false,
      },
    ];
  }
  async rewardsItems(): Promise<RewardsItem[]> {
    await wait(40);
    const names = [
      'Free drink',
      'Free garlic bread',
      'SAR 10 off',
      'Free dessert',
      'Free delivery',
      'SAR 25 off',
      'Free pasta',
      'Family combo',
      'SAR 50 off',
      'Birthday cake',
      'Premium bento',
      'Chef table for two',
      'SAR 100 off',
      'Platter for four',
      'Mystery box',
      'Annual VIP',
    ];
    return names.map((n, i) => ({
      id: `RI-${i + 1}`,
      name: { en: n, ar: n },
      pointsCost: (i + 1) * 250,
      costSar: (i + 1) * 4,
      premium: i >= 11,
      active: true,
      redeemed: between(40, 900),
    }));
  }
  async rewardsStats(): Promise<RewardsStats> {
    await wait();
    const months = ['Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov'];
    const perMonth = months.map((m, i) => ({
      month: m,
      issued: 2_600_000 + i * 240_000,
      redeemed: 900_000 + i * 180_000,
      expired: 120_000 + i * 15_000,
    }));
    return {
      outstandingPoints: 20_275_050,
      outstandingSar: 2_027_505,
      issuedPoints6m: 20_705_660,
      redeemedPoints6m: 9_209_479,
      expiredPoints6m: 1_021_131,
      realCostSar: 322_331,
      activeMembers: 21_400,
      redeemingMembers: 8_300,
      perMonth,
      expiringSoon: { points: 386_000, customers: 2_140, withinDays: 14 },
    };
  }
  async rewardsMembers(query = '', limit = 50): Promise<RewardsMember[]> {
    await wait();
    const seed = rng(777);
    const tiers: RewardsMember['tier'][] = ['BRONZE', 'BRONZE', 'SILVER', 'SILVER', 'GOLD', 'VIP'];
    const names = [
      'Sara',
      'Khalid',
      'Noura',
      'Fahad',
      'Lina',
      'Omar',
      'Reem',
      'Saad',
      'Hessa',
      'Turki',
    ];
    const all = Array.from({ length: 200 }, (_, i) => ({
      customerId: `u-${1000 + i}`,
      name: `${names[i % names.length]} ${['Al Harbi', 'Al Otaibi', 'Al Shehri', 'Al Qahtani', 'Al Mutairi'][i % 5]}`,
      phone: `+9665${String(10_000_000 + Math.floor(seed() * 89_999_999))}`,
      tier: tiers[Math.floor(seed() * tiers.length)]!,
      points: Math.round(seed() * 6000),
      earned12m: Math.round(seed() * 9000),
      redeemed12m: Math.round(seed() * 4000),
      lastOrderAt: iso(new Date(Date.now() - seed() * 60 * 86_400_000)),
    }));
    const q = query.trim().toLowerCase();
    return all
      .filter((m) => !q || m.name.toLowerCase().includes(q) || m.phone.includes(q))
      .slice(0, limit);
  }
  async ordersExport(range: { from: string; to: string }): Promise<OrdersExportRow[]> {
    await wait(400);
    const seed = rng(Date.parse(range.from) / 86_400_000 + 5);
    const days = Math.max(
      1,
      Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1,
    );
    const n = Math.min(5000, days * 40);
    return Array.from({ length: n }, (_, i) => {
      const branch = CATALOGUE.branches[Math.floor(seed() * CATALOGUE.branches.length)]!;
      const products = CATALOGUE.products.filter((p) => p.brandId === branch.brandId);
      const items = Array.from({ length: 1 + Math.floor(seed() * 3) }, () => {
        const p = products[Math.floor(seed() * products.length)]!;
        return { productId: p.id, qty: 1 + Math.floor(seed() * 2), priceSar: p.priceSar };
      });
      return {
        orderId: String(1_300_000 + i),
        customerId: `u-${1000 + Math.floor(seed() * 8939)}`,
        placedAt: iso(new Date(Date.parse(range.from) + seed() * days * 86_400_000)),
        brandId: branch.brandId,
        branchId: branch.id,
        city: branch.city,
        orderType: (['DELIVERY', 'DELIVERY', 'PICKUP', 'CARHOP'] as const)[Math.floor(seed() * 4)]!,
        totalSar: items.reduce((s, it) => s + it.qty * it.priceSar, 0),
        items,
        couponCode: seed() < 0.18 ? 'WELCOME40' : null,
        completed: seed() > 0.03,
      };
    });
  }
  async simulateCheckout(input: {
    campaignId: string;
    brandId: string;
    orderType: 'DELIVERY' | 'PICKUP' | 'CARHOP' | 'DINE_IN';
    subtotalSar: number;
    otherOffer: boolean;
    otherCoupon: boolean;
    loyalty: boolean;
  }): Promise<CheckoutSimulation> {
    await wait();
    const c = this.store.campaigns.find((x) => x.id === input.campaignId) ?? null;
    return simulateCampaignCheckout(c, input);
  }
  async listStudies(): Promise<Study[]> {
    await wait();
    return [...this.store.studies].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getStudy(id: string): Promise<Study | null> {
    await wait(40);
    return this.store.studies.find((s) => s.id === id) ?? null;
  }
  async saveStudy(study: Study): Promise<Study> {
    await wait();
    const i = this.store.studies.findIndex((s) => s.id === study.id);
    if (i >= 0) this.store.studies[i] = study;
    else this.store.studies.unshift(study);
    this.commit();
    return study;
  }
  async opportunities(range: { from: string; to: string }): Promise<Opportunity[]> {
    await wait(300);
    const seed = rng(Date.parse(range.from) / 86_400_000 + 11);
    return CAMPAIGN_OBJECTIVES.map((objective) => {
      const spec = objectiveSpec(objective);
      const customersMatched = Math.round(300 + seed() * 4500);
      const draft = CampaignDraftFromSpec(spec, {
        name: { en: objective, ar: objective },
        schedule: scheduleFor(range.to, spec.recommended.validityDays),
      });
      const f = forecastCampaign(draft, {
        customersMatched,
        redemptionRatePct: 12 + seed() * 25,
        avgOrderSar: 60 + seed() * 30,
      });
      return {
        objective,
        customersMatched,
        expectedReturnPct: f.roiPct,
        expectedNetSar: f.netSar,
        recommendedOfferText: `${spec.recommended.offer.type === 'PERCENT' ? `${spec.recommended.offer.percent}% off up to SAR ${spec.recommended.offer.maxDiscountSar}` : spec.recommended.offer.type === 'FIXED' ? `SAR ${spec.recommended.offer.amountSar} off` : spec.recommended.offer.type} · min. SAR ${spec.recommended.minOrderSar}`,
      };
    }).sort((a, b) => b.expectedNetSar - a.expectedNetSar);
  }
  async customerGroups(): Promise<CustomerGroup[]> {
    await wait();
    const total = 8_939;
    const groups: Array<[CustomerGroup['key'], number, CustomerGroup['goal']]> = [
      ['LOYAL', 1_420, 'LOYALTY_REWARD'],
      ['HIGH_VALUE', 610, 'RETENTION'],
      ['AT_RISK', 1_980, 'RETENTION'],
      ['LOST', 3_104, 'LAPSED_REACTIVATION'],
      ['NEW', 1_825, 'REPEAT_PURCHASE'],
    ];
    return groups.map(([key, customers, goal]) => ({
      key,
      customers,
      share: Math.round((customers / total) * 100),
      goal,
    }));
  }
}

export const SAMPLE_BRANDS = BRANDS;
export const SAMPLE_USERS = USERS;
export { pick, between };
