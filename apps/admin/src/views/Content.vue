<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api, errorText } from '../api.js'
import { KINDS, LEVELS, newId, validateAnnouncements, validateCatalog } from '../format.js'

const tab = ref('announcements')
const announcements = ref([])
const catalog = ref([])
const loading = ref(false)
const saving = ref(false)

async function load() {
  loading.value = true
  try {
    ;[announcements.value, catalog.value] = await Promise.all([api.getAnnouncements(), api.getCatalog()])
  } catch (e) {
    ElMessage.error(errorText(e))
  } finally {
    loading.value = false
  }
}

function addAnnouncement() {
  announcements.value.unshift({ id: newId('a'), title: '', body: '', level: 'info', active: true, publishedAt: new Date().toISOString() })
}
function addCatalog() {
  catalog.value.push({ id: newId('m'), kind: 'text', provider: 'bailian', name: '', price: 0, unit: '千字', enabled: true })
}

async function save(kind) {
  const isA = kind === 'announcements'
  const list = isA ? announcements.value : catalog.value
  const err = isA ? validateAnnouncements(list) : validateCatalog(list)
  if (err) return ElMessage.warning(err)
  saving.value = true
  try {
    const saved = isA ? await api.saveAnnouncements(list) : await api.saveCatalog(list)
    if (isA) announcements.value = saved
    else catalog.value = saved
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
    <h2 class="page-title">公告与模型目录</h2>
    <el-tabs v-model="tab" v-loading="loading">
      <el-tab-pane label="公告" name="announcements">
        <div class="toolbar">
          <el-button @click="addAnnouncement">新增公告</el-button>
          <el-button type="primary" :loading="saving" @click="save('announcements')">保存全部</el-button>
          <span class="muted">只有“生效”的公告会下发给客户端</span>
        </div>
        <el-table :data="announcements" border empty-text="暂无公告">
          <el-table-column label="标题" min-width="180"><template #default="{ row }"><el-input v-model="row.title" maxlength="100" /></template></el-table-column>
          <el-table-column label="正文" min-width="280"><template #default="{ row }"><el-input v-model="row.body" type="textarea" :rows="2" maxlength="2000" /></template></el-table-column>
          <el-table-column label="级别" width="120">
            <template #default="{ row }">
              <el-select v-model="row.level"><el-option v-for="l in LEVELS" :key="l.value" :label="l.label" :value="l.value" /></el-select>
            </template>
          </el-table-column>
          <el-table-column label="生效" width="80"><template #default="{ row }"><el-switch v-model="row.active" /></template></el-table-column>
          <el-table-column label="操作" width="80">
            <template #default="{ $index }"><el-button link type="danger" @click="announcements.splice($index, 1)">删除</el-button></template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="模型目录与价格" name="catalog">
        <div class="toolbar">
          <el-button @click="addCatalog">新增模型</el-button>
          <el-button type="primary" :loading="saving" @click="save('catalog')">保存并发布</el-button>
          <span class="muted">价格为展示与花费预估用的参考价；停用的模型不会下发</span>
        </div>
        <el-table :data="catalog" border empty-text="暂无模型">
          <el-table-column label="名称" min-width="160"><template #default="{ row }"><el-input v-model="row.name" maxlength="100" /></template></el-table-column>
          <el-table-column label="类型" width="110">
            <template #default="{ row }"><el-select v-model="row.kind"><el-option v-for="k in KINDS" :key="k.value" :label="k.label" :value="k.value" /></el-select></template>
          </el-table-column>
          <el-table-column label="提供方" width="130"><template #default="{ row }"><el-input v-model="row.provider" maxlength="40" /></template></el-table-column>
          <el-table-column label="价格" width="150"><template #default="{ row }"><el-input-number v-model="row.price" :min="0" :precision="4" :step="0.1" controls-position="right" style="width: 130px" /></template></el-table-column>
          <el-table-column label="计价单位" width="120"><template #default="{ row }"><el-input v-model="row.unit" maxlength="20" /></template></el-table-column>
          <el-table-column label="启用" width="80"><template #default="{ row }"><el-switch v-model="row.enabled" /></template></el-table-column>
          <el-table-column label="操作" width="80">
            <template #default="{ $index }"><el-button link type="danger" @click="catalog.splice($index, 1)">删除</el-button></template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
