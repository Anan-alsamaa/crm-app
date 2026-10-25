import type { WhatsNewRelease } from '@yiji/ui';

/**
 * WHAT'S NEW IN THE AGENT PORTAL — the one place its release notes live.
 *
 * The bundle carries no release version of its own (the tag lives in the
 * deploy's S3 `release.json`, which only the gateway reads), so the version
 * the tour belongs to is this constant. Bump it with new notes and everyone
 * in an audience sees the tour once more; leave an audience out and they see
 * nothing.
 *
 * Who is who (owner, 2026-10-25): see `agentPortalAudience`.
 */
export const WHATS_NEW_VERSION = '1.2.1';

export type AgentPortalAudience = 'agent' | 'supervisor' | 'owner';

/** Role names compared without case or spaces: "WeCare  agent" is WeCare Agent. */
function roleKey(roleName: string | null | undefined): string {
  return String(roleName ?? '')
    .toLowerCase()
    .replace(/\s+/g, '');
}

/**
 * Who sees the tour in THIS portal: WeCare Agent, WeCare Supervisor and
 * WeCare Admin, and the Administrator (the Directus owner). Nobody else.
 */
export function agentPortalAudience(
  roleName: string | null | undefined,
  isOwner: boolean,
): AgentPortalAudience | null {
  if (isOwner) return 'owner';
  const key = roleKey(roleName);
  if (key === 'wecareagent') return 'agent';
  if (key === 'wecaresupervisor' || key === 'wecareadmin') return 'supervisor';
  return null;
}

export const AGENT_PORTAL_WHATS_NEW: WhatsNewRelease<AgentPortalAudience> = {
  version: WHATS_NEW_VERSION,
  audiences: {
    agent: {
      en: {
        headline: 'A fresh Sara CRM',
        sub: 'Same work, a calmer screen. Here is what changed for you.',
        audienceLabel: 'For WeCare Agents',
        slides: [
          {
            title: 'A new look, everywhere',
            body: 'Cleaner pages, the menu on a dark bar at the top, and roomier lists. Everything you use is still where you expect it.',
            tags: ['Inbox', 'Tickets', 'Late orders'],
          },
          {
            title: 'A tidier reply box',
            body: 'Reply and Internal note sit in one row with Quick replies, Enhance and AI. The quick-replies language switch now lives inside the quick-replies box.',
            tags: ['Inbox'],
          },
          {
            title: 'AI speaks your language',
            body: 'Switch AI assistance to Arabic and the summary or suggested reply follows. Enhance keeps Arabic text in Arabic.',
            tags: ['AI assistance', 'Enhance'],
          },
          {
            title: 'Fewer clicks to close',
            body: 'AI, quick replies and Enhance close when you click anywhere outside them, or press Esc.',
            tags: ['Inbox'],
          },
        ],
      },
      ar: {
        headline: 'Sara CRM بحلّة جديدة',
        sub: 'العمل نفسه، وشاشة أهدأ. إليك ما تغيّر بالنسبة لك.',
        audienceLabel: 'لموظفي WeCare',
        slides: [
          {
            title: 'مظهر جديد في كل مكان',
            body: 'صفحات أنظف، والقائمة على شريط داكن في الأعلى، وقوائم أكثر اتساعًا. وكل ما تستخدمه ما زال في مكانه المعتاد.',
            tags: ['صندوق الوارد', 'التذاكر', 'الطلبات المتأخرة'],
          },
          {
            title: 'صندوق رد أكثر ترتيبًا',
            body: 'الرد والملاحظة الداخلية في صف واحد مع الردود السريعة والتحسين والذكاء الاصطناعي. ومفتاح لغة الردود السريعة أصبح داخل نافذة الردود السريعة نفسها.',
            tags: ['صندوق الوارد'],
          },
          {
            title: 'الذكاء الاصطناعي يتحدث لغتك',
            body: 'اختر العربية في المساعدة بالذكاء الاصطناعي ليأتي الملخص أو الرد المقترح بالعربية. والتحسين يُبقي النص العربي عربيًا.',
            tags: ['المساعدة بالذكاء الاصطناعي', 'التحسين'],
          },
          {
            title: 'نقرات أقل للإغلاق',
            body: 'تُغلق نوافذ الذكاء الاصطناعي والردود السريعة والتحسين عند النقر في أي مكان خارجها، أو بالضغط على Esc.',
            tags: ['صندوق الوارد'],
          },
        ],
      },
    },
    supervisor: {
      en: {
        headline: 'More control, less hunting',
        sub: 'Everything agents got, plus the tools you asked for.',
        audienceLabel: 'For supervisors and WeCare admins',
        slides: [
          {
            title: 'Assign or remove a coupon on a ticket',
            body: 'From the ticket card: assign a coupon, or set it to Not compensated to take it back, from the CRM and from the customer’s Yiji app.',
            tags: ['Tickets', 'Coupons'],
          },
          {
            title: 'Late orders, made for the wall',
            body: 'A live board with big times that turn from amber to red, sorted most late first. Switch to Table for the full detail.',
            tags: ['Late orders', 'TV board'],
          },
          {
            title: 'Clearer reports',
            body: 'Proper number cards, roomy tables, and the page scrolls as a whole. Exports always show how many rows they will download.',
            tags: ['Agent performance', 'Compensation'],
          },
          {
            title: 'Edits you can trust',
            body: 'When a customer edits a message, your new-chat alert updates too, without ringing again.',
            tags: ['Alerts'],
          },
        ],
      },
      ar: {
        headline: 'تحكّم أكبر، وبحث أقل',
        sub: 'كل ما حصل عليه الموظفون، مع الأدوات التي طلبتها.',
        audienceLabel: 'للمشرفين ومسؤولي WeCare',
        slides: [
          {
            title: 'إضافة قسيمة إلى تذكرة أو إزالتها',
            body: 'من بطاقة التذكرة: أضف قسيمة، أو اجعلها "لم يتم التعويض" لاسترجاعها، من النظام ومن تطبيق Yiji لدى العميل.',
            tags: ['التذاكر', 'القسائم'],
          },
          {
            title: 'الطلبات المتأخرة على شاشة العرض',
            body: 'لوحة مباشرة بأوقات كبيرة تتحول من الكهرماني إلى الأحمر، مرتبة من الأكثر تأخرًا. انتقل إلى الجدول لرؤية التفاصيل كاملة.',
            tags: ['الطلبات المتأخرة', 'لوحة العرض'],
          },
          {
            title: 'تقارير أوضح',
            body: 'بطاقات أرقام واضحة، وجداول أوسع، والصفحة تتمرر كاملة. ويعرض التصدير دائمًا عدد الصفوف التي سيتم تنزيلها.',
            tags: ['أداء الموظفين', 'التعويض'],
          },
          {
            title: 'تعديلات يمكنك الوثوق بها',
            body: 'عندما يعدّل العميل رسالته، يتحدّث تنبيه المحادثة الجديدة لديك أيضًا، دون أن يرن مرة أخرى.',
            tags: ['التنبيهات'],
          },
        ],
      },
    },
    owner: {
      en: {
        headline: 'The agent portal, refreshed',
        sub: 'What changed for your team here, and the tools you now have in it.',
        audienceLabel: 'For the Administrator',
        slides: [
          {
            title: 'A new look, everywhere',
            body: 'The agent portal now matches the admin console: the menu on a dark bar at the top, cleaner pages and roomier lists. Nothing moved.',
            tags: ['Inbox', 'Tickets', 'Late orders'],
          },
          {
            title: 'A tidier reply box',
            body: 'Reply and Internal note sit in one row with Quick replies, Enhance and AI. These panels now close when you click anywhere outside them, or press Esc.',
            tags: ['Inbox'],
          },
          {
            title: 'AI speaks your language',
            body: 'Switch AI assistance to Arabic and the summary or suggested reply follows. Enhance keeps Arabic text in Arabic.',
            tags: ['AI assistance', 'Enhance'],
          },
          {
            title: 'Assign or remove a coupon on a ticket',
            body: 'From the ticket card: assign a coupon, or set it to Not compensated to take it back, from the CRM and from the customer’s Yiji app.',
            tags: ['Tickets', 'Coupons'],
          },
          {
            title: 'Late orders, made for the wall',
            body: 'A live board with big times that turn from amber to red, sorted most late first. Switch to Table for the full detail.',
            tags: ['Late orders', 'TV board'],
          },
        ],
      },
      ar: {
        headline: 'بوابة الموظفين بحلّة جديدة',
        sub: 'ما تغيّر لفريقك هنا، والأدوات المتاحة لك فيها الآن.',
        audienceLabel: 'لمدير النظام',
        slides: [
          {
            title: 'مظهر جديد في كل مكان',
            body: 'أصبحت بوابة الموظفين بمظهر لوحة الإدارة نفسه: القائمة على شريط داكن في الأعلى، وصفحات أنظف، وقوائم أكثر اتساعًا. ولم يتغيّر مكان أي شيء.',
            tags: ['صندوق الوارد', 'التذاكر', 'الطلبات المتأخرة'],
          },
          {
            title: 'صندوق رد أكثر ترتيبًا',
            body: 'الرد والملاحظة الداخلية في صف واحد مع الردود السريعة والتحسين والذكاء الاصطناعي. وتُغلق هذه النوافذ الآن عند النقر في أي مكان خارجها، أو بالضغط على Esc.',
            tags: ['صندوق الوارد'],
          },
          {
            title: 'الذكاء الاصطناعي يتحدث لغتك',
            body: 'اختر العربية في المساعدة بالذكاء الاصطناعي ليأتي الملخص أو الرد المقترح بالعربية. والتحسين يُبقي النص العربي عربيًا.',
            tags: ['المساعدة بالذكاء الاصطناعي', 'التحسين'],
          },
          {
            title: 'إضافة قسيمة إلى تذكرة أو إزالتها',
            body: 'من بطاقة التذكرة: أضف قسيمة، أو اجعلها "لم يتم التعويض" لاسترجاعها، من النظام ومن تطبيق Yiji لدى العميل.',
            tags: ['التذاكر', 'القسائم'],
          },
          {
            title: 'الطلبات المتأخرة على شاشة العرض',
            body: 'لوحة مباشرة بأوقات كبيرة تتحول من الكهرماني إلى الأحمر، مرتبة من الأكثر تأخرًا. انتقل إلى الجدول لرؤية التفاصيل كاملة.',
            tags: ['الطلبات المتأخرة', 'لوحة العرض'],
          },
        ],
      },
    },
  },
};
