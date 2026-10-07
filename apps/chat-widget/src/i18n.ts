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
  /** The gateway refused this session's token — retrying cannot help. */
  cannotConnect: string;
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
  /** Auto-reply appended once when the customer messages while agents are offline. */
  offlineAutoReply: string;
  /** Delivery state of a message the customer sent (revealed on hold). */
  sendFailed: string;
  csatFailed: string;
  msgSending: string;
  msgSent: string;
  msgFailed: string;
  msgRetry: string;
  msgDelete: string;
  /** A message was corrected after sending (EMA-33) — agent's or the customer's own. */
  msgEdited: string;
  /** Placeholder for a withdrawn message (EMA-33) — agent's or the customer's own. */
  msgDeleted: string;
  /*
   * The customer changing their OWN message (owner, 2026-10-07): select it,
   * then the pencil / trash icons, WhatsApp-style. Icons carry these as
   * aria-label + title so they are named for screen readers and on hover.
   */
  messageActions: string;
  editMessage: string;
  deleteMessage: string;
  /** Short confirm before a delete — it cannot be undone. */
  deleteConfirm: string;
  cancel: string;
  /** The bar above the composer while a message is being edited. */
  editingMessage: string;
  saveEdit: string;
  cancelEdit: string;
  /** The gateway refused an edit/delete because 15 minutes had passed. */
  editWindowClosed: string;
  /** Any other refused or failed edit/delete. */
  editFailed: string;
  offlineCallLabel: string;
  offlineWhatsappLabel: string;
  /** The language switch: names the OTHER language, in that language. */
  switchLanguage: string;
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
    cannotConnect: 'We could not start this chat. Please reopen it from the app, or call us.',
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
    // {vendor} is the VENDOR the customer is talking to (e.g. "Yiji"), sent by
    // the gateway — never the CRM's own name.
    poweredBy: 'Powered by {vendor}',
    csatTitle: 'How was your experience?',
    csatSub: 'Your feedback helps us improve.',
    csatCommentPlaceholder: 'Anything else you want to share? (optional)',
    csatSubmit: 'Submit',
    csatThanks: 'Thanks for the feedback!',
    csatThanksSub: 'We appreciate you taking the time.',
    offlineTitle: 'Our agents are offline right now',
    /* Short on purpose: this sits above the composer, and every line it wraps
     * to is a line of the customer's screen it takes. It also leads with the
     * thing that is actually true — the message gets through — rather than
     * apologising and pointing at the phone. */
    /* Short enough not to wrap on a phone. It makes ONE promise — the message
     * gets through — and leaves the cards below to speak for themselves; their
     * labels already say what they are. It also does not repeat "we are
     * offline", which the header pill says: twice makes a routine closing time
     * feel like an incident. */
    offlineBody: "Leave a message and we'll reply as soon as we're back.",
    offlineAutoReply:
      "Thanks for your message — our team is offline right now. We've received it and will reply as soon as we're back online.",
    msgSending: 'Sending…',
    sendFailed: "That didn't send. Please try again.",
    csatFailed: "We couldn't save your rating. Please try again.",
    msgSent: 'Sent',
    msgFailed: 'Not sent',
    msgRetry: 'Try again',
    msgDelete: 'Delete',
    msgEdited: 'edited',
    msgDeleted: 'This message was deleted',
    messageActions: 'Message options',
    editMessage: 'Edit message',
    deleteMessage: 'Delete message',
    deleteConfirm: 'Delete this message for everyone?',
    cancel: 'Cancel',
    editingMessage: 'Editing message',
    saveEdit: 'Save changes',
    cancelEdit: 'Cancel editing',
    editWindowClosed: 'Messages can only be changed within 15 minutes of sending.',
    editFailed: "Couldn't change that message. Please try again.",
    offlineCallLabel: 'Call us',
    offlineWhatsappLabel: 'WhatsApp',
    switchLanguage: 'العربية',
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
    cannotConnect: 'تعذّر بدء المحادثة. يُرجى فتحها من التطبيق مرة أخرى أو الاتصال بنا.',
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
    poweredBy: 'مدعوم بواسطة {vendor}',
    csatTitle: 'كيف كانت تجربتك؟',
    csatSub: 'ملاحظاتك تساعدنا على التحسين.',
    csatCommentPlaceholder: 'هل ترغب بإضافة شيء؟ (اختياري)',
    csatSubmit: 'إرسال',
    csatThanks: 'شكرًا لك على ملاحظاتك!',
    csatThanksSub: 'نقدّر الوقت الذي خصصته.',
    offlineTitle: 'فريق الدعم غير متاح حاليًا',
    offlineBody: 'اترك رسالتك وسنرد فور عودتنا.',
    offlineAutoReply:
      'شكرًا لرسالتك — فريقنا غير متصل حاليًا. لقد استلمنا رسالتك وسنردّ عليك فور عودتنا.',
    msgSending: 'جارٍ الإرسال…',
    sendFailed: 'لم يتم الإرسال. حاول مرة أخرى.',
    csatFailed: 'تعذر حفظ تقييمك. حاول مرة أخرى.',
    msgSent: 'تم الإرسال',
    msgFailed: 'لم يتم الإرسال',
    msgRetry: 'إعادة المحاولة',
    msgDelete: 'حذف',
    msgEdited: 'معدّلة',
    msgDeleted: 'تم حذف هذه الرسالة',
    messageActions: 'خيارات الرسالة',
    editMessage: 'تعديل الرسالة',
    deleteMessage: 'حذف الرسالة',
    deleteConfirm: 'حذف هذه الرسالة لدى الجميع؟',
    cancel: 'إلغاء',
    editingMessage: 'جارٍ تعديل الرسالة',
    saveEdit: 'حفظ التعديل',
    cancelEdit: 'إلغاء التعديل',
    editWindowClosed: 'يمكن تعديل الرسائل أو حذفها خلال ١٥ دقيقة فقط من إرسالها.',
    editFailed: 'تعذّر تعديل الرسالة. حاول مرة أخرى.',
    offlineCallLabel: 'اتصل بنا',
    offlineWhatsappLabel: 'واتساب',
    switchLanguage: 'English',
  },
};

export function t(locale: WidgetLocale): WidgetStrings {
  return strings[locale] ?? strings.en;
}

export function isRtl(locale: WidgetLocale): boolean {
  return locale === 'ar';
}
