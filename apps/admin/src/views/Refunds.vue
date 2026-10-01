<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, errorText } from '../api.js'
import { formatTime } from '../format.js'
import { INVOICE_STATUS, REFUND_STATUS, formatMoney, statusTag } from '../ops.js'
import { can } from '../permissions.js'
import { me } from '../session.js'

const tab = ref('refunds')
const refunds = ref([])
const invoices = ref([])
const invoiceStatus = ref('')
const loading = ref(false)
const canWrite = computed(() => can(me.value, 'ops:write'))

async function load() {
  loading.value = true
  try {
    ;[refunds.value, invoices.value] = await Promise.all([api.listRefunds(200), api.listInvoices(invoiceStatus.value || undefined)])
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    loading.value = false
  }
}

async function issue(row) {
  try {
    const { value } = await ElMessageBox.prompt(`为「${row.title}」填写已开具的发票号码：`, '开具发票', { inputPattern: /^.{1,60}$/, inputErrorMessage: '发票号 1–60 个字符' })
    await api.issueInvoice(row.id, value.trim())
    ElMessage.success('已标记为已开具')
    await load()
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(errorText(e))
  }
}

async function voidInvoice(row) {
  try {
    await ElMessageBox.confirm(`作废「${row.title}」的发票？已开具的发票需要同时在税务系统红冲。`, '作废发票', { type: 'warning' })
    await api.voidInvoice(row.id)
    ElMessage.success('已作废')
    await load()
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(errorText(e))
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <h2 class="page-title">退款与发票</h2>
    <div class="toolbar"><el-button @click="load">刷新</el-button><span class="muted">退款请在“订单”详情里发起（按剩余天数折算）；这里查看记录与处理发票。</span></div>
    <el-tabs v-model="tab" v-loading="loading">
      <el-tab-pane label="退款记录" name="refunds">
        <el-table :data="refunds" border stripe empty-text="暂无退款">
          <el-table-column label="时间" width="160"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
          <el-table-column label="退款单号" min-width="220"><template #default="{ row }"><span class="mono">{{ row.outRefundNo }}</span></template></el-table-column>
          <el-table-column label="金额" width="100"><template #default="{ row }">{{ formatMoney(row.amountCents) }}</template></el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }"><el-tag :type="statusTag(REFUND_STATUS, row.status).type">{{ statusTag(REFUND_STATUS, row.status).label }}</el-tag></template>
          </el-table-column>
          <el-table-column prop="reason" label="原因" min-width="160" show-overflow-tooltip />
          <el-table-column prop="failureReason" label="失败原因" min-width="160" show-overflow-tooltip />
          <el-table-column label="完成时间" width="160"><template #default="{ row }">{{ formatTime(row.finishedAt) }}</template></el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="发票" name="invoices">
        <div class="toolbar">
          <el-select v-model="invoiceStatus" placeholder="全部状态" clearable style="width: 150px" @change="load">
            <el-option v-for="(v, k) in INVOICE_STATUS" :key="k" :label="v.label" :value="k" />
          </el-select>
        </div>
        <el-table :data="invoices" border stripe empty-text="暂无发票">
          <el-table-column label="申请时间" width="160"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
          <el-table-column prop="title" label="抬头" min-width="180" />
          <el-table-column label="税号" width="170"><template #default="{ row }"><span class="mono">{{ row.taxNo || '—' }}</span></template></el-table-column>
          <el-table-column prop="email" label="接收邮箱" min-width="180" />
          <el-table-column label="金额" width="100"><template #default="{ row }">{{ formatMoney(row.amountCents) }}</template></el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }"><el-tag :type="statusTag(INVOICE_STATUS, row.status).type">{{ statusTag(INVOICE_STATUS, row.status).label }}</el-tag></template>
          </el-table-column>
          <el-table-column label="发票号" width="150"><template #default="{ row }"><span class="mono">{{ row.invoiceNo || '—' }}</span></template></el-table-column>
          <el-table-column label="操作" width="140" fixed="right">
            <template #default="{ row }">
              <el-button v-if="row.status === 'REQUESTED' && canWrite" link type="primary" @click="issue(row)">开具</el-button>
              <el-button v-if="row.status !== 'VOID' && canWrite" link type="danger" @click="voidInvoice(row)">作废</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
