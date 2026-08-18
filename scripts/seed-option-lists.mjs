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
    'Accuracy', 'Cleanness', 'Driver attitude', 'Foreign object found', 'Hospitality',
    'Instore preparation late order', 'Late order', 'Missing condiments', 'Missing item',
    'Product', 'Roach found', 'Technical issue', 'Wrong order', 'Other',
  ],
  service_type: ['Delivery', 'Dinning', 'Drive Thru', 'Pickup', 'TakeOut'],
  complaint_source: [
    'WeCare Channels', 'Comp. WhatsApp', 'Comp. Phone Call', 'Comp.Instgram', 'Comp. Twiter',
    'AFCO APP', 'Call Center', 'Google Review',
  ],
  communication_method: ['Comp. WhatsApp', 'Comp. Phone Call', 'Comp.Instgram', 'Comp. Twiter'],
  compensation: ['Initial', 'Compensated', 'Not Compensated'],
  // The coupon-request dropdowns. "All" means every delivery channel at once.
  issuing_side: ['Marketing', 'Operations', 'Delivery'],
  delivery_type: ['All', 'Delivery', 'Pickup', 'Carhop', 'Takeout', 'Dine-in'],
  coupon_type: ['Private', 'Public'],
  discount_category: ['Amount', 'Percentage'],
};

const SETTINGS = {
  whatsapp_template:
    'مرحباً عزيزي، معك خدمة عملاء تطبيق يجي، تواصلنا بخصوص شكواكم على الطلب رقم {order}',
};

const login = await fetch(`${D}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: process.env.DIRECTUS_ADMIN_EMAIL, password: process.env.DIRECTUS_ADMIN_PASSWORD }),
});
const AT = (await login.json()).data.access_token;
const H = { authorization: `Bearer ${AT}`, 'content-type': 'application/json' };
const get = async (p) => (await (await fetch(`${D}${p}`, { headers: H })).json()).data ?? [];
const post = (p, body) => fetch(`${D}${p}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

let created = 0, skipped = 0;
const existing = await get('/items/option_lists?fields=list,value&limit=-1');
const have = new Set(existing.map((r) => `${r.list}|${r.value}`));
for (const [list, values] of Object.entries(LISTS)) {
  for (let i = 0; i < values.length; i++) {
    if (have.has(`${list}|${values[i]}`)) { skipped++; continue; }
    if (WRITE) await post('/items/option_lists', { list, value: values[i], sort: i, active: true });
    created++;
  }
}
console.log(`option_lists: ${created} to create, ${skipped} already present${WRITE ? ' (written)' : ' (dry run)'}`);

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
  { name: 'Admin', description: 'Full business access (code-defined; edit in directus/bootstrap/src/roles.ts).' },
  { name: 'Agent', description: 'Scoped support agent (code-defined; edit in directus/bootstrap/src/roles.ts).' },
];
const roles = await get('/items/app_roles?fields=name&limit=-1');
const haveRoles = new Set(roles.map((r) => r.name));
for (const b of BUILTINS) {
  if (haveRoles.has(b.name)) continue;
  if (WRITE) await post('/items/app_roles', { ...b, builtin: true, privileges: null, brands: null });
  console.log(`app_roles builtin: ${b.name} ${WRITE ? 'written' : 'would write'}`);
}

// The standard four-role model (mirroring the ops portal's structure):
// Admin and Agent are code-defined above; Supervisor and Viewer are ordinary
// app_roles rows, materialized by the app-roles-sync extension and editable
// from the Roles page like any custom role. Privilege keys come from the
// extension's fixed catalog — an unknown key is stripped, never invented.
const STANDARD_ROLES = [
  {
    name: 'Supervisor',
    description:
      'Team lead: works the whole inbox and every ticket, decides coupon approvals, reads every report. No user or master-data administration.',
    privileges: {
      use_chat: true, view_all_chats: true,
      view_tickets: true, view_all_tickets: true,
      create_tickets: true, edit_tickets: true, edit_all_tickets: true,
      approve_coupons: true,
      view_dashboard: true, export_data: true,
    },
  },
  {
    name: 'Viewer',
    description:
      'Read-only oversight: sees every chat, ticket, dashboard and report, and can export. Changes nothing.',
    privileges: {
      view_all_chats: true, view_tickets: true, view_all_tickets: true,
      view_dashboard: true, export_data: true,
    },
  },
];
for (const r of STANDARD_ROLES) {
  if (haveRoles.has(r.name)) continue;
  if (WRITE) await post('/items/app_roles', { ...r, builtin: false, brands: null });
  console.log(`app_roles standard: ${r.name} ${WRITE ? 'written' : 'would write'}`);
}
console.log('done');
