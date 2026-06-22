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
  attachment: string;
  attachFailed: string;
  removeAttachment: string;
  download: string;
  close: string;
  /** Idle state when the conversation has no messages yet. */
  emptyTitle: string;
  emptySub: string;
  /** Returning-customer greeting; `{name}` is replaced with the customer name. */
  welcomeNamed: string;
  /** New-customer first greeting bubble (no name on record yet). */
  welcomeNew: string;
  /** Returning-customer header greeting (always visible); `{name}` → customer name. */
  greetingNamed: string;
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
  offlineWhatsappLabel: string;
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
    attachment: 'Attachment',
    attachFailed: 'Could not upload the file.',
    removeAttachment: 'Remove attachment',
    download: 'Download',
    close: 'Close',
    emptyTitle: 'Say hello to start the chat',
    emptySub: 'A real teammate will reply. Typical reply time is a few minutes.',
    welcomeNamed: 'Welcome {name}, how can we help you?',
    welcomeNew: 'Hey there 👋 How can we help you?',
    greetingNamed: 'Welcome back, {name} 👋',
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
    offlineWhatsappLabel: 'WhatsApp',
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
    attachment: 'مرفق',
    attachFailed: 'تعذّر رفع الملف.',
    removeAttachment: 'إزالة المرفق',
    download: 'تنزيل',
    close: 'إغلاق',
    emptyTitle: 'ابدأ المحادثة بقول مرحبًا',
    emptySub: 'سيردّ عليك أحد أعضاء الفريق. عادةً ما يستجيب خلال دقائق.',
    welcomeNamed: 'مرحبًا {name}، كيف يمكننا مساعدتك؟',
    welcomeNew: 'مرحبًا 👋 كيف يمكننا مساعدتك؟',
    greetingNamed: 'مرحبًا بعودتك، {name} 👋',
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
    offlineWhatsappLabel: 'واتساب',
    offlineEmailLabel: 'راسلنا بالبريد',
  },
};

export function t(locale: WidgetLocale): WidgetStrings {
  return strings[locale] ?? strings.en;
}

export function isRtl(locale: WidgetLocale): boolean {
  return locale === 'ar';
}
