<template>
  <div class="onboarding-page" data-test="onboarding">
    <div class="shell">
      <div class="top">
        <h1 class="brand">故事窑</h1>
        <el-button v-if="step !== 'done'" text data-test="skip" :disabled="needConsent && !agreed" @click="skip">跳过，稍后在 AI 配置中设置</el-button>
      </div>

      <el-steps :active="stepIndex(step, steps)" finish-status="success" align-center class="steps">
        <el-step v-for="s in steps" :key="s" :title="STEP_LABELS[s]" />
      </el-steps>

      <div v-if="loading" class="card loading" v-loading="true" />

      <section v-else class="card">
        <!-- 欢迎 -->
        <template v-if="step === 'welcome'">
          <h2>欢迎使用</h2>
          <p class="lead">从一个故事出发，生成分镜、画面和配音。开始之前需要一个 AI 服务商的 API Key，约两分钟配好。</p>
          <ul class="points">
            <li>Key 只保存在本机，经系统加密存储，界面上只显示末 4 位。</li>
            <li>没有 Key 也可以先看示例项目，不会产生任何费用。</li>
            <li>现在不想配也行，随时可以在“AI 配置”里补。</li>
          </ul>
          <div class="consent" data-test="consent">
            <el-checkbox v-model="agreed" data-test="consent-check">
              我已阅读并同意用户协议与隐私政策
            </el-checkbox>
            <span class="consent-links">
              <template v-for="l in legalLinks" :key="l.id">
                <a v-if="l.url" :href="l.url" target="_blank" rel="noopener noreferrer">{{ l.label }}</a>
                <span v-else class="pending">{{ l.label }}（{{ PENDING_LABEL }}）</span>
              </template>
            </span>
            <el-alert v-if="consentError" :title="consentError" type="error" show-icon :closable="false" data-test="consent-error" />
          </div>
          <div class="actions">
            <el-button type="primary" size="large" data-test="start" :disabled="!agreed" @click="start">开始配置</el-button>
            <el-button size="large" :loading="sampleLoading" :disabled="!agreed" data-test="try-sample" @click="trySampleWithConsent">先看示例项目</el-button>
          </div>
        </template>

        <!-- 选择服务商 -->
        <template v-else-if="step === 'provider'">
          <h2>选择服务商</h2>
          <p class="lead">先选一家。以后可以在 AI 配置里再加别家。</p>
          <div class="providers">
            <button
              v-for="p in providerList"
              :key="p.id"
              type="button"
              class="provider"
              :class="{ active: provider === p.id }"
              :data-test="'provider-' + p.id"
              @click="choose(p.id)"
            >
              <strong>{{ p.name }}</strong>
              <span>{{ p.tagline }}</span>
            </button>
          </div>
          <div class="actions">
            <el-button size="large" @click="go('welcome')">上一步</el-button>
            <el-button type="primary" size="large" :disabled="!provider" data-test="provider-next" @click="go('key')">下一步</el-button>
          </div>
        </template>

        <!-- 粘贴 Key -->
        <template v-else-if="step === 'key' && current">
          <h2>获取并粘贴 {{ current.name }} 的 Key</h2>
          <ol class="howto">
            <li v-for="(t, i) in current.instructions" :key="i">{{ t }}</li>
          </ol>
          <el-button plain data-test="get-key" @click="getKey">去 {{ current.name }} 获取 Key</el-button>
          <el-form class="key-form" label-position="top" @submit.prevent="saveKey">
            <el-form-item label="API Key">
              <el-input
                v-model="keyInput"
                type="password"
                autocomplete="off"
                name="onboarding-secret"
                placeholder="粘贴后不会明文显示"
                :disabled="saving"
                data-test="key-input"
              />
            </el-form-item>
            <el-form-item label="模型名称（可选，留空使用默认）">
              <el-input v-model="modelInput" :placeholder="current.defaultModel" :disabled="saving" style="max-width: 320px" />
            </el-form-item>
            <el-alert v-if="errorMsg" :title="errorMsg" type="error" show-icon :closable="false" class="error" data-test="error" />
            <el-alert v-if="status.config_id" title="已保存过一个 Key，重新粘贴会覆盖它。" type="info" show-icon :closable="false" class="error" />
            <div class="actions">
              <el-button size="large" :disabled="saving" @click="go(prevStep('key', steps))">上一步</el-button>
              <el-button type="primary" size="large" :loading="saving" native-type="submit" data-test="save-key">保存并测试</el-button>
            </div>
          </el-form>
        </template>

        <!-- 连通测试 -->
        <template v-else-if="step === 'test'">
          <h2>连通测试</h2>
          <p class="lead">用刚保存的 Key 发一个最小请求，确认账号可用。会产生极少量费用（通常不到一分钱）。</p>
          <el-alert v-if="testState === 'ok'" title="连接成功，Key 可用" type="success" show-icon :closable="false" data-test="test-ok" />
          <el-alert v-else-if="testState === 'fail'" :title="errorMsg || '连接失败'" type="error" show-icon :closable="false" data-test="test-fail" />
          <div class="actions">
            <el-button size="large" :disabled="testing" @click="go('key')">重新填写 Key</el-button>
            <el-button v-if="testState !== 'ok'" type="primary" size="large" :loading="testing" data-test="run-test" @click="runTest">
              {{ testState === 'fail' ? '重新测试' : '开始测试' }}
            </el-button>
            <el-button v-else type="primary" size="large" data-test="test-next" @click="go('done')">下一步</el-button>
          </div>
        </template>

        <!-- 完成 -->
        <template v-else-if="step === 'done'">
          <h2>配置完成</h2>
          <p class="lead">可以开始创作了。更多模型（图像、视频、配音）可以之后在“AI 配置”里添加。</p>
          <div class="actions">
            <el-button type="primary" size="large" data-test="to-new" @click="finish('/new-project')">从故事生成分镜</el-button>
            <el-button size="large" :loading="sampleLoading" @click="trySample">看看示例项目</el-button>
            <el-button size="large" data-test="to-home" @click="finish('/')">进入首页</el-button>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { aiAPI } from '@/api/ai'
import { onboardingAPI } from '@/api/onboarding'
import {
  STEP_LABELS, buildConfigBody, getProvider, impliedProvider, nextStep, openKeyReferral, prevStep, resumeStep, stepIndex,
  stepsFor, validateKeyInput, visibleProviders,
} from '@/utils/onboarding'
import { seedSampleLocation } from '@/utils/sample'
import { PENDING_LABEL, hasCurrentConsent, recordConsent, resolveLegalLinks, safeLocalStorage } from '@/utils/legal'

const router = useRouter()
const loading = ref(true)
const step = ref('welcome')
const status = ref({})
const provider = ref(null)
const keyInput = ref('')
const modelInput = ref('')
const saving = ref(false)
const testing = ref(false)
const testState = ref('idle')
const errorMsg = ref('')
const sampleLoading = ref(false)

// 同意用户协议与隐私政策：版本和时间只记在本机，不上传。已同意当前版本则不再询问。
const legalLinks = resolveLegalLinks(import.meta.env)
const needConsent = ref(!hasCurrentConsent(safeLocalStorage()))
const agreed = ref(!needConsent.value)
const consentError = ref('')

function commitConsent() {
  if (!needConsent.value) return true
  const { ok } = recordConsent(safeLocalStorage())
  if (!ok) { consentError.value = '无法在本机记录同意，请检查浏览器存储设置后重试'; return false }
  needConsent.value = false
  return true
}

function start() {
  if (!agreed.value || !commitConsent()) return
  go(nextStep('welcome', steps.value))
}

async function trySampleWithConsent() {
  if (!agreed.value || !commitConsent()) return
  await trySample()
}

const current = computed(() => getProvider(provider.value))
// 只开放一个服务商时去掉选择步骤并隐含选定（config.yaml providers.enabled）
const steps = computed(() => stepsFor(status.value))
const providerList = computed(() => visibleProviders(status.value))

/** 进度写到服务端，刷新或重开后可继续；写失败不影响当前页面。 */
async function persist(patch) {
  try {
    status.value = await onboardingAPI.saveState(patch)
  } catch (_) { /* 进度保存失败时仍可继续当前流程 */ }
}

function go(next) {
  errorMsg.value = ''
  if (!provider.value) provider.value = impliedProvider(status.value)
  step.value = next
  persist({ step: next, provider: provider.value })
}

function choose(id) {
  provider.value = id
  persist({ provider: id })
}

function getKey() {
  openKeyReferral(provider.value)
}

async function saveKey() {
  errorMsg.value = ''
  const v = validateKeyInput(keyInput.value)
  if (!v.ok) { errorMsg.value = v.error; return }
  saving.value = true
  try {
    const body = buildConfigBody(provider.value, v.key, modelInput.value)
    let id = status.value.config_id
    if (id) {
      const { service_type, ...patch } = body
      await aiAPI.update(id, patch)
    } else {
      const created = await aiAPI.create(body)
      id = created.id
    }
    keyInput.value = ''
    testState.value = 'idle'
    status.value = await onboardingAPI.saveState({ step: 'test', provider: provider.value, config_id: id })
    step.value = 'test'
    runTest()
  } catch (e) {
    errorMsg.value = e.message || '保存失败，请重试'
  } finally {
    saving.value = false
  }
}

async function runTest() {
  if (!status.value.config_id) { go('key'); return }
  testing.value = true
  errorMsg.value = ''
  try {
    await onboardingAPI.test(status.value.config_id)
    testState.value = 'ok'
  } catch (e) {
    testState.value = 'fail'
    errorMsg.value = e.message || '连接失败'
  } finally {
    testing.value = false
  }
}

async function skip() {
  if (needConsent.value && (!agreed.value || !commitConsent())) return
  await persist({ dismissed: true })
  router.replace('/')
}

async function finish(to) {
  await persist({ step: 'done' })
  router.replace(to)
}

async function trySample() {
  sampleLoading.value = true
  try {
    router.push(await seedSampleLocation())
  } catch (e) {
    ElMessage.error(e.message || '载入示例失败')
  } finally {
    sampleLoading.value = false
  }
}

onMounted(async () => {
  try {
    status.value = await onboardingAPI.status()
    provider.value = status.value.provider || impliedProvider(status.value)
    const s = resumeStep(status.value)
    // 已配好 Key 且不在测试/完成步骤：不再显示向导
    if (status.value.has_key && !['test', 'done'].includes(s)) { router.replace('/'); return }
    step.value = needConsent.value ? 'welcome' : s // 尚未同意协议时一律从欢迎页开始
  } catch (_) {
    step.value = 'welcome'
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.onboarding-page { min-height: 100vh; display: flex; justify-content: center; padding: 32px 16px; }
.shell { width: 100%; max-width: 720px; }
.top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.brand { margin: 0; font-size: 20px; }
.steps { margin-bottom: 24px; }
.card { padding: 28px; border-radius: 12px; border: 1px solid var(--el-border-color); background: var(--el-bg-color); min-height: 240px; }
.card h2 { margin: 0 0 12px; font-size: 20px; }
.lead { margin: 0 0 16px; color: var(--el-text-color-secondary); line-height: 1.7; }
.points { margin: 0 0 20px; padding-left: 20px; line-height: 1.9; }
.howto { margin: 0 0 16px; padding-left: 20px; line-height: 1.9; }
.providers { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin-bottom: 20px; }
.provider { text-align: left; padding: 16px; border-radius: 10px; border: 1px solid var(--el-border-color); background: transparent; color: inherit; cursor: pointer; display: flex; flex-direction: column; gap: 6px; font: inherit; }
.provider strong { font-size: 16px; }
.provider span { font-size: 13px; color: var(--el-text-color-secondary); }
.provider.active { border-color: var(--el-color-primary); box-shadow: 0 0 0 1px var(--el-color-primary); }
.key-form { margin-top: 16px; }
.error { margin-bottom: 12px; }
.consent { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
.consent-links { display: flex; flex-wrap: wrap; gap: 12px; font-size: 13px; }
.consent-links .pending { color: var(--el-text-color-secondary); }
.actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 20px; }
</style>
