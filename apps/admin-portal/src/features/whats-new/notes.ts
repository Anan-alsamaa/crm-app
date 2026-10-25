import type { WhatsNewRelease } from '@yiji/ui';

/**
 * WHAT'S NEW IN THE ADMIN PORTAL — the one place its release notes live.
 *
 * The bundle carries no release version of its own (the tag lives in the
 * deploy's S3 `release.json`, which only the gateway reads), so the version
 * the tour belongs to is this constant. Bump it with new notes and everyone
 * in an audience sees the tour once more; leave an audience out and they see
 * nothing. The agent portal keeps its own notes: each portal says what
 * changed in THAT portal, and "seen" is remembered per portal.
 */
export const WHATS_NEW_VERSION = '1.2.1';

export type AdminPortalAudience = 'supervisor' | 'owner';

/** Role names compared without case or spaces: "WeCare  admin" is WeCare Admin. */
function roleKey(roleName: string | null | undefined): string {
  return String(roleName ?? '')
    .toLowerCase()
    .replace(/\s+/g, '');
}

/**
 * Who sees the tour in THIS portal (owner, 2026-10-25): the Administrator
 * (`isOwner`), and WeCare Supervisor and WeCare Admin. Not WeCare Agent, and
 * nobody else.
 */
export function adminPortalAudience(
  roleName: string | null | undefined,
  isOwner: boolean,
): AdminPortalAudience | null {
  if (isOwner) return 'owner';
  const key = roleKey(roleName);
  if (key === 'wecaresupervisor' || key === 'wecareadmin') return 'supervisor';
  return null;
}

export const ADMIN_PORTAL_WHATS_NEW: WhatsNewRelease<AdminPortalAudience> = {
  version: WHATS_NEW_VERSION,
  audiences: {
    owner: {
      en: {
        headline: 'Your console, redesigned',
        sub: 'The admin portal and the agent portal now share one look.',
        audienceLabel: 'For the Administrator',
        slides: [
          {
            title: 'Admin KPI',
            body: 'A new owner-only page: chats, tickets, coupons, late orders and Yiji API usage, including every time the backup token was used, and why.',
            tags: ['Reports', 'Owner only'],
          },
          {
            title: 'Roles, as a settings page',
            body: 'Pick a role, then one area at a time. Hover an area to see its switches; Delete now sits next to Save.',
            tags: ['Roles & privileges'],
          },
          {
            title: 'Actions look like actions',
            body: 'Anything you can click is a soft filled pill; anything you cannot is clearly greyed out. Clear lights up only when a filter is applied.',
            tags: ['Every page'],
          },
          {
            title: 'Reports that breathe',
            body: 'Metric cards, roomy tables, page-level scrolling and one export button per report.',
            tags: ['Reports'],
          },
        ],
      },
      ar: {
        headline: 'لوحة الإدارة بتصميم جديد',
        sub: 'بوابة الإدارة وبوابة الموظفين أصبحتا بمظهر واحد.',
        audienceLabel: 'لمدير النظام',
        slides: [
          {
            title: 'مؤشرات الإدارة',
            body: 'صفحة جديدة لمالك النظام فقط: المحادثات والتذاكر والقسائم والطلبات المتأخرة واستخدام واجهة Yiji، بما في ذلك كل مرة استُخدم فيها الرمز الاحتياطي، وسبب ذلك.',
            tags: ['التقارير', 'للمالك فقط'],
          },
          {
            title: 'الأدوار كصفحة إعدادات',
            body: 'اختر دورًا، ثم مجالًا واحدًا في كل مرة. مرّر المؤشر فوق المجال لترى مفاتيحه؛ وأصبح زر الحذف بجوار زر الحفظ.',
            tags: ['الأدوار والصلاحيات'],
          },
          {
            title: 'الأزرار تبدو كأزرار',
            body: 'كل ما يمكنك النقر عليه زر ممتلئ بلون هادئ، وكل ما لا يمكنك النقر عليه باهت بوضوح. ولا يُضاء زر المسح إلا عند تطبيق عامل تصفية.',
            tags: ['كل الصفحات'],
          },
          {
            title: 'تقارير أكثر اتساعًا',
            body: 'بطاقات مؤشرات، وجداول أوسع، وتمرير للصفحة كاملة، وزر تصدير واحد لكل تقرير.',
            tags: ['التقارير'],
          },
        ],
      },
    },
    supervisor: {
      en: {
        headline: 'Reports that read faster',
        sub: 'The admin portal has a new look. Here is what changed in the pages you use.',
        audienceLabel: 'For supervisors and WeCare admins',
        slides: [
          {
            title: 'Reports that breathe',
            body: 'Proper metric cards at the top, roomy tables, and the whole page scrolls instead of a box inside it.',
            tags: ['Reports', 'Agent performance'],
          },
          {
            title: 'Coupon requests, clearly labelled',
            body: 'The reason an agent gave for a coupon now sits under a Description label, with its line breaks kept, so you read all of it before you decide.',
            tags: ['Coupon approvals'],
          },
          {
            title: 'Clear and Export, at a glance',
            body: 'Clear lights up only when a filter is applied, and every export button says how many rows it will download.',
            tags: ['Every report'],
          },
          {
            title: 'One response target',
            body: 'Agent performance no longer has an Answer within filter. Chats are scored against the standard five minutes, and the card says so.',
            tags: ['Agent performance'],
          },
        ],
      },
      ar: {
        headline: 'تقارير تُقرأ أسرع',
        sub: 'بوابة الإدارة بمظهر جديد. إليك ما تغيّر في الصفحات التي تستخدمها.',
        audienceLabel: 'للمشرفين ومسؤولي WeCare',
        slides: [
          {
            title: 'تقارير أكثر اتساعًا',
            body: 'بطاقات مؤشرات واضحة في الأعلى، وجداول أوسع، والصفحة كلها تتمرر بدلًا من صندوق داخلها.',
            tags: ['التقارير', 'أداء الموظفين'],
          },
          {
            title: 'طلبات القسائم بعناوين واضحة',
            body: 'السبب الذي كتبه الموظف لطلب القسيمة أصبح تحت عنوان "الوصف"، مع الحفاظ على فواصل الأسطر، لتقرأه كاملًا قبل أن تقرر.',
            tags: ['موافقات القسائم'],
          },
          {
            title: 'المسح والتصدير من نظرة واحدة',
            body: 'لا يُضاء زر المسح إلا عند تطبيق عامل تصفية، وكل زر تصدير يوضح عدد الصفوف التي سيتم تنزيلها.',
            tags: ['كل التقارير'],
          },
          {
            title: 'هدف رد واحد',
            body: 'لم يعد في أداء الموظفين عامل التصفية "الرد خلال". تُقيَّم المحادثات وفق الدقائق الخمس المعتمدة، والبطاقة توضح ذلك.',
            tags: ['أداء الموظفين'],
          },
        ],
      },
    },
  },
};
