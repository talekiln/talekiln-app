import { onMounted, ref } from 'vue'
import { aiAPI } from '@/api/ai'
import { getSelectableModels } from '@/utils/modelSelection'

// 资产出图用的图像模型列表与当前选择。模块级共享：面板、资产库页、详情共用一份，只请求一次。

const models = ref([])
const model = ref('')
let loading = null

function load() {
  if (!loading) {
    loading = aiAPI
      .list('image')
      .then((cfgs) => {
        models.value = getSelectableModels(cfgs, 'image')
        if (!model.value) model.value = models.value[0] || ''
      })
      .catch(() => {
        loading = null // 失败后下次再试；不阻塞页面
      })
  }
  return loading
}

export function useImageModels() {
  onMounted(load)
  return { models, model }
}
