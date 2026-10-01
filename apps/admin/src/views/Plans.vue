<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, errorText } from '../api.js'
import { formatTime } from '../format.js'
import {
  FEATURE_OPTIONS, PLAN_CODE_RE, buildVersionBody, describeEntitlements, formatMoney, latestVersion, versionToForm,
} from '../ops.js'
import { can } from '../permissions.js'
import { me } from '../session.js'

const plans = ref([])
const loading = ref(false)
const canEdit = computed(() => can(me.value, 'billing:plans'))

const dialog = ref(false)
const saving = ref(false)
const target = ref(null) // null = 新建套餐；否则为套餐条目（新增版本）
const form = reactive({ code: '', name: '', ...versionToForm(null) })

async function load() {
  loading.value = true
  try {
    plans.value = await api.listPlans()
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    loading.value = false
  }
}

function openCreate() {
  target.value = null
  Object.assign(form, { code: '', name: '', ...versionToForm(null), watermark: false, maxDevices: 3, exportMaxHeight: 2160 })
  dialog.value = true
}

function openVersion(entry) {
  target.value = entry
  Object.assign(form, { code: entry.plan.code, name: entry.plan.name, ...versionToForm(latestVersion(entry)) })
  dialog.value = true
}

async function save() {
  if (!target.value) {
    if (!PLAN_CODE_RE.test(form.code)) return ElMessage.warning('套餐代码需以小写字母开头，只含小写字母、数字、- 与 _（2–30 位）')
    if (!form.name.trim()) return ElMessage.warning('请填写套餐名称')
  }
  const built = buildVersionBody(form)
  if (built.error) return ElMessage.warning(built.error)
  try {
    await ElMessageBox.confirm(
      target.value
        ? '新增价格版本后，之后的新订单按新价格与权益；已下的订单仍按下单时的版本，不受影响。确认发布？'
        : '确认创建套餐？',
      target.value ? '发布新版本' : '新建套餐',
      { type: 'warning' },
    )
  } catch {
    return
  }
  saving.value = true
  try {
    if (target.value) await api.addPlanVersion(form.code, built.body)
    else await api.createPlan({ code: form.code, name: form.name.trim(), ...built.body })
    dialog.value = false
    ElMessage.success('已保存')
    await load()
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    saving.value = false
  }
}

async function toggle(entry) {
  const enabled = !entry.plan.enabled
  try {
    await ElMessageBox.confirm(enabled ? `启用套餐 ${entry.plan.name}？` : `停用套餐 ${entry.plan.name}？停用后官网与客户端不再展示，已购用户不受影响。`, enabled ? '启用' : '停用', { type: 'warning' })
    await api.setPlanEnabled(entry.plan.code, enabled)
    await load()
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(errorText(e))
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <h2 class="page-title">套餐与价格版本</h2>
    <div class="toolbar">
      <el-button type="primary" :disabled="!canEdit" @click="openCreate">新建套餐</el-button>
      <el-button @click="load">刷新</el-button>
      <span class="muted">改价或改权益 = 新增一个版本；价格留空表示该周期不可购买。{{ canEdit ? '' : '你的角色只能查看。' }}</span>
    </div>

    <div v-for="entry in plans" :key="entry.plan.id" v-loading="loading" class="section">
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px">
        <h3 style="margin: 0">{{ entry.plan.name }} <span class="mono muted">{{ entry.plan.code }}</span></h3>
        <el-tag :type="entry.plan.enabled ? 'success' : 'info'" size="small">{{ entry.plan.enabled ? '已启用' : '已停用' }}</el-tag>
        <span style="flex: 1" />
        <el-button :disabled="!canEdit" @click="openVersion(entry)">新增版本（改价/权益）</el-button>
        <el-button :disabled="!canEdit" @click="toggle(entry)">{{ entry.plan.enabled ? '停用' : '启用' }}</el-button>
      </div>
      <el-table :data="[...entry.versions].reverse()" size="small" border>
        <el-table-column label="版本" width="80"><template #default="{ row, $index }">v{{ row.version }}<el-tag v-if="$index === 0" size="small" style="margin-left: 6px">当前</el-tag></template></el-table-column>
        <el-table-column label="月付" width="100"><template #default="{ row }">{{ row.priceMonthCents === null ? '不可购买' : formatMoney(row.priceMonthCents) }}</template></el-table-column>
        <el-table-column label="年付" width="100"><template #default="{ row }">{{ row.priceYearCents === null ? '不可购买' : formatMoney(row.priceYearCents) }}</template></el-table-column>
        <el-table-column label="权益" min-width="260"><template #default="{ row }">{{ describeEntitlements(row.entitlements) }}</template></el-table-column>
        <el-table-column label="功能" min-width="200"><template #default="{ row }"><span class="mono">{{ row.entitlements.features.join(', ') }}</span></template></el-table-column>
        <el-table-column label="发布时间" width="160"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
      </el-table>
    </div>
    <p v-if="!plans.length && !loading" class="muted">暂无套餐。</p>

    <el-dialog v-model="dialog" :title="target ? `新增版本：${form.name}` : '新建套餐'" width="520px">
      <el-form label-width="110px">
        <template v-if="!target">
          <el-form-item label="套餐代码"><el-input v-model="form.code" placeholder="如 team" maxlength="30" /></el-form-item>
          <el-form-item label="套餐名称"><el-input v-model="form.name" maxlength="60" /></el-form-item>
        </template>
        <el-form-item label="月付价（元）"><el-input v-model="form.priceMonth" placeholder="留空 = 不可购买" /></el-form-item>
        <el-form-item label="年付价（元）"><el-input v-model="form.priceYear" placeholder="留空 = 不可购买" /></el-form-item>
        <el-form-item label="设备数上限"><el-input-number v-model="form.maxDevices" :min="1" :max="100" /></el-form-item>
        <el-form-item label="导出最大高度"><el-input-number v-model="form.exportMaxHeight" :min="144" :max="8640" :step="360" /> <span class="muted">　像素</span></el-form-item>
        <el-form-item label="导出水印"><el-switch v-model="form.watermark" /></el-form-item>
        <el-form-item label="功能">
          <el-checkbox-group v-model="form.features"><el-checkbox v-for="f in FEATURE_OPTIONS" :key="f" :value="f">{{ f }}</el-checkbox></el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">发布</el-button>
      </template>
    </el-dialog>
  </div>
</template>
