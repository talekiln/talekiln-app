<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api, errorText } from '../api.js'
import { KINDS, newId, validateCatalog } from '../format.js'
import { can } from '../permissions.js'
import { me } from '../session.js'

const catalog = ref([])
const loading = ref(false)
const saving = ref(false)
const canWrite = computed(() => can(me.value, 'ops:write'))

async function load() {
  loading.value = true
  try {
    catalog.value = await api.getCatalog()
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    loading.value = false
  }
}

function addCatalog() {
  catalog.value.push({ id: newId('m'), kind: 'text', provider: 'bailian', name: '', price: 0, unit: '千字', enabled: true })
}

async function save() {
  const err = validateCatalog(catalog.value)
  if (err) return ElMessage.warning(err)
  saving.value = true
  try {
    catalog.value = await api.saveCatalog(catalog.value)
    ElMessage.success('已保存，客户端下次拉取时生效')
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <h2 class="page-title">模型目录与价格</h2>
    <div class="toolbar">
      <el-button :disabled="!canWrite" @click="addCatalog">新增模型</el-button>
      <el-button type="primary" :disabled="!canWrite" :loading="saving" @click="save">保存并发布</el-button>
      <span class="muted">价格为展示与花费预估用的参考价；停用的模型不会下发。公告请到“公告”页管理。</span>
    </div>
    <el-table v-loading="loading" :data="catalog" border empty-text="暂无模型">
      <el-table-column label="名称" min-width="160"><template #default="{ row }"><el-input v-model="row.name" maxlength="100" :disabled="!canWrite" /></template></el-table-column>
      <el-table-column label="类型" width="110">
        <template #default="{ row }"><el-select v-model="row.kind" :disabled="!canWrite"><el-option v-for="k in KINDS" :key="k.value" :label="k.label" :value="k.value" /></el-select></template>
      </el-table-column>
      <el-table-column label="提供方" width="130"><template #default="{ row }"><el-input v-model="row.provider" maxlength="40" :disabled="!canWrite" /></template></el-table-column>
      <el-table-column label="价格" width="150"><template #default="{ row }"><el-input-number v-model="row.price" :min="0" :precision="4" :step="0.1" controls-position="right" style="width: 130px" :disabled="!canWrite" /></template></el-table-column>
      <el-table-column label="计价单位" width="120"><template #default="{ row }"><el-input v-model="row.unit" maxlength="20" :disabled="!canWrite" /></template></el-table-column>
      <el-table-column label="启用" width="80"><template #default="{ row }"><el-switch v-model="row.enabled" :disabled="!canWrite" /></template></el-table-column>
      <el-table-column label="操作" width="80">
        <template #default="{ $index }"><el-button link type="danger" :disabled="!canWrite" @click="catalog.splice($index, 1)">删除</el-button></template>
      </el-table-column>
    </el-table>
  </div>
</template>
