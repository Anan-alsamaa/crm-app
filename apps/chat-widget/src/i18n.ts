/** Tiny built-in i18n for the widget (keeps the bundle small; no i18next). */
export type WidgetLocale = 'en' | 'ar';

export interface WidgetStrings {
  title: string;
  greeting: string;
  subtitle: string;
  online: string;
  placeholder: string;
  send: string;
  typing: string;
  connecting: string;
  reconnecting: string;
  attach: string;
  close: string;
  /** Idle state when the conversation has no messages yet. */
  emptyTitle: string;
  emptySub: string;
  /** Footer attribution. */
  poweredBy: string;
  /** CSAT (post-close survey). */
  csatTitle: string;
  csatSub: string;
  csatCommentPlaceholder: string;
  csatSubmit: string;
  csatThanks: string;
  csatThanksSub: string;
  /** Agent-offline fallback shown when no agent is connected. */
  offlineTitle: string;
  offlineBody: string;
  offlineCallLabel: string;
  offlineEmailLabel: string;
}

const strings: Record<WidgetLocale, WidgetStrings> = {
  en: {
    title: 'Support',
    greeting: 'Hi there 👋',
    subtitle: 'How can we help today?',
    online: 'We are online',
    placeholder: 'Type a message…',
    send: 'Send',
    typing: 'Typing',
    connecting: 'Connecting…',
    reconnecting: 'Reconnecting…',
    attach: 'Attach file',
    close: 'Close',
    emptyTitle: 'Say hello to start the chat',
    emptySub: 'A real teammate will reply. Typical reply time is a few minutes.',
    poweredBy: 'Powered by YIJI CRM',
    csatTitle: 'How was your experience?',
    csatSub: 'Your feedback helps us improve.',
    csatCommentPlaceholder: 'Anything else you want to share? (optional)',
    csatSubmit: 'Submit',
    csatThanks: 'Thanks for the feedback!',
    csatThanksSub: 'We appreciate you taking the time.',
    offlineTitle: 'Our agents are offline right now',
    offlineBody:
      'Unfortunately, our agents are offline now. Please contact us directly and we will get back to you as soon as possible.',
    offlineCallLabel: 'Call us',
    offlineEmailLabel: 'Email us',
  },
  ar: {
    title: 'الدعم',
    greeting: 'مرحبًا 👋',
    subtitle: 'كيف يمكننا مساعدتك اليوم؟',
    online: 'نحن متاحون الآن',
    placeholder: 'اكتب رسالة…',
    send: 'إرسال',
    typing: 'يكتب',
    connecting: 'جارٍ الاتصال…',
    reconnecting: 'إعادة الاتصال…',
    attach: 'إرفاق ملف',
    close: 'إغلاق',
    emptyTitle: 'ابدأ المحادثة بقول مرحبًا',
    emptySub: 'سيردّ عليك أحد أعضاء الفريق. عادةً ما يستجيب خلال دقائق.',
    poweredBy: 'مدعوم بواسطة YIJI CRM',
    csatTitle: 'كيف كانت تجربتك؟',
    csatSub: 'ملاحظاتك تساعدنا على التحسين.',
    csatCommentPlaceholder: 'هل ترغب بإضافة شيء؟ (اختياري)',
    csatSubmit: 'إرسال',
    csatThanks: 'شكرًا لك على ملاحظاتك!',
    csatThanksSub: 'نقدّر الوقت الذي خصصته.',
    offlineTitle: 'فريق الدعم غير متاح حاليًا',
    offlineBody:
      'للأسف، وكلاؤنا غير متصلين في الوقت الحالي. يرجى التواصل معنا مباشرةً وسنعاود التواصل في أقرب وقت.',
    offlineCallLabel: 'اتصل بنا',
    offlineEmailLabel: 'راسلنا بالبريد',
  },
};

export function t(locale: WidgetLocale): WidgetStrings {
  return strings[locale] ?? strings.en;
}

export function isRtl(locale: WidgetLocale): boolean {
  return locale === 'ar';
}
