import { createRouter, createWebHistory } from 'vue-router'
import { shouldShowOnboarding } from '@/utils/onboarding'
import { useAccountStore } from '@/stores/account'
import { useShellStore } from '@/stores/shell'
import { isLegacyPath, resolveLegacyRoute, LEGACY_ROUTE_RECORDS } from '@/utils/legacyRoutes'
import { routeDecision, isStale } from '@/utils/account'
import { routeTitle } from '@/utils/routeTitle'
import { t, locale } from '@/i18n'
import { watch } from 'vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/Login.vue'),
      meta: { title: 'Sign in' }
    },
    {
      path: '/',
      name: 'list',
      component: () => import('@/views/FilmList.vue'),
      meta: { title: 'Projects' }
    },
    {
      path: '/onboarding',
      name: 'onboarding',
      component: () => import('@/views/Onboarding.vue'),
      meta: { title: 'First-time setup' }
    },
    {
      path: '/new-project',
      name: 'new-project',
      component: () => import('@/views/NewProject.vue'),
      meta: { title: 'New project' }
    },
    // 项目外壳：顶栏 / 左栏 / 状态栏 + 子页面。四个视图与资产、批量、镜头工作台都是它的子路由。
    // 旧地址（/film /drama /episodes /project）在 beforeEach 里先经 utils/legacyRoutes 重定向到这里。
    {
      path: '/p/:dramaId(\\d+)',
      component: () => import('@/shell/ProjectShell.vue'),
      children: [
        {
          // /p/:dramaId：上次停留的集和视图，没有则第 1 集剧本；没有剧集则资产页
          path: '',
          name: 'project-home',
          component: { render: () => null },
          beforeEnter: async (to) => {
            const shell = useShellStore()
            await shell.loadProject(Number(to.params.dramaId))
            return { path: shell.landingPath(to.params.dramaId), replace: true }
          },
          meta: { title: 'Project' }
        },
        {
          path: 'e/:episodeId(\\d+)/script',
          name: 'episode-script',
          component: () => import('@/views/ScriptView.vue'),
          meta: { title: 'Script', view: 'script' }
        },
        {
          path: 'e/:episodeId(\\d+)/storyboard',
          name: 'episode-storyboard',
          component: () => import('@/views/StoryboardPage.vue'),
          meta: { title: 'Storyboard', view: 'storyboard' }
        },
        {
          path: 'e/:episodeId(\\d+)/timeline',
          name: 'episode-timeline',
          component: () => import('@/views/TimelineEditor.vue'),
          meta: { title: 'Timeline', view: 'timeline' }
        },
        {
          path: 'e/:episodeId(\\d+)/canvas',
          name: 'episode-canvas',
          component: () => import('@/views/CanvasView.vue'),
          meta: { title: 'Canvas', view: 'canvas' }
        },
        {
          path: 'e/:episodeId(\\d+)/shot/:shotId',
          name: 'shot-workbench',
          component: () => import('@/views/ShotWorkbench.vue'),
          meta: { title: 'Shot workbench' }
        },
        {
          // 导出已改为对话框：直达链接 / 旧地址重定向到时间线，并在其上打开“导出视频”对话框
          path: 'e/:episodeId(\\d+)/export',
          name: 'episode-export',
          component: { render: () => null }, // 占位：beforeEnter 一定会重定向
          meta: { title: 'Export video' },
          beforeEnter: (to) => {
            import('@/shell/dialogs').then(({ openDialog }) => {
              openDialog('export.video', { dramaId: Number(to.params.dramaId), episodeId: Number(to.params.episodeId) })
            }).catch(() => {})
            return { name: 'episode-timeline', params: to.params, replace: true }
          }
        },
        {
          path: 'assets',
          name: 'assets',
          component: () => import('@/views/AssetLibrary.vue'),
          meta: { title: 'Characters and scenes' }
        },
        {
          path: 'batch',
          name: 'batch',
          component: () => import('@/views/BatchPage.vue'),
          meta: { title: 'Batch generate' }
        }
      ]
    },
    // 旧地址（/film /drama /episodes /project /free-create）：占位记录，beforeEach 里先重定向（utils/legacyRoutes）
    ...LEGACY_ROUTE_RECORDS,
    {
      path: '/settings/shortcuts',
      name: 'keyboard-settings',
      component: () => import('@/views/KeyboardSettings.vue'),
      meta: { title: 'Keyboard shortcuts' }
    },
    {
      path: '/settings/about',
      name: 'about',
      component: () => import('@/views/About.vue'),
      meta: { title: 'About' }
    },
    {
      path: '/ai-config',
      name: 'ai-config',
      component: () => import('@/views/AiConfig.vue'),
      meta: { title: 'AI settings' }
    },
    {
      path: '/task-center',
      name: 'task-center',
      component: () => import('@/views/TaskCenter.vue'),
      meta: { title: 'Task center' }
    },
    {
      path: '/spend',
      name: 'spend',
      component: () => import('@/views/SpendPage.vue'),
      meta: { title: 'Spend' }
    },
    {
      path: '/media-library',
      name: 'media-library',
      component: () => import('@/views/MediaLibrary.vue'),
      meta: { title: 'Media library' }
    },
    // P3-T
    {
      path: '/templates',
      name: 'templates',
      component: () => import('@/views/TemplateMarket.vue'),
      meta: { title: 'Template market' }
    },
    // P3-P
    {
      path: '/settings/plugins',
      name: 'plugins',
      component: () => import('@/views/PluginsPage.vue'),
      meta: { title: 'Plugins and providers' }
    },
    // P3-K
    {
      path: '/settings/backup',
      name: 'backup',
      component: () => import('@/views/BackupPage.vue'),
      meta: { title: 'Cloud backup' }
    },
    // P3-S
    {
      path: '/settings/studio',
      name: 'studio',
      component: () => import('@/views/StudioPage.vue'),
      meta: { title: 'Studio' }
    }
  ]
})

// 每次打开应用只检查一次：首页且还没配 Key、也没点过“跳过”时，进入首次引导
let onboardingChecked = false
router.beforeEach(async (to) => {
  // 旧地址先重定向到 /p/...（spec §6）；解析不出时落到存在的页面（项目资产页 / 首页）
  if (isLegacyPath(to.path)) {
    const { shellApi } = await import('@/shell/api')
    const dest = await resolveLegacyRoute(to, shellApi)
    if (dest) return { path: dest, replace: true }
  }
  if (to.meta.title) {
    document.title = routeTitle(to, t)
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

// 切换语言后，标题跟着换
watch(locale, () => {
  const cur = router.currentRoute.value
  if (cur && cur.meta && cur.meta.title) document.title = routeTitle(cur, t)
})

export default router
