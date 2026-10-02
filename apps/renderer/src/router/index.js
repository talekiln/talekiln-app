import { createRouter, createWebHistory } from 'vue-router'
import { shouldShowOnboarding } from '@/utils/onboarding'
import { useAccountStore } from '@/stores/account'
import { useProjectViewsStore } from '@/stores/projectViews'
import { routeDecision, isStale } from '@/utils/account'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/Login.vue'),
      meta: { title: '登录' }
    },
    {
      path: '/',
      name: 'list',
      component: () => import('@/views/FilmList.vue'),
      meta: { title: '项目列表' }
    },
    {
      path: '/onboarding',
      name: 'onboarding',
      component: () => import('@/views/Onboarding.vue'),
      meta: { title: '首次配置' }
    },
    {
      path: '/new-project',
      name: 'new-project',
      component: () => import('@/views/NewProject.vue'),
      meta: { title: '新建项目' }
    },
    {
      path: '/project/:dramaId/storyboard',
      name: 'storyboard',
      component: () => import('@/views/StoryboardPage.vue'),
      meta: { title: '分镜表' }
    },
    {
      path: '/project/:dramaId/library',
      name: 'reference-library',
      component: () => import('@/views/ReferenceLibrary.vue'),
      meta: { title: '角色与场景库' }
    },
    {
      path: '/project/:dramaId/shot/:shotId',
      name: 'shot-workbench',
      component: () => import('@/views/ShotWorkbench.vue'),
      meta: { title: '分镜工作台' }
    },
    {
      path: '/drama/:id',
      name: 'drama-detail',
      component: () => import('@/views/DramaDetail.vue'),
      meta: { title: '剧集管理' }
    },
    {
      path: '/film/:id',
      name: 'film',
      component: () => import('@/views/FilmCreate.vue'),
      meta: { title: 'AI 视频生成' }
    },
    {
      path: '/film/:id/canvas',
      name: 'film-canvas',
      component: () => import('@/views/DramaCanvas.vue'),
      meta: { title: '画布模式' }
    },
    {
      path: '/episodes/:id/timeline',
      name: 'episode-timeline',
      component: () => import('@/views/TimelineEditor.vue'),
      meta: { title: '时间线编辑' }
    },
    // 四视图：同一份项目图的剧本 / 分镜 / 时间线 / 画布投影，选择与历史共享
    {
      path: '/episodes/:id/script',
      name: 'episode-script',
      component: () => import('@/views/ScriptView.vue'),
      meta: { title: '剧本视图' }
    },
    {
      path: '/episodes/:id/canvas',
      name: 'episode-canvas',
      component: () => import('@/views/CanvasView.vue'),
      meta: { title: '画布视图' }
    },
    {
      // 只有剧集 id 时（如从剧本 / 画布视图的直达链接）：查出所属项目后进入分镜表
      path: '/episodes/:id/storyboard',
      name: 'episode-storyboard',
      component: () => import('@/views/StoryboardPage.vue'),
      beforeEnter: async (to) => {
        const drama = await useProjectViewsStore().resolveDrama(Number(to.params.id))
        return drama ? { path: `/project/${drama}/storyboard`, query: { ...to.query, episode: String(to.params.id) }, replace: true } : { path: '/' }
      },
      meta: { title: '分镜表' }
    },
    {
      path: '/episodes/:id/export',
      name: 'episode-export',
      component: () => import('@/views/ExportPage.vue'),
      meta: { title: '导出视频' }
    },
    {
      path: '/settings/shortcuts',
      name: 'keyboard-settings',
      component: () => import('@/views/KeyboardSettings.vue'),
      meta: { title: '快捷键设置' }
    },
    {
      path: '/settings/about',
      name: 'about',
      component: () => import('@/views/About.vue'),
      meta: { title: '关于' }
    },
    {
      path: '/ai-config',
      name: 'ai-config',
      component: () => import('@/views/AiConfig.vue'),
      meta: { title: 'AI 配置' }
    },
    {
      path: '/free-create',
      name: 'free-create',
      component: () => import('@/views/FreeCreate.vue'),
      meta: { title: '自由创作' }
    },
    {
      path: '/task-center',
      name: 'task-center',
      component: () => import('@/views/TaskCenter.vue'),
      meta: { title: '任务中心' }
    },
    {
      path: '/spend',
      name: 'spend',
      component: () => import('@/views/SpendPage.vue'),
      meta: { title: '花费统计' }
    },
    {
      path: '/media-library',
      name: 'media-library',
      component: () => import('@/views/MediaLibrary.vue'),
      meta: { title: '媒体素材库' }
    },
    // P3-B
    {
      path: '/project/:dramaId/batch',
      name: 'batch',
      component: () => import('@/views/BatchPage.vue'),
      meta: { title: '批量生成' }
    },
    // P3-T
    {
      path: '/templates',
      name: 'templates',
      component: () => import('@/views/TemplateMarket.vue'),
      meta: { title: '模板市场' }
    },
    // P3-P
    {
      path: '/settings/plugins',
      name: 'plugins',
      component: () => import('@/views/PluginsPage.vue'),
      meta: { title: '插件与服务商' }
    },
    // P3-K
    {
      path: '/settings/backup',
      name: 'backup',
      component: () => import('@/views/BackupPage.vue'),
      meta: { title: '云备份' }
    }
  ]
})

// 每次打开应用只检查一次：首页且还没配 Key、也没点过“跳过”时，进入首次引导
let onboardingChecked = false
router.beforeEach(async (to) => {
  if (to.meta.title) {
    document.title = `${to.meta.title} - 故事窑`
  }
  // 登录门禁：仅当本地配置 cloud.require_login 为 true 时生效；状态查不到（本地服务异常）不拦截
  const account = useAccountStore()
  if (to.name !== 'login' && (!account.loaded || isStale(account.lastAt, Date.now()))) {
    await account.fetch({ sync: true })
  }
  const gate = routeDecision(account.status, to)
  if (gate !== true && gate !== undefined) return gate
  if (!onboardingChecked && to.name === 'list') {
    onboardingChecked = true
    try {
      const res = await fetch('/api/v1/onboarding/status')
      const body = res.ok ? await res.json() : null
      if (shouldShowOnboarding(body && body.data)) return { name: 'onboarding' }
    } catch (_) { /* 服务未就绪时不拦截 */ }
  }
  return true
})

export default router
