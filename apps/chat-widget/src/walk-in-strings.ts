import type { WidgetLocale } from './i18n.js';

/**
 * The store QR page's own words.
 *
 * Separate from the widget's `i18n.ts` because this page is not the widget:
 * it ships in its own bundle and must not pull the chat in with it. Kept in
 * the same shape so the two read alike.
 */
export interface WalkInStrings {
  /** <title>, so the app's web view and the browser tab read right. */
  documentTitle: string;
  heading: string;
  sub: string;
  label: string;
  submit: string;
  submitBusy: string;
  foot: string;
  /** Names the OTHER language, in that language. */
  switchLanguage: string;
  errShort: string;
  errRateLimited: string;
  errLinkExpired: string;
  errRefused: string;
  errOffline: string;
}

const strings: Record<WidgetLocale, WalkInStrings> = {
  en: {
    documentTitle: 'Chat with us',
    heading: 'Something wrong with your order?',
    sub: 'Tell us the mobile number you order with and we will start a chat with our team.',
    label: 'Mobile number',
    submit: 'Start chat',
    submitBusy: 'Starting…',
    foot: 'We use your number only to connect this chat to your order history and to reply to you.',
    switchLanguage: 'العربية',
    errShort: 'Please enter the full mobile number — 05 and eight more digits.',
    errRateLimited: 'Too many attempts. Please wait a moment and try again.',
    errLinkExpired: 'This link has expired. Please enter your number to start a chat.',
    errRefused: 'We could not start the chat. Please check the number and try again.',
    errOffline: 'We could not reach support. Please check your connection.',
  },
  ar: {
    documentTitle: 'تحدّث معنا',
    heading: 'هل هناك مشكلة في طلبك؟',
    sub: 'أخبرنا برقم الجوال الذي تطلب به وسنبدأ محادثة مع فريقنا.',
    label: 'رقم الجوال',
    submit: 'ابدأ المحادثة',
    submitBusy: 'جارٍ البدء…',
    foot: 'نستخدم رقمك فقط لربط هذه المحادثة بسجل طلباتك وللرد عليك.',
    switchLanguage: 'English',
    errShort: 'يرجى إدخال رقم الجوال كاملًا — 05 وثمانية أرقام بعدها.',
    errRateLimited: 'محاولات كثيرة. يرجى الانتظار قليلًا ثم المحاولة مرة أخرى.',
    errLinkExpired: 'انتهت صلاحية هذا الرابط. يرجى إدخال رقمك لبدء المحادثة.',
    errRefused: 'تعذّر بدء المحادثة. يرجى التأكد من الرقم والمحاولة مرة أخرى.',
    errOffline: 'تعذّر الوصول إلى الدعم. يرجى التحقق من اتصالك.',
  },
};

export function walkInStrings(locale: WidgetLocale): WalkInStrings {
  return strings[locale] ?? strings.en;
}
