// 风格的显示名：custom 走 common.style.custom（跟随语言），预设走 styleOptions 的名字，未知值原样显示。
// 预设名本身是否本地化由 constants/styleOptions 决定，这里只做查找。
import { t } from '../i18n/index.js'
import { CUSTOM_STYLE_VALUE, getStyleLabel } from '../constants/styleOptions.js'

export function styleName(value) {
  const v = (value ?? '').toString().trim()
  if (!v) return ''
  if (v === CUSTOM_STYLE_VALUE) return t('common.style.custom')
  return getStyleLabel(v)
}
