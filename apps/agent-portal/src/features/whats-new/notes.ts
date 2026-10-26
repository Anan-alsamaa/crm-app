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

/*
 * The copy speaks to the reader warmly, but every sentence is a fact about
 * this release: a slide's `art` names the little animated picture beside it
 * (packages/ui WhatsNewArt), and `outro` is the thank-you step at the end.
 */
export const AGENT_PORTAL_WHATS_NEW: WhatsNewRelease<AgentPortalAudience> = {
  version: WHATS_NEW_VERSION,
  audiences: {
    agent: {
      en: {
        headline: 'A fresh Sara CRM',
        sub: 'Same work you know, on a calmer screen. Here is what is new for you; it takes less than a minute.',
        audienceLabel: 'For WeCare Agents',
        slides: [
          {
            title: 'A new look, and nothing moved',
            body: 'Cleaner pages, the menu on a dark bar along the top, and roomier lists that are easier on the eyes. Everything you use is right where you left it.',
            tags: ['Inbox', 'Tickets', 'Late orders'],
            art: 'layout',
          },
          {
            title: 'Your reply box, tidied up',
            body: 'Reply and Internal note now sit in one row, next to Quick replies, Enhance and AI. The quick-replies language switch moved inside the quick-replies box, right where you need it.',
            tags: ['Inbox'],
            art: 'composer',
          },
          {
            title: 'AI that speaks your language',
            body: 'Switch AI assistance to Arabic and the summary or suggested reply comes back in Arabic. Enhance keeps Arabic text in Arabic, too.',
            tags: ['AI assistance', 'Enhance'],
            art: 'language',
          },
          {
            title: 'Out of your way in one click',
            body: 'AI, Quick replies and Enhance now close when you click anywhere outside them, or press Esc. Fewer clicks, more flow.',
            tags: ['Inbox'],
            art: 'dismiss',
          },
        ],
        outro: {
          title: 'You are all set',
          body: 'Thank you for taking such good care of our customers. To see this tour again, open the Aura help panel and choose What’s new.',
        },
      },
      ar: {
        headline: 'Sara CRM بحلّة جديدة',
        sub: 'العمل الذي تعرفه، على شاشة أهدأ. إليك ما الجديد لك، في أقل من دقيقة.',
        audienceLabel: 'لموظفي WeCare',
        slides: [
          {
            title: 'مظهر جديد، ولم يتغيّر مكان شيء',
            body: 'صفحات أنظف، والقائمة على شريط داكن في الأعلى، وقوائم أكثر اتساعًا وأريح للعين. وكل ما تستخدمه ما زال في مكانه المعتاد.',
            tags: ['صندوق الوارد', 'التذاكر', 'الطلبات المتأخرة'],
            art: 'layout',
          },
          {
            title: 'صندوق الرد، أكثر ترتيبًا',
            body: 'الرد والملاحظة الداخلية أصبحا في صف واحد، بجوار الردود السريعة والتحسين والذكاء الاصطناعي. ومفتاح لغة الردود السريعة انتقل إلى داخل نافذة الردود السريعة، حيث تحتاجه تمامًا.',
            tags: ['صندوق الوارد'],
            art: 'composer',
          },
          {
            title: 'ذكاء اصطناعي يتحدث لغتك',
            body: 'اختر العربية في المساعدة بالذكاء الاصطناعي ليأتيك الملخص أو الرد المقترح بالعربية. والتحسين أيضًا يُبقي النص العربي عربيًا.',
            tags: ['المساعدة بالذكاء الاصطناعي', 'التحسين'],
            art: 'language',
          },
          {
            title: 'تُغلق بنقرة واحدة',
            body: 'نوافذ الذكاء الاصطناعي والردود السريعة والتحسين تُغلق الآن عند النقر في أي مكان خارجها، أو بالضغط على Esc. نقرات أقل، وتركيز أكثر.',
            tags: ['صندوق الوارد'],
            art: 'dismiss',
          },
        ],
        outro: {
          title: 'كل شيء جاهز',
          body: 'شكرًا لاهتمامك الدائم بعملائنا. لمشاهدة هذه الجولة مرة أخرى، افتح لوحة المساعدة Aura واختر "ما الجديد".',
        },
      },
    },
    supervisor: {
      en: {
        headline: 'More control, less hunting',
        sub: 'Everything your agents got, plus the tools you asked for.',
        audienceLabel: 'For supervisors and WeCare admins',
        slides: [
          {
            title: 'Coupons, right from the ticket',
            body: 'On the ticket card, assign a coupon, or set it to Not compensated to take it back, from the CRM and from the customer’s Yiji app.',
            tags: ['Tickets', 'Coupons'],
            art: 'coupon',
          },
          {
            title: 'Late orders, made for the big screen',
            body: 'A live board with big times that turn from amber to red, most late first. Switch to Table whenever you need the full detail.',
            tags: ['Late orders', 'TV board'],
            art: 'board',
          },
          {
            title: 'Reports you read at a glance',
            body: 'Proper number cards, roomy tables, and the whole page scrolls together. Every export tells you how many rows it will download.',
            tags: ['Agent performance', 'Compensation'],
            art: 'reports',
          },
          {
            title: 'Alerts that keep up',
            body: 'When a customer edits a message, your new-chat alert updates with it, without ringing a second time.',
            tags: ['Alerts'],
            art: 'alert',
          },
        ],
        outro: {
          title: 'Your team is ready',
          body: 'Thank you for keeping the floor running. To see this tour again, open the Aura help panel and choose What’s new.',
        },
      },
      ar: {
        headline: 'تحكّم أكبر، وبحث أقل',
        sub: 'كل ما حصل عليه فريقك، مع الأدوات التي طلبتها.',
        audienceLabel: 'للمشرفين ومسؤولي WeCare',
        slides: [
          {
            title: 'القسائم من التذكرة مباشرة',
            body: 'من بطاقة التذكرة: أضف قسيمة، أو اجعلها "لم يتم التعويض" لاسترجاعها، من النظام ومن تطبيق Yiji لدى العميل.',
            tags: ['التذاكر', 'القسائم'],
            art: 'coupon',
          },
          {
            title: 'الطلبات المتأخرة على الشاشة الكبيرة',
            body: 'لوحة مباشرة بأوقات كبيرة تتحول من الكهرماني إلى الأحمر، مرتبة من الأكثر تأخرًا. انتقل إلى الجدول متى احتجت التفاصيل كاملة.',
            tags: ['الطلبات المتأخرة', 'لوحة العرض'],
            art: 'board',
          },
          {
            title: 'تقارير تقرؤها من نظرة',
            body: 'بطاقات أرقام واضحة، وجداول أوسع، والصفحة كلها تتمرر معًا. وكل تصدير يوضح لك عدد الصفوف التي سيتم تنزيلها.',
            tags: ['أداء الموظفين', 'التعويض'],
            art: 'reports',
          },
          {
            title: 'تنبيهات تواكب التعديل',
            body: 'عندما يعدّل العميل رسالته، يتحدّث تنبيه المحادثة الجديدة لديك معها، دون أن يرن مرة ثانية.',
            tags: ['التنبيهات'],
            art: 'alert',
          },
        ],
        outro: {
          title: 'فريقك جاهز',
          body: 'شكرًا لأنك تُبقي العمل يسير بسلاسة. لمشاهدة هذه الجولة مرة أخرى، افتح لوحة المساعدة Aura واختر "ما الجديد".',
        },
      },
    },
    owner: {
      en: {
        headline: 'The agent portal, refreshed',
        sub: 'What changed for your team here, and the tools you now have in it.',
        audienceLabel: 'For the Administrator',
        slides: [
          {
            title: 'One look, both portals',
            body: 'The agent portal now matches the admin console: the menu on a dark bar at the top, cleaner pages and roomier lists. Nothing moved.',
            tags: ['Inbox', 'Tickets', 'Late orders'],
            art: 'layout',
          },
          {
            title: 'A tidier reply box',
            body: 'Reply and Internal note sit in one row with Quick replies, Enhance and AI. These panels now close when you click anywhere outside them, or press Esc.',
            tags: ['Inbox'],
            art: 'composer',
          },
          {
            title: 'AI that speaks your language',
            body: 'Switch AI assistance to Arabic and the summary or suggested reply comes back in Arabic. Enhance keeps Arabic text in Arabic, too.',
            tags: ['AI assistance', 'Enhance'],
            art: 'language',
          },
          {
            title: 'Coupons, right from the ticket',
            body: 'On the ticket card, assign a coupon, or set it to Not compensated to take it back, from the CRM and from the customer’s Yiji app.',
            tags: ['Tickets', 'Coupons'],
            art: 'coupon',
          },
          {
            title: 'Late orders, made for the big screen',
            body: 'A live board with big times that turn from amber to red, most late first. Switch to Table whenever you need the full detail.',
            tags: ['Late orders', 'TV board'],
            art: 'board',
          },
        ],
        outro: {
          title: 'All live for your team',
          body: 'Everything here is now in their hands. To see this tour again, open the Aura help panel and choose What’s new.',
        },
      },
      ar: {
        headline: 'بوابة الموظفين بحلّة جديدة',
        sub: 'ما تغيّر لفريقك هنا، والأدوات المتاحة لك فيها الآن.',
        audienceLabel: 'لمدير النظام',
        slides: [
          {
            title: 'مظهر واحد للبوابتين',
            body: 'أصبحت بوابة الموظفين بمظهر لوحة الإدارة نفسه: القائمة على شريط داكن في الأعلى، وصفحات أنظف، وقوائم أكثر اتساعًا. ولم يتغيّر مكان أي شيء.',
            tags: ['صندوق الوارد', 'التذاكر', 'الطلبات المتأخرة'],
            art: 'layout',
          },
          {
            title: 'صندوق رد أكثر ترتيبًا',
            body: 'الرد والملاحظة الداخلية في صف واحد مع الردود السريعة والتحسين والذكاء الاصطناعي. وتُغلق هذه النوافذ الآن عند النقر في أي مكان خارجها، أو بالضغط على Esc.',
            tags: ['صندوق الوارد'],
            art: 'composer',
          },
          {
            title: 'ذكاء اصطناعي يتحدث لغتك',
            body: 'اختر العربية في المساعدة بالذكاء الاصطناعي ليأتيك الملخص أو الرد المقترح بالعربية. والتحسين أيضًا يُبقي النص العربي عربيًا.',
            tags: ['المساعدة بالذكاء الاصطناعي', 'التحسين'],
            art: 'language',
          },
          {
            title: 'القسائم من التذكرة مباشرة',
            body: 'من بطاقة التذكرة: أضف قسيمة، أو اجعلها "لم يتم التعويض" لاسترجاعها، من النظام ومن تطبيق Yiji لدى العميل.',
            tags: ['التذاكر', 'القسائم'],
            art: 'coupon',
          },
          {
            title: 'الطلبات المتأخرة على الشاشة الكبيرة',
            body: 'لوحة مباشرة بأوقات كبيرة تتحول من الكهرماني إلى الأحمر، مرتبة من الأكثر تأخرًا. انتقل إلى الجدول متى احتجت التفاصيل كاملة.',
            tags: ['الطلبات المتأخرة', 'لوحة العرض'],
            art: 'board',
          },
        ],
        outro: {
          title: 'كل شيء متاح لفريقك',
          body: 'كل ما رأيته هنا أصبح بين أيديهم الآن. لمشاهدة هذه الجولة مرة أخرى، افتح لوحة المساعدة Aura واختر "ما الجديد".',
        },
      },
    },
  },
};
