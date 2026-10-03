// 一键成片的编排：把 utils/pipelinePlan.js 算出的步骤按顺序执行，并提供 暂停 / 继续 / 取消。
//
// 分成三层，便于在 node --test 下测试：
//   createPipelineRunner(deps, options)  状态机，只依赖注入的 deps（没有 Vue、没有网络）
//   createDefaultDeps(ctx)               把 deps 接到现有 API（全部懒加载，不静态依赖 @/ 别名）
//   usePipeline(episodeId, ...)          Vue 包装：把快照放进 ref
//
// 状态：idle | running | paused | done | failed | cancelled（cancelled 是在计划的五个状态之外多出的一个）。
// 取消只停止“后续步骤”：已经进入后台队列的任务不会被撤回，可在任务中心单独取消。
import { ref, shallowRef, onBeforeUnmount, getCurrentInstance } from 'vue'
import { buildPlan, STEP_ORDER } from '../utils/pipelinePlan.js'

const CANCELLED = Symbol('pipeline-cancelled')

// 这几步失败不影响后面的步骤（与旧一键成片一致：道具提取失败不中断）
const SOFT_STEPS = new Set(['extractProps'])
const EXTRACT_STEPS = new Set(['extractCharacters', 'extractScenes', 'extractProps', 'storyboards'])
const ASSET_TYPE = { characterImages: 'character', sceneImages: 'scene', propImages: 'prop' }
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms))
const message = (e) => (e && e.message) || String(e)

function unionIds(...lists) {
  const seen = new Set()
  const out = []
  for (const l of lists) for (const id of l || []) if (!seen.has(id)) { seen.add(id); out.push(id) }
  return out
}

/**
 * deps（全部返回 Promise）：
 *   collectState()                         -> buildPlan 的 state
 *   estimate(storyboardIds, kind)          -> POST generate confirm=false 的预览
 *   submit(storyboardIds, kind)            -> POST generate confirm=true
 *   waitShots(storyboardIds, kind, {isCancelled}) -> { failed: [storyboardId] }（等队列跑完）
 *   extract(stepId, {isCancelled})         提取角色 / 场景 / 道具、生成分镜（含等待任务完成）
 *   assetImage(type, id, {isCancelled})    type: character|scene|prop（含等待）
 *   estimateVoice(storyboardIds)           -> { estimate, max, currency, ... }
 *   voice(storyboardIds)                   提交配音
 *   concurrency()                          -> 资产图并发数
 *   sleep(ms)
 */
export function createPipelineRunner(deps, options = {}) {
  const retries = Math.max(0, options.retries ?? 2)
  const planOptions = {
    includeExtract: options.includeExtract,
    includeAssetImages: options.includeAssetImages,
    includeVoice: options.includeVoice,
    pauseBetweenPhases: options.pauseBetweenPhases,
  }
  const sleep = deps.sleep || sleepReal
  const listeners = new Set()

  let state = 'idle'
  let plan = null
  let estimate = null
  let steps = []
  let errors = []
  let error = null
  let pausedAfter = null
  let pauseRequested = false
  let cancelled = false
  let waiters = []
  let running = null

  const isCancelled = () => cancelled

  function snapshot() {
    return {
      state,
      plan,
      estimate,
      steps: steps.map((s) => ({ ...s })),
      errors: errors.map((e) => ({ ...e })),
      error: error ? { ...error } : null,
      pausedAfter,
    }
  }
  function emit() {
    const snap = snapshot()
    for (const fn of listeners) fn(snap)
  }
  function setState(next) {
    if (state === next) return
    state = next
    emit()
  }
  function patchStep(id, patch) {
    const s = steps.find((x) => x.id === id)
    if (s) Object.assign(s, patch)
    emit()
  }
  function addError(e) {
    errors.push(e)
    emit()
  }

  async function gate() {
    if (cancelled) throw CANCELLED
    if (pauseRequested) {
      setState('paused')
      await new Promise((res) => waiters.push(res))
      if (cancelled) throw CANCELLED
      setState('running')
    }
  }
  function release() {
    const w = waiters
    waiters = []
    for (const fn of w) fn()
  }

  async function computeEstimate(p) {
    const byId = Object.fromEntries(p.steps.map((s) => [s.id, s]))
    const frames = byId.firstFrames
    const videos = byId.videos
    const voice = byId.voice
    const pending = [frames, videos, voice].some((s) => s && !s.skip && s.count === null)
    const out = { pending, total: 0, max: 0, currency: 'CNY', allowed: true, providerReady: true, blockedText: '', sample: false, known: true, voice: null, media: null }
    if (!pending) {
      const f = frames && !frames.skip ? frames.ids : []
      const v = videos && !videos.skip ? videos.ids : []
      const ids = unionIds(f, v)
      if (ids.length) {
        const kind = f.length && v.length ? 'both' : f.length ? 'image' : 'video'
        const pre = await deps.estimate(ids, kind)
        const est = (pre && pre.estimate) || {}
        out.media = pre
        out.total += Number(est.total) || 0
        out.max += Number(est.max) || 0
        out.currency = est.currency || (pre && pre.cap && pre.cap.currency) || out.currency
        out.sample = !!est.sample_prices
        out.known = est.known !== false
        if (pre && pre.allowed === false) {
          out.allowed = false
          out.blockedText = (pre.refusal && pre.refusal.message) || ''
        }
        if (pre && pre.provider_ready === false) out.providerReady = false
      }
      if (voice && !voice.skip && voice.ids.length && deps.estimateVoice) {
        const ve = await deps.estimateVoice(voice.ids)
        out.voice = ve
        out.total += Number(ve && ve.estimate) || 0
        out.max += Number(ve && ve.max) || 0
      }
    }
    return out
  }

  async function doPlan() {
    const current = buildPlan(await deps.collectState(), planOptions)
    plan = current
    steps = current.steps.map((s) => ({ id: s.id, phase: s.phase, billable: s.billable, status: s.skip ? 'skipped' : 'pending', done: 0, total: s.count }))
    estimate = current.blocked ? null : await computeEstimate(current)
    emit()
    return { plan: current, estimate }
  }

  async function precheck(ids, kind, stepId) {
    const pre = await deps.estimate(ids, kind)
    if (pre && pre.allowed === false) {
      const e = new Error((pre.refusal && pre.refusal.message) || 'blocked')
      e.code = 'blocked'
      throw Object.assign(e, { stepId })
    }
    if (pre && pre.provider_ready === false) {
      const e = new Error('no provider key')
      e.code = 'no_provider'
      throw Object.assign(e, { stepId })
    }
  }

  async function runAssetStep(step) {
    const type = ASSET_TYPE[step.id]
    const list = [...step.ids]
    const limit = Math.max(1, Math.min(Number(await deps.concurrency()) || 1, list.length || 1))
    let next = 0
    let failed = 0
    patchStep(step.id, { total: list.length, done: 0 })
    const worker = async () => {
      while (next < list.length) {
        await gate()
        const id = list[next++]
        let lastErr = null
        for (let attempt = 0; attempt <= retries; attempt++) {
          if (cancelled) throw CANCELLED
          try {
            await deps.assetImage(type, id, { isCancelled })
            lastErr = null
            break
          } catch (e) {
            if (cancelled) throw CANCELLED
            lastErr = e
            if (attempt < retries) await sleep(1000 * (attempt + 1))
          }
        }
        if (lastErr) {
          failed++
          addError({ stepId: step.id, item: id, code: 'item_failed', message: message(lastErr) })
        }
        patchStep(step.id, { done: steps.find((s) => s.id === step.id).done + 1 })
      }
    }
    await Promise.all(Array.from({ length: limit }, worker))
    patchStep(step.id, { status: failed ? 'failed' : 'done' })
  }

  async function runShotStep(step, kind) {
    const ids = step.ids
    patchStep(step.id, { total: ids.length, done: 0 })
    await precheck(ids, kind, step.id)
    await gate()
    await deps.submit(ids, kind)
    const res = (await deps.waitShots(ids, kind, { isCancelled })) || {}
    if (cancelled) throw CANCELLED
    const failedIds = res.failed || []
    for (const id of failedIds) addError({ stepId: step.id, item: id, code: 'shot_failed', message: '' })
    patchStep(step.id, { done: ids.length - failedIds.length, status: failedIds.length ? 'failed' : 'done' })
  }

  async function runStep(step) {
    patchStep(step.id, { status: 'running' })
    if (ASSET_TYPE[step.id]) return runAssetStep(step)
    if (step.id === 'firstFrames') return runShotStep(step, 'image')
    if (step.id === 'videos') return runShotStep(step, 'video')
    if (step.id === 'voice') {
      await deps.voice(step.ids)
      patchStep(step.id, { status: 'done', done: step.ids.length, total: step.ids.length })
      return undefined
    }
    await deps.extract(step.id, { isCancelled })
    patchStep(step.id, { status: 'done' })
    return undefined
  }

  async function loop() {
    for (const id of STEP_ORDER) {
      await gate()
      // 每一步之前重新读取项目：前面的步骤产出了什么，这一步就处理什么
      const current = buildPlan(await deps.collectState(), planOptions)
      const step = current.steps.find((s) => s.id === id)
      if (!step || step.skip || (!EXTRACT_STEPS.has(id) && !step.ids.length)) {
        patchStep(id, { status: 'skipped' })
        continue
      }
      try {
        await runStep(step)
      } catch (e) {
        if (e === CANCELLED || cancelled) throw CANCELLED
        const entry = { stepId: id, code: e.code || 'step_failed', message: message(e) }
        patchStep(id, { status: 'failed' })
        if (SOFT_STEPS.has(id) && !e.code) { addError(entry); continue }
        error = entry
        throw e
      }
      if (step.pauseAfter) {
        pausedAfter = id
        pauseRequested = true
        await gate()
        pausedAfter = null
        emit()
      }
    }
  }

  async function doRun({ confirmed = false } = {}) {
    if (running) return running
    errors = []
    error = null
    cancelled = false
    pauseRequested = false
    pausedAfter = null
    const planned = await doPlan()
    if (planned.plan.blocked) {
      error = { stepId: null, code: planned.plan.blocked, message: '' }
      setState('failed')
      return undefined
    }
    if (planned.plan.runnable.some((s) => s.billable) && !confirmed) {
      throw Object.assign(new Error('confirmation required'), { code: 'CONFIRM_REQUIRED' })
    }
    if (planned.estimate && planned.estimate.allowed === false) {
      error = { stepId: 'firstFrames', code: 'blocked', message: planned.estimate.blockedText || '' }
      setState('failed')
      return undefined
    }
    if (planned.estimate && planned.estimate.providerReady === false) {
      error = { stepId: 'firstFrames', code: 'no_provider', message: '' }
      setState('failed')
      return undefined
    }
    setState('running')
    running = (async () => {
      try {
        await loop()
        setState('done')
      } catch (e) {
        if (e === CANCELLED || cancelled) {
          setState('cancelled')
        } else {
          if (!error) error = { stepId: e.stepId || null, code: e.code || 'step_failed', message: message(e) }
          else if (e.stepId && !error.stepId) error.stepId = e.stepId
          setState('failed')
        }
      } finally {
        running = null
        pauseRequested = false
        release()
      }
    })()
    return running
  }

  return {
    getSnapshot: snapshot,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    plan: doPlan,
    async run(opts) {
      const p = doRun(opts)
      await p
    },
    pause() {
      if (state === 'running') pauseRequested = true
    },
    resume() {
      pauseRequested = false
      release()
    },
    cancel() {
      if (state !== 'running' && state !== 'paused') return
      cancelled = true
      release()
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 默认依赖：接到现有 API。全部 import() 懒加载，所以本文件不依赖 @/ 别名就能在 node 下加载。

async function lazyApis() {
  const [kernel, drama, props, characters, scenes, gen, episodeGen, task, voiceover, locks, prompts] = await Promise.all([
    import('@/api/kernel'),
    import('@/api/drama'),
    import('@/api/props'),
    import('@/api/characters'),
    import('@/api/scenes'),
    import('@/api/generation'),
    import('@/api/episodeGeneration'),
    import('@/api/task'),
    import('@/api/voiceover'),
    import('@/api/referenceLocks'),
    import('@/api/prompts'),
  ])
  return {
    kernelAPI: kernel.kernelAPI,
    dramaAPI: drama.dramaAPI,
    propAPI: props.propAPI,
    characterAPI: characters.characterAPI,
    sceneAPI: scenes.sceneAPI,
    generationAPI: gen.generationAPI,
    episodeGenerationAPI: episodeGen.episodeGenerationAPI,
    taskAPI: task.taskAPI,
    voiceoverAPI: voiceover.voiceoverAPI,
    referenceLocksAPI: locks.referenceLocksAPI,
    generationSettingsAPI: prompts.generationSettingsAPI,
  }
}

const hasImage = (a) => !!(a && (a.image_url || a.local_path))
const lockedSet = (list) => new Set((Array.isArray(list) ? list : []).map((l) => Number(l.entity_id)))

/** 轮询旧任务接口直到结束；取消时立刻返回。失败抛错。 */
async function waitTask(apis, taskId, { isCancelled, sleep, intervalMs = 2000, maxAttempts = 450 }) {
  for (let i = 0; i < maxAttempts; i++) {
    if (isCancelled && isCancelled()) return
    const t = await apis.taskAPI.get(taskId)
    if (t.status === 'completed') return
    if (t.status === 'failed' || t.status === 'cancelled') throw new Error((t.error || t.message || 'task failed').toString().trim())
    await sleep(intervalMs)
  }
  throw new Error('task timeout')
}

const SETTLED = new Set(['fresh', 'failed', 'stale', 'none'])

/**
 * ctx: { episodeId, dramaId, style?, language? }
 * 用途：生成菜单“一键成片”。资产图、提取走现有（旧表）接口；首帧 / 视频 / 配音走持久队列。
 */
export function createDefaultDeps(ctx, { sleep = sleepReal } = {}) {
  let apis = null
  const get = async () => apis || (apis = await lazyApis())
  const { episodeId, dramaId } = ctx

  async function drama() {
    const a = await get()
    return a.dramaAPI.get(dramaId)
  }

  return {
    sleep,
    async collectState() {
      const a = await get()
      const [d, script, shots] = await Promise.all([
        a.dramaAPI.get(dramaId),
        a.kernelAPI.view(episodeId, 'script').catch(() => null),
        a.kernelAPI.view(episodeId, 'shots').catch(() => null),
      ])
      const characters = d.characters || []
      const scenes = d.scenes || []
      const props = d.props || []
      const [cl, sl] = await Promise.all([
        characters.length ? a.referenceLocksAPI.list('character', characters.map((c) => c.id)).catch(() => []) : [],
        scenes.length ? a.referenceLocksAPI.list('scene', scenes.map((c) => c.id)).catch(() => []) : [],
      ])
      const cLocked = lockedSet(cl)
      const sLocked = lockedSet(sl)
      const lines = ((script && script.groups) || []).reduce((n, g) => n + (g.lines || []).length, 0)
      const flat = ((shots && shots.groups) || []).flatMap((g) => g.shots || [])
      return {
        hasScript: lines > 0,
        characters: characters.map((c) => ({ id: c.id, hasImage: hasImage(c), locked: cLocked.has(Number(c.id)) })),
        scenes: scenes.map((c) => ({ id: c.id, hasImage: hasImage(c), locked: sLocked.has(Number(c.id)) })),
        props: props.map((c) => ({ id: c.id, hasImage: hasImage(c), locked: false })),
        shots: flat.map((s) => ({
          id: s.id,
          storyboardId: s.legacy_id,
          image: s.image,
          video: s.video,
          narration: s.narration,
          hasText: !!(s.dialogue && String(s.dialogue).trim()),
        })),
      }
    },
    async estimate(ids, kind) {
      const a = await get()
      const { buildGenerateBody } = await import('@/utils/generationView')
      return a.episodeGenerationAPI.generate(episodeId, buildGenerateBody({ shots: ids, kind, confirm: false }))
    },
    async submit(ids, kind) {
      const a = await get()
      const { buildGenerateBody } = await import('@/utils/generationView')
      return a.episodeGenerationAPI.generate(episodeId, buildGenerateBody({ shots: ids, kind, confirm: true }))
    },
    async waitShots(ids, kind, { isCancelled }) {
      const a = await get()
      const want = new Set(ids.map(Number))
      for (let i = 0; i < 1800; i++) {
        if (isCancelled()) return { failed: [] }
        const st = await a.episodeGenerationAPI.status(episodeId)
        const mine = (st.shots || []).filter((s) => want.has(Number(s.storyboard_id)))
        const busy = mine.some((s) => {
          const n = s[kind]
          return !n || !SETTLED.has(n.state)
        })
        if (!busy) {
          return { failed: mine.filter((s) => s[kind] && s[kind].state === 'failed').map((s) => Number(s.storyboard_id)) }
        }
        await sleep(3000)
      }
      return { failed: ids }
    },
    async extract(stepId, { isCancelled }) {
      const a = await get()
      const d = await drama()
      const style = ctx.style || d.style || undefined
      let res
      if (stepId === 'extractCharacters') {
        res = await a.generationAPI.generateCharacters(dramaId, { episode_id: episodeId })
      } else if (stepId === 'extractScenes') {
        res = await a.dramaAPI.extractBackgrounds(episodeId, { model: undefined, style, language: ctx.language })
      } else if (stepId === 'extractProps') {
        res = await a.propAPI.extractFromScript(episodeId)
      } else {
        res = await a.dramaAPI.generateStoryboard(episodeId, { style, aspect_ratio: d.metadata?.aspect_ratio || '16:9' })
      }
      const taskId = res && (res.task_id ?? (typeof res === 'string' ? res : null))
      if (taskId) await waitTask(apis, taskId, { isCancelled, sleep })
    },
    async assetImage(type, id, { isCancelled }) {
      const a = await get()
      const d = await drama()
      const style = ctx.style || d.style || undefined
      let res
      if (type === 'character') res = await a.characterAPI.generateImage(id, undefined, style)
      else if (type === 'scene') res = await a.sceneAPI.generateImage({ scene_id: id, model: undefined, style })
      else res = await a.propAPI.generateImage(id, undefined, style)
      const taskId = res && (res.image_generation?.task_id ?? res.task_id)
      if (taskId) await waitTask(apis, taskId, { isCancelled, sleep })
    },
    async estimateVoice(ids) {
      const a = await get()
      const r = await a.voiceoverAPI.run(episodeId, { shots: ids })
      return r && (r.estimate !== undefined ? { ...r, estimate: Number(r.estimate) || 0, max: Number(r.max) || 0 } : r)
    },
    async voice(ids) {
      const a = await get()
      await a.voiceoverAPI.run(episodeId, { shots: ids, confirm: true })
    },
    async concurrency() {
      const a = await get()
      try {
        const r = await a.generationSettingsAPI.get()
        return Math.max(1, Number(r && r.concurrency) || 3)
      } catch (_) {
        return 3
      }
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------------

/**
 * Vue 包装：const p = usePipeline(episodeId, { dramaId, ...runnerOptions })
 * p.snapshot（ref）、p.plan()、p.run({confirmed})、p.pause()、p.resume()、p.cancel()；p.state 是 snapshot.state 的便捷 ref。
 * 组件卸载时不会自动取消（对话框关闭后流程可以继续在后台跑，见 notes），只取消订阅。
 */
export function usePipeline(episodeId, options = {}) {
  const { dramaId, deps, ...runnerOptions } = options
  const runner = createPipelineRunner(deps || createDefaultDeps({ episodeId, dramaId, style: options.style, language: options.language }), runnerOptions)
  const snapshot = shallowRef(runner.getSnapshot())
  const state = ref('idle')
  const off = runner.subscribe((s) => {
    snapshot.value = s
    state.value = s.state
  })
  if (getCurrentInstance()) onBeforeUnmount(off)
  return {
    snapshot,
    state,
    plan: () => runner.plan(),
    run: (opts) => runner.run(opts),
    pause: () => runner.pause(),
    resume: () => runner.resume(),
    cancel: () => runner.cancel(),
    runner,
  }
}
