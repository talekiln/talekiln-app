// 一键成片的计划：根据项目现有进度决定哪些步骤要跑、哪些跳过（纯函数，无 Vue / 网络依赖）。
//
// state = {
//   hasScript: boolean,                       // 剧本里有行
//   characters|scenes|props: [{ id, hasImage, locked }],
//   shots: [{ id, storyboardId, image, video, narration, hasText }],   // image/video/narration: none|stale|fresh|queued|running|failed
// }
// options = { includeExtract = true, includeAssetImages = true, includeVoice = false, pauseBetweenPhases = false }

export const STEP_ORDER = [
  'extractCharacters', 'extractScenes', 'extractProps', 'storyboards',
  'characterImages', 'sceneImages', 'propImages',
  'firstFrames', 'videos', 'voice',
]

export const PHASE_OF = {
  extractCharacters: 'text',
  extractScenes: 'text',
  extractProps: 'text',
  storyboards: 'text',
  characterImages: 'assets',
  sceneImages: 'assets',
  propImages: 'assets',
  firstFrames: 'frames',
  videos: 'video',
  voice: 'voice',
}

const BILLABLE = new Set(['characterImages', 'sceneImages', 'propImages', 'firstFrames', 'videos', 'voice'])

const ASSET_KEY = { extractCharacters: 'characters', extractScenes: 'scenes', extractProps: 'props' }
const IMAGE_KEY = { characterImages: 'characters', sceneImages: 'scenes', propImages: 'props' }

function step(id, over) {
  return { id, phase: PHASE_OF[id], billable: BILLABLE.has(id), skip: false, reason: null, count: null, ids: [], lockedCount: 0, pending: false, pauseAfter: false, ...over }
}

const skipped = (id, reason, extra) => step(id, { skip: true, reason, count: 0, ...extra })

/**
 * @returns {{ steps, runnable, blocked: null|'no_script', done: boolean }}
 *  steps: 固定顺序的全部 10 步（含跳过的，reason: exists|locked|off|none）
 *  runnable: 需要执行的步骤；count === null 的步骤数量要等前面的步骤跑完才知道（pending: true）
 */
export function buildPlan(state = {}, options = {}) {
  const { includeExtract = true, includeAssetImages = true, includeVoice = false, pauseBetweenPhases = false } = options
  const lists = { characters: state.characters || [], scenes: state.scenes || [], props: state.props || [] }
  const shots = state.shots || []
  const hasShots = shots.length > 0
  const hasScript = !!state.hasScript
  const blocked = !hasShots && !hasScript ? 'no_script' : null

  const steps = []
  const extractRuns = {}

  for (const id of ['extractCharacters', 'extractScenes', 'extractProps']) {
    const list = lists[ASSET_KEY[id]]
    if (!includeExtract) steps.push(skipped(id, 'off'))
    else if (list.length) steps.push(skipped(id, 'exists'))
    else if (!hasScript) steps.push(skipped(id, 'none'))
    else {
      extractRuns[ASSET_KEY[id]] = true
      steps.push(step(id, { count: null, pending: true }))
    }
  }

  if (hasShots) steps.push(skipped('storyboards', 'exists'))
  else if (!hasScript) steps.push(skipped('storyboards', 'none'))
  else steps.push(step('storyboards', { count: null, pending: true }))
  const storyboardsRun = !steps.at(-1).skip

  for (const id of ['characterImages', 'sceneImages', 'propImages']) {
    const key = IMAGE_KEY[id]
    const list = lists[key]
    if (!includeAssetImages) { steps.push(skipped(id, 'off')); continue }
    if (!list.length) {
      // 还没有资产：如果前面的步骤会提取出来，数量要等提取完才知道
      if (extractRuns[key]) steps.push(step(id, { count: null, pending: true }))
      else steps.push(skipped(id, 'none'))
      continue
    }
    const lockedCount = list.filter((a) => a.locked).length
    const todo = list.filter((a) => !a.hasImage && !a.locked)
    if (!todo.length) steps.push(skipped(id, lockedCount ? 'locked' : 'exists', { lockedCount }))
    else steps.push(step(id, { count: todo.length, ids: todo.map((a) => a.id), lockedCount }))
  }

  const pendingShots = storyboardsRun && !hasShots
  const shotStep = (id, pick, field) => {
    if (pendingShots) return step(id, { count: null, pending: true })
    const todo = shots.filter((s) => s[field] !== 'fresh' && pick(s))
    if (!todo.length) return skipped(id, shots.length ? 'exists' : 'none')
    return step(id, { count: todo.length, ids: todo.map((s) => s.storyboardId) })
  }
  steps.push(shotStep('firstFrames', () => true, 'image'))
  steps.push(shotStep('videos', () => true, 'video'))
  steps.push(includeVoice ? shotStep('voice', (s) => s.hasText, 'narration') : skipped('voice', 'off'))

  const runnable = steps.filter((s) => !s.skip)

  if (pauseBetweenPhases) {
    runnable.forEach((s, i) => {
      const next = runnable[i + 1]
      if (next && next.phase !== s.phase) s.pauseAfter = true
    })
  }

  return { steps, runnable, blocked, done: !blocked && runnable.length === 0 }
}
