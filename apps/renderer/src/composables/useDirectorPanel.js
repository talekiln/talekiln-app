import { ref } from 'vue'

// 导演模式抽屉的开关（P3-D）：分镜表、分镜工作台的按钮与命令面板的「导演模式」都从这里打开；抽屉挂在 App.vue。
// directorEpisodeId：打开时指定的剧集（工作台等不在剧集路由上的页面需要显式给）；没有时抽屉按当前路由推断。
export const directorOpen = ref(false)
export const directorEpisodeId = ref(null)

export function openDirector(episodeId = null) {
  const n = Number(episodeId)
  directorEpisodeId.value = Number.isInteger(n) && n > 0 ? n : null
  directorOpen.value = true
}
export const closeDirector = () => { directorOpen.value = false }
