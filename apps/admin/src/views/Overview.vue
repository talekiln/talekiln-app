<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api, errorText } from '../api.js'
import { EVENT_LABEL, FEEDBACK_NOTE, STEP_LABEL, barPercent, formatBytes, formatTime } from '../format.js'

const days = ref(14)
const data = ref(null)
const feedback = ref([])
const loading = ref(false)

const maxDau = computed(() => (data.value ? Math.max(0, ...data.value.series.map((s) => s.dau)) : 0))
const maxFail = computed(() => (data.value ? Math.max(0, ...data.value.series.map((s) => s.failures)) : 0))

async function load() {
  loading.value = true
  try {
    ;[data.value, feedback.value] = await Promise.all([api.overview(days.value), api.listFeedback()])
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    loading.value = false
  }
}

async function download(row) {
  try {
    const blob = await api.downloadDiagnostic(row.id)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `diagnostic-${row.taskId || row.id}.zip`
    a.click()
    URL.revokeObjectURL(a.href)
  } catch (e) {
    ElMessage.error(errorText(e))
  }
}

onMounted(load)
</script>

<template>
  <div class="page" v-loading="loading">
    <h2 class="page-title">运营概览</h2>
    <div class="toolbar">
      <el-radio-group v-model="days" @change="load">
        <el-radio-button :value="7">近 7 天</el-radio-button>
        <el-radio-button :value="14">近 14 天</el-radio-button>
        <el-radio-button :value="30">近 30 天</el-radio-button>
      </el-radio-group>
      <el-button @click="load">刷新</el-button>
      <span class="muted">统计来自用户自愿开启的匿名上报，不含账号、提示词内容与密钥，实际用户数以账号为准</span>
    </div>

    <template v-if="data">
      <div class="cards">
        <div class="card"><div class="n">{{ data.totals.accounts }}</div><div class="l">注册账号（禁用 {{ data.totals.disabledAccounts }}）</div></div>
        <div class="card"><div class="n">{{ data.totals.invitesUnused }}</div><div class="l">未使用邀请码（已用 {{ data.totals.invitesUsed }}）</div></div>
        <div class="card"><div class="n">{{ data.totals.activeInstalls }}</div><div class="l">期间活跃安装数</div></div>
        <div class="card"><div class="n">{{ data.totals.projects }}</div><div class="l">新建项目数</div></div>
        <div class="card"><div class="n">{{ data.totals.exports }}</div><div class="l">导出成功数</div></div>
        <div class="card"><div class="n">{{ data.totals.failures }}</div><div class="l">失败事件数</div></div>
      </div>

      <div class="section">
        <h3>按天趋势（UTC 日期）</h3>
        <el-table :data="[...data.series].reverse()" size="small" border>
          <el-table-column prop="day" label="日期" width="120" />
          <el-table-column label="日活 DAU" min-width="200">
            <template #default="{ row }">
              <div style="display: flex; align-items: center; gap: 8px">
                <div class="bar" :style="{ width: barPercent(row.dau, maxDau) * 0.6 + '%' }" />
                <span>{{ row.dau }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="projects" label="新建项目" width="100" />
          <el-table-column prop="exports" label="导出" width="80" />
          <el-table-column label="失败" min-width="160">
            <template #default="{ row }">
              <div style="display: flex; align-items: center; gap: 8px">
                <div class="bar fail" :style="{ width: barPercent(row.failures, maxFail) * 0.6 + '%' }" />
                <span>{{ row.failures }}</span>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px">
        <div class="section">
          <h3>失败码排行</h3>
          <el-table :data="data.failureCodes" size="small" border empty-text="暂无失败记录">
            <el-table-column label="类别" width="120"><template #default="{ row }">{{ EVENT_LABEL[row.event] || row.event }}</template></el-table-column>
            <el-table-column label="错误码"><template #default="{ row }"><span class="mono">{{ row.code }}</span></template></el-table-column>
            <el-table-column prop="count" label="次数" width="80" />
          </el-table>
        </div>
        <div class="section">
          <h3>引导步骤到达（去重安装数）</h3>
          <el-table :data="data.onboarding" size="small" border empty-text="暂无数据">
            <el-table-column label="步骤"><template #default="{ row }">{{ STEP_LABEL[row.step] || row.step }}</template></el-table-column>
            <el-table-column prop="installs" label="安装数" width="100" />
          </el-table>
        </div>
      </div>
    </template>

    <div class="section">
      <h3>用户反馈</h3>
      <p class="muted">{{ FEEDBACK_NOTE }}</p>
      <el-table :data="feedback" size="small" border empty-text="暂无反馈">
        <el-table-column label="时间" width="150"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
        <el-table-column label="任务号" width="170"><template #default="{ row }"><span class="mono">{{ row.taskId || '—' }}</span></template></el-table-column>
        <el-table-column prop="message" label="描述" min-width="260" show-overflow-tooltip />
        <el-table-column label="联系方式" width="160"><template #default="{ row }">{{ row.contact || '—' }}</template></el-table-column>
        <el-table-column prop="appVersion" label="版本" width="80" />
        <el-table-column label="诊断包" width="130">
          <template #default="{ row }">
            <el-button v-if="row.diagnosticSize" link type="primary" @click="download(row)">下载 {{ formatBytes(row.diagnosticSize) }}</el-button>
            <span v-else class="muted">无</span>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>
