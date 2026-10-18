import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { messages as en } from './locales/en'
import { messages as zh } from './locales/zh'
import { messages as ja } from './locales/ja'
import { messages as zhHant } from './locales/zh-Hant'

const notificationLabels = {
  en: { dismiss: 'Dismiss', newsCount: '{{count}} news items' },
  zh: { dismiss: '关闭', newsCount: '{{count}} 条新闻' },
  ja: { dismiss: '閉じる', newsCount: '{{count}} 件のニュース' },
  'zh-Hant': { dismiss: '關閉', newsCount: '{{count}} 則新聞' },
}
const locale = navigator.language.startsWith('zh')
  ? /TW|HK|Hant/i.test(navigator.language) ? 'zh-Hant' : 'zh'
  : navigator.language.startsWith('ja') ? 'ja' : 'en'

export const i18n = i18next.createInstance()
void i18n.use(initReactI18next).init({
  lng: locale,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  resources: {
    en: { translation: { ...en, activityToast: notificationLabels.en } },
    zh: { translation: { ...zh, activityToast: notificationLabels.zh } },
    ja: { translation: { ...ja, activityToast: notificationLabels.ja } },
    'zh-Hant': { translation: { ...zhHant, activityToast: notificationLabels['zh-Hant'] } },
  },
})
