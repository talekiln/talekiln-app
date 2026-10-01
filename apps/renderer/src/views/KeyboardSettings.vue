<template>
  <div class="ks-page">
    <header class="ks-header">
      <el-button size="small" @click="$router.back()">
        <el-icon><ArrowLeft /></el-icon> 返回
      </el-button>
      <h1>快捷键设置</h1>
      <div class="ks-spacer" />
      <el-button size="small" @click="resetAll">全部恢复默认</el-button>
    </header>

    <el-alert
      v-if="conflicts.length"
      type="warning"
      :closable="false"
      show-icon
      :title="`存在 ${conflicts.length} 处快捷键冲突，冲突的按键只会触发排在前面的动作`"
    />

    <section v-for="g in groups" :key="g.scope" class="ks-group">
      <h2>{{ g.title }}</h2>
      <div v-for="a in g.actions" :key="a.id" class="ks-row">
        <span class="ks-label">{{ a.label }}</span>
        <span class="ks-keys">
          <el-tag
            v-for="c in keymap[a.id]"
            :key="c"
            closable
            :type="isConflict(a.id, c) ? 'danger' : 'info'"
            @close="removeKey(a.id, c)"
          >{{ formatCombo(c) }}</el-tag>
          <el-button v-if="recording !== a.id" size="small" text type="primary" @click="startRecord(a.id)">+ 添加</el-button>
          <el-tag v-else type="warning">请按下新的组合键… (Esc 取消)</el-tag>
        </span>
        <el-button size="small" text :disabled="!isCustom(a.id)" @click="resetAction(a.id)">恢复默认</el-button>
      </div>
    </section>
    <p class="ks-note">Ctrl + 滚轮：缩放时间线（固定手势，不可改）。分镜工作台快捷键已注册，处理逻辑随工作台上线。</p>
  </div>
</template>

<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowLeft } from '@element-plus/icons-vue'
import { useKeymap } from '@/composables/useKeymap'
import { eventToCombo, formatCombo, SCOPE_TIMELINE, SCOPE_WORKBENCH } from '@/utils/keymap'

const { actions, keymap, overrides, conflicts, setBinding, resetAction, resetAll, conflictsFor } = useKeymap()
const recording = ref(null)

const groups = computed(() => [
  { scope: SCOPE_TIMELINE, title: '时间线编辑', actions: actions.filter((a) => a.scope === SCOPE_TIMELINE) },
  { scope: SCOPE_WORKBENCH, title: '分镜工作台（AI）', actions: actions.filter((a) => a.scope === SCOPE_WORKBENCH) },
])

const conflictSet = computed(() => new Set(conflicts.value.flatMap((c) => c.actions.map((id) => `${id}|${c.combo}`))))
const isConflict = (id, combo) => conflictSet.value.has(`${id}|${combo}`)
const isCustom = (id) => !!overrides.value[id]

function removeKey(id, combo) {
  setBinding(id, keymap.value[id].filter((c) => c !== combo))
}

function onRecordKey(e) {
  const id = recording.value
  if (!id) return
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') return stopRecord()
  const combo = eventToCombo(e)
  if (!combo) return // 仅修饰键，继续等待
  if (keymap.value[id].includes(combo)) return stopRecord()
  const clash = conflictsFor(id, combo)
  setBinding(id, [...keymap.value[id], combo])
  if (clash.length) {
    const names = clash.map((c) => actions.find((a) => a.id === c)?.label).join('、')
    ElMessage.warning(`${formatCombo(combo)} 与「${names}」冲突，请调整其中一个`)
  }
  stopRecord()
}

function startRecord(id) {
  recording.value = id
  window.addEventListener('keydown', onRecordKey, true)
}

function stopRecord() {
  recording.value = null
  window.removeEventListener('keydown', onRecordKey, true)
}

onBeforeUnmount(stopRecord)
</script>

<style scoped>
.ks-page { max-width: 760px; margin: 0 auto; padding: 16px; color: var(--text-primary); }
.ks-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.ks-header h1 { margin: 0; font-size: 18px; color: var(--text-bright); }
.ks-spacer { flex: 1; }
.ks-group h2 { font-size: 14px; color: var(--text-muted); margin: 18px 0 6px; }
.ks-row { display: flex; align-items: center; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--border-color); }
.ks-label { flex: 0 0 220px; font-size: 13px; }
.ks-keys { flex: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.ks-note { margin-top: 16px; font-size: 12px; color: var(--text-subtle); }
</style>
