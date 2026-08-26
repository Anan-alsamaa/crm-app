/**
 * Seed `option_lists` from the code enums, the WhatsApp template into
 * `app_settings`, and the two display-only builtin rows into `app_roles`.
 *
 * Idempotent by (list, value) / key / name. Dry-run by default; --write applies.
 * The enums stay in the code as the FALLBACK the portals use when the
 * collection is unreadable — this seed is what makes the lists editable
 * without a deploy from then on.
 */
const D = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const WRITE = process.argv.includes('--write');

const LISTS = {
  complaint_type: [
    'Accuracy',
    'Cleanness',
    'Driver attitude',
    'Foreign object found',
    'Hospitality',
    'Instore preparation late order',
    'Late order',
    'Missing condiments',
    'Missing item',
    'Product',
    'Roach found',
    'Technical issue',
    'Wrong order',
    'Other',
  ],
  service_type: ['Delivery', 'Dinning', 'Drive Thru', 'Pickup', 'TakeOut'],
  complaint_source: [
    'WeCare Channels',
    'Comp. WhatsApp',
    'Comp. Phone Call',
    'Comp.Instgram',
    'Comp. Twiter',
    'AFCO APP',
    'Call Center',
    'Google Review',
  ],
  communication_method: ['Comp. WhatsApp', 'Comp. Phone Call', 'Comp.Instgram', 'Comp. Twiter'],
  compensation: ['Initial', 'Compensated', 'Not Compensated'],
  // The coupon-request dropdowns. "All" means every delivery channel at once.
  /* Who pays for a coupon. The delivery companies are named individually — a
     coupon issued because Shadh lost an order is not the same cost centre as
     one issued because Taker did. Prefixes and Yiji ids live beside these in
     ISSUING_SIDES (@yiji/shared-types); keep the two in step. */
  issuing_side: [
    'Customer Care',
    'Operations',
    'Marketing',
    'Shadh',
    'Taker',
    'Shurouq',
    'Leajlak',
    'Parcel',
  ],
  delivery_type: ['All', 'Delivery', 'Pickup', 'Carhop', 'Takeout', 'Dine-in'],
  // Which AI actions the inbox panel offers, in this order. Action KEYS, not
  // labels — the labels are translated and editing one in Arabic would switch
  // the button off for everyone reading English. Semantic search is absent on
  // purpose: agents search from the inbox's own search box, and a second
  // search that only found conversations was the odd one out on the panel.
  ai_action: ['summary', 'reply', 'intent', 'entities', 'sentiment'],
  coupon_type: ['Private', 'Public'],
  discount_category: ['Amount', 'Percentage'],
};

const SETTINGS = {
  whatsapp_template:
    'مرحباً عزيزي، معك خدمة عملاء تطبيق يجي، تواصلنا بخصوص شكواكم على الطلب رقم {order}',
};

const login = await fetch(`${D}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: process.env.DIRECTUS_ADMIN_EMAIL,
    password: process.env.DIRECTUS_ADMIN_PASSWORD,
  }),
});
const AT = (await login.json()).data.access_token;
const H = { authorization: `Bearer ${AT}`, 'content-type': 'application/json' };
const get = async (p) => (await (await fetch(`${D}${p}`, { headers: H })).json()).data ?? [];
const post = (p, body) =>
  fetch(`${D}${p}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

let created = 0,
  skipped = 0;
const existing = await get('/items/option_lists?fields=list,value&limit=-1');
const have = new Set(existing.map((r) => `${r.list}|${r.value}`));
for (const [list, values] of Object.entries(LISTS)) {
  for (let i = 0; i < values.length; i++) {
    if (have.has(`${list}|${values[i]}`)) {
      skipped++;
      continue;
    }
    if (WRITE) await post('/items/option_lists', { list, value: values[i], sort: i, active: true });
    created++;
  }
}
console.log(
  `option_lists: ${created} to create, ${skipped} already present${WRITE ? ' (written)' : ' (dry run)'}`,
);

const settings = await get('/items/app_settings?fields=key&limit=-1');
const haveKeys = new Set(settings.map((r) => r.key));
for (const [key, value] of Object.entries(SETTINGS)) {
  if (haveKeys.has(key)) continue;
  if (WRITE) await post('/items/app_settings', { key, value });
  console.log(`app_settings: ${key} ${WRITE ? 'written' : 'would write'}`);
}

// Display-only rows for the code-defined roles, so the Roles page shows the
// whole picture. builtin=true; the sync extension refuses to touch them.
const BUILTINS = [
  {
    name: 'Admin',
    description: 'Full business access (code-defined; edit in directus/bootstrap/src/roles.ts).',
  },
  {
    name: 'Agent',
    description: 'Scoped support agent (code-defined; edit in directus/bootstrap/src/roles.ts).',
  },
];
const roles = await get('/items/app_roles?fields=name&limit=-1');
const haveRoles = new Set(roles.map((r) => r.name));
for (const b of BUILTINS) {
  if (haveRoles.has(b.name)) continue;
  if (WRITE)
    await post('/items/app_roles', { ...b, builtin: true, privileges: null, brands: null });
  console.log(`app_roles builtin: ${b.name} ${WRITE ? 'written' : 'would write'}`);
}

// The standard role model, the way an operator of this size actually splits
// the work. Two axes: WHAT you may do (privileges) and HOW MUCH of the estate
// you may see (brand / branch fences, applied by the app-roles-sync extension).
//
//   Admin          — everything, code-defined (builtin above).
//   Supervisor     — runs the floor: all chats, all tickets, decides coupons.
//   Agent          — answers customers, code-defined (builtin above).
//   Viewer         — reads and exports, changes nothing.
//   Chain Manager  — a BRAND's whole estate: its tickets and reports, no
//                    inbox seat, cannot approve money.
//   Area Manager   — the same shape one level down, fenced to specific
//                    BRANCHES; ticking brands too narrows to the intersection.
//
// Both manager roles ship UNFENCED (brands/stores null = everything) because a
// fence is a per-appointment fact: this seed cannot know which brand or which
// branches a given manager owns. The Roles page is where that is set, and the
// description says so rather than leaving the widest possible reading to
// whoever opens the page first.
const STANDARD_ROLES = [
  {
    name: 'Supervisor',
    description:
      'Runs the floor: works the whole inbox and every ticket, decides coupon approvals, reads every report. No user or master-data administration.',
    privileges: {
      use_chat: true,
      view_all_chats: true,
      view_tickets: true,
      view_all_tickets: true,
      create_tickets: true,
      edit_tickets: true,
      edit_all_tickets: true,
      approve_coupons: true,
      view_dashboard: true,
      export_data: true,
    },
  },
  {
    name: 'Viewer',
    description:
      'Read-only oversight: sees every chat, ticket, dashboard and report, and can export. Changes nothing.',
    privileges: {
      view_all_chats: true,
      view_tickets: true,
      view_all_tickets: true,
      view_dashboard: true,
      export_data: true,
    },
  },
  {
    name: 'Chain Manager',
    description:
      "Owns a brand's whole estate — every ticket and report for it. Fence this role to that brand on this page; unfenced it sees all brands. No inbox seat and no coupon approval: the money decision stays with a supervisor.",
    privileges: {
      view_tickets: true,
      view_all_tickets: true,
      edit_all_tickets: true,
      view_dashboard: true,
      export_data: true,
    },
  },
  {
    name: 'Area Manager',
    description:
      'Owns specific restaurants rather than a whole brand. Fence this role to those branches (and optionally their brand) on this page; unfenced it sees everything. No inbox seat and no coupon approval.',
    privileges: {
      view_tickets: true,
      view_all_tickets: true,
      edit_all_tickets: true,
      view_dashboard: true,
      export_data: true,
    },
  },
];
for (const r of STANDARD_ROLES) {
  if (haveRoles.has(r.name)) continue;
  if (WRITE) await post('/items/app_roles', { ...r, builtin: false, brands: null, stores: null });
  console.log(`app_roles standard: ${r.name} ${WRITE ? 'written' : 'would write'}`);
}
console.log('done');
