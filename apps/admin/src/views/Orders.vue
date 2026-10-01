<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, errorText } from '../api.js'
import { formatTime } from '../format.js'
import {
  INVOICE_STATUS, ORDER_STATUS, PERIOD_LABEL, PROVIDER_LABEL, REFUND_STATUS,
  formatMoney, refundBlockReason, statusTag,
} from '../ops.js'
import { can } from '../permissions.js'
import { me } from '../session.js'

const rows = ref([])
const loading = ref(false)
const status = ref('')
const accountId = ref('')
const detail = ref(null)
const drawer = ref(false)
const busy = ref(false)

const canRefund = computed(() => can(me.value, 'billing:refund'))
const canWrite = computed(() => can(me.value, 'ops:write'))
const blockReason = computed(() => refundBlockReason(detail.value))

async function load() {
  loading.value = true
  try {
    rows.value = await api.listOrders({ status: status.value || undefined, accountId: accountId.value.trim() || undefined, limit: 200 })
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    loading.value = false
  }
}

async function open(row) {
  try {
    detail.value = await api.getOrder(row.id)
    drawer.value = true
  } catch (e) {
    ElMessage.error(errorText(e))
  }
}

async function reload() {
  detail.value = await api.getOrder(detail.value.order.id)
  await load()
}

async function refund() {
  const q = detail.value.refundQuote
  try {
    const { value } = await ElMessageBox.prompt(
      `将退款 ${formatMoney(q.refundCents)}（授权剩余 ${q.remainingDays} / ${q.totalDays} 天），订阅到期时间随之前移。退款后不可撤销。可填写退款原因：`,
      '确认退款',
      { type: 'warning', confirmButtonText: '确认退款', inputPattern: /^.{0,200}$/, inputErrorMessage: '原因不能超过 200 字' },
    )
    busy.value = true
    await api.refundOrder(detail.value.order.id, value || undefined)
    ElMessage.success('退款已提交')
    await reload()
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(errorText(e))
  } finally {
    busy.value = false
  }
}

async function registerInvoice() {
  try {
    const { value } = await ElMessageBox.prompt('开票抬头，格式：抬头 | 税号（可空） | 接收邮箱', '登记发票', {
      inputPlaceholder: '某某公司 | 91xxxxxxxx | a@example.com',
    })
    const [title, taxNo, email] = value.split('|').map((s) => s.trim())
    if (!title || !email) return ElMessage.warning('抬头和邮箱必填')
    busy.value = true
    await api.registerInvoice(detail.value.order.id, { title, taxNo: taxNo || undefined, email })
    ElMessage.success('已登记')
    await reload()
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(errorText(e))
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <h2 class="page-title">订单</h2>
    <div class="toolbar">
      <el-select v-model="status" placeholder="全部状态" clearable style="width: 150px" @change="load">
        <el-option v-for="(v, k) in ORDER_STATUS" :key="k" :label="v.label" :value="k" />
      </el-select>
      <el-input v-model="accountId" placeholder="按账号 ID 筛选" clearable style="width: 320px" @keyup.enter="load" @clear="load" />
      <el-button @click="load">查询</el-button>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe empty-text="暂无订单" @row-click="open">
      <el-table-column label="下单时间" width="160"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
      <el-table-column label="商户单号" min-width="220"><template #default="{ row }"><span class="mono">{{ row.outTradeNo }}</span></template></el-table-column>
      <el-table-column label="金额" width="100"><template #default="{ row }">{{ formatMoney(row.amountCents) }}</template></el-table-column>
      <el-table-column label="周期" width="80"><template #default="{ row }">{{ PERIOD_LABEL[row.period] || row.period }}</template></el-table-column>
      <el-table-column label="渠道" width="100"><template #default="{ row }">{{ PROVIDER_LABEL[row.provider] || row.provider }}</template></el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }"><el-tag :type="statusTag(ORDER_STATUS, row.status).type">{{ statusTag(ORDER_STATUS, row.status).label }}</el-tag></template>
      </el-table-column>
      <el-table-column label="付款时间" width="160"><template #default="{ row }">{{ formatTime(row.paidAt) }}</template></el-table-column>
    </el-table>

    <el-drawer v-model="drawer" title="订单详情" size="520px">
      <template v-if="detail">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="订单号"><span class="mono">{{ detail.order.outTradeNo }}</span></el-descriptions-item>
          <el-descriptions-item label="账号"><span class="mono">{{ detail.order.accountId }}</span></el-descriptions-item>
          <el-descriptions-item label="套餐">{{ detail.planCode || '—' }}（{{ PERIOD_LABEL[detail.order.period] }}）</el-descriptions-item>
          <el-descriptions-item label="金额">{{ formatMoney(detail.order.amountCents) }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="statusTag(ORDER_STATUS, detail.order.status).type">{{ statusTag(ORDER_STATUS, detail.order.status).label }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="授权区间">{{ formatTime(detail.order.periodStart) }} ～ {{ formatTime(detail.order.periodEnd) }}</el-descriptions-item>
          <el-descriptions-item v-if="detail.payment" label="支付流水"><span class="mono">{{ detail.payment.tradeNo }}</span></el-descriptions-item>
        </el-descriptions>

        <div class="section" style="margin-top: 16px">
          <h3>退款</h3>
          <template v-if="detail.refundQuote">
            <p>
              按剩余天数折算：剩余 {{ detail.refundQuote.remainingDays }} / {{ detail.refundQuote.totalDays }} 天，
              应退 <b>{{ formatMoney(detail.refundQuote.refundCents) }}</b>
            </p>
          </template>
          <p v-if="blockReason" class="muted">{{ blockReason }}</p>
          <el-button type="danger" :disabled="!canRefund || !!blockReason" :loading="busy" @click="refund">退款</el-button>
          <span v-if="!canRefund" class="muted">　你的角色没有退款权限</span>
          <el-table v-if="detail.refunds.length" :data="detail.refunds" size="small" border style="margin-top: 12px">
            <el-table-column label="时间" width="150"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
            <el-table-column label="金额" width="90"><template #default="{ row }">{{ formatMoney(row.amountCents) }}</template></el-table-column>
            <el-table-column label="状态" width="90"><template #default="{ row }">{{ statusTag(REFUND_STATUS, row.status).label }}</template></el-table-column>
            <el-table-column prop="reason" label="原因" show-overflow-tooltip />
          </el-table>
        </div>

        <div class="section">
          <h3>发票</h3>
          <template v-if="detail.invoice">
            <p>
              <el-tag :type="statusTag(INVOICE_STATUS, detail.invoice.status).type">{{ statusTag(INVOICE_STATUS, detail.invoice.status).label }}</el-tag>
              {{ detail.invoice.title }}
              <span v-if="detail.invoice.invoiceNo" class="mono">　{{ detail.invoice.invoiceNo }}</span>
            </p>
            <p class="muted">开具与作废请到“退款与发票”页处理。</p>
          </template>
          <template v-else>
            <p class="muted">暂无发票申请。</p>
            <el-button :disabled="!canWrite || !['PAID'].includes(detail.order.status)" :loading="busy" @click="registerInvoice">人工登记发票申请</el-button>
          </template>
        </div>
      </template>
    </el-drawer>
  </div>
</template>
