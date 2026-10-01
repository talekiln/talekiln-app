<template>
  <div class="spend-page">
    <header class="header">
      <div class="header-inner">
        <h1 class="logo" @click="goList">花费统计</h1>
        <el-radio-group v-model="preset" size="small" @change="reload">
          <el-radio-button v-for="p in RANGE_PRESETS" :key="p.key" :value="p.key">{{ p.label }}</el-radio-button>
        </el-radio-group>
        <el-button size="small" :loading="exporting" :disabled="!summary" @click="onExport">导出 CSV</el-button>
        <el-button class="btn-back" @click="goList">返回</el-button>
      </div>
    </header>

    <main v-loading="loading" class="main">
      <el-alert
        v-if="summary && summary.sample_prices"
        type="warning"
        :closable="false"
        show-icon
        title="当前价格表为示例价，费用仅为估算，不代表服务商实际账单。实际费用以服务商控制台为准。"
      />

      <section class="cards">
        <div class="card">
          <div class="card-label">所选范围合计</div>
          <div class="card-value" data-test="total">{{ money(summary?.total.cost ?? 0) }}</div>
          <div class="card-sub">{{ summary?.total.count ?? 0 }} 个已完成任务</div>
        </div>
        <div class="card">
          <div class="card-label">本月已用</div>
          <div class="card-value" data-test="month-spent">{{ money(summary?.month.spent ?? 0) }}</div>
          <div class="card-sub">在途最高 {{ money(summary?.month.in_flight_max ?? 0) }}</div>
        </div>
        <div class="card card-limit">
          <div class="card-label">月度上限</div>
          <div class="limit-row">
            <el-input v-model="capText" size="small" placeholder="留空 = 不限制" data-test="cap-input" @keyup.enter="saveCap">
              <template #prepend>¥</template>
            </el-input>
            <el-button size="small" type="primary" :loading="savingCap" @click="saveCap">保存</el-button>
          </div>
          <el-progress
            :percentage="progress.percent"
            :status="progress.level === 'danger' ? 'exception' : progress.level === 'warn' ? 'warning' : undefined"
            :show-text="false"
            :stroke-width="8"
          />
          <div class="card-sub">{{ progress.text }}<template v-if="summary && summary.month.monthly_cap != null">，剩余 {{ money(summary.month.remaining) }}</template></div>
        </div>
      </section>

      <section class="grid">
        <div v-for="g in groups" :key="g.key" class="panel">
          <h2>{{ g.title }}</h2>
          <div v-if="!g.rows.length" class="empty">暂无数据</div>
          <div v-for="r in g.rows" :key="g.label(r)" class="bar-row" :data-test="'row-' + g.key">
            <div class="bar-name" :title="g.label(r)">{{ g.label(r) }}</div>
            <div class="bar-track"><div class="bar-fill" :style="{ width: r.bar + '%' }" /></div>
            <div class="bar-num">{{ money(r.cost) }}<span class="bar-count">{{ r.count }} 次</span></div>
          </div>
        </div>
      </section>

      <section class="panel">
        <h2>逐任务费用</h2>
        <el-table :data="tasks" empty-text="暂无花费记录" size="small" row-key="task_id" max-height="420">
          <el-table-column prop="day" label="日期" width="110" />
          <el-table-column label="类型" width="80">
            <template #default="{ row }">{{ kindLabel(row.kind) }}</template>
          </el-table-column>
          <el-table-column prop="provider" label="服务商" width="110" />
          <el-table-column label="模型" min-width="140">
            <template #default="{ row }">{{ row.model || '-' }}</template>
          </el-table-column>
          <el-table-column label="项目" width="90">
            <template #default="{ row }">{{ row.project_id || '-' }}</template>
          </el-table-column>
          <el-table-column label="预估" width="100" align="right">
            <template #default="{ row }">{{ money(row.estimated) }}</template>
          </el-table-column>
          <el-table-column label="实际" width="100" align="right">
            <template #default="{ row }">{{ row.actual == null ? '未回传' : money(row.actual) }}</template>
          </el-table-column>
          <el-table-column label="计入" width="100" align="right">
            <template #default="{ row }"><b>{{ money(row.cost) }}</b></template>
          </el-table-column>
        </el-table>
        <el-pagination
          v-if="tasksTotal > pageSize"
          class="pager"
          layout="prev, pager, next"
          :page-size="pageSize"
          :total="tasksTotal"
          :current-page="page"
          @current-change="onPage"
        />
      </section>
    </main>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { spendAPI } from '@/api/spend'
import {
  RANGE_PRESETS, rangeFor, formatMoney, monthProgress, parseCapInput, withBarPercent, kindLabel, csvFileName
} from '@/utils/spendView'

const router = useRouter()
const preset = ref('month')
const summary = ref(null)
const tasks = ref([])
const tasksTotal = ref(0)
const page = ref(1)
const pageSize = 50
const loading = ref(false)
const exporting = ref(false)
const savingCap = ref(false)
const capText = ref('')

const currency = computed(() => summary.value?.currency || 'CNY')
const money = (v) => formatMoney(v, currency.value)
const progress = computed(() => monthProgress(summary.value?.month))
const range = computed(() => rangeFor(preset.value))

const groups = computed(() => {
  const s = summary.value
  if (!s) return []
  return [
    { key: 'day', title: '按日', rows: withBarPercent([...s.by_day].reverse()), label: (r) => r.day },
    { key: 'provider', title: '按服务商', rows: withBarPercent(s.by_provider), label: (r) => r.provider },
    { key: 'model', title: '按模型', rows: withBarPercent(s.by_model || []), label: (r) => `${r.provider} / ${r.model || '未标明模型'}` },
  ]
})

async function loadTasks() {
  const data = await spendAPI.tasks({ ...range.value, limit: pageSize, offset: (page.value - 1) * pageSize })
  tasks.value = data.items || []
  tasksTotal.value = data.total || 0
}

async function reload() {
  loading.value = true
  page.value = 1
  try {
    summary.value = await spendAPI.summary(range.value)
    capText.value = summary.value.limits.monthly_cap == null ? '' : String(summary.value.limits.monthly_cap)
    await loadTasks()
  } catch (_) {
    /* request.js 已提示错误 */
  } finally {
    loading.value = false
  }
}

async function onPage(p) {
  page.value = p
  try { await loadTasks() } catch (_) { /* 同上 */ }
}

async function saveCap() {
  const r = parseCapInput(capText.value)
  if (r.error) return ElMessage.warning(r.error)
  savingCap.value = true
  try {
    await spendAPI.putLimits({ monthly_cap: r.value })
    ElMessage.success(r.value == null ? '已取消月度上限' : '月度上限已保存')
    summary.value = await spendAPI.summary(range.value)
  } catch (_) {
    /* 同上 */
  } finally {
    savingCap.value = false
  }
}

async function onExport() {
  exporting.value = true
  try {
    const blob = await spendAPI.exportCsv(range.value)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = csvFileName(range.value)
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (_) {
    /* 同上 */
  } finally {
    exporting.value = false
  }
}

function goList() {
  router.push({ name: 'list' })
}

onMounted(reload)
</script>

<style scoped>
.spend-page { min-height: 100vh; background: var(--bg-page); color: var(--text-primary); }
.header-inner { display: flex; align-items: center; gap: 16px; padding: 12px 24px; }
.logo { margin: 0; font-size: 18px; cursor: pointer; }
.btn-back { margin-left: auto; }
.main { padding: 16px 24px; display: flex; flex-direction: column; gap: 16px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
.card, .panel { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; }
.card-label { font-size: 13px; color: var(--text-muted); }
.card-value { font-size: 28px; font-weight: 600; margin: 6px 0; color: var(--text-bright); font-variant-numeric: tabular-nums; }
.card-sub { font-size: 12px; color: var(--text-subtle); margin-top: 6px; }
.limit-row { display: flex; gap: 8px; margin: 8px 0 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
.panel h2 { margin: 0 0 12px; font-size: 15px; color: var(--text-bright); }
.empty { color: var(--text-subtle); font-size: 13px; }
.bar-row { display: grid; grid-template-columns: 130px 1fr 120px; align-items: center; gap: 10px; padding: 4px 0; font-size: 13px; }
.bar-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
.bar-track { height: 8px; background: var(--bg-inner); border-radius: 4px; overflow: hidden; }
.bar-fill { height: 100%; background: #7c3aed; border-radius: 4px; min-width: 2px; }
.bar-num { text-align: right; font-variant-numeric: tabular-nums; }
.bar-count { margin-left: 6px; color: var(--text-subtle); font-size: 11px; }
.pager { margin-top: 12px; justify-content: center; }
</style>
