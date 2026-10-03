// 画幅（宽高比）的显示名：16:9 -> “16:9 横屏（默认）”。未知比例原样显示。标签走 common.aspect.*。
import { t } from '../i18n/index.js'

export const ASPECTS = ['16:9', '9:16', '3:4', '1:1', '4:3', '21:9']

export const aspectLabel = (ratio) => (ASPECTS.includes(ratio) ? t(`common.aspect.${ratio}`) : String(ratio ?? ''))
