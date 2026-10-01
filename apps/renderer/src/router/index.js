import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'list',
      component: () => import('@/views/FilmList.vue'),
      meta: { title: '项目列表' }
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
    {
      path: '/settings/shortcuts',
      name: 'keyboard-settings',
      component: () => import('@/views/KeyboardSettings.vue'),
      meta: { title: '快捷键设置' }
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
      path: '/media-library',
      name: 'media-library',
      component: () => import('@/views/MediaLibrary.vue'),
      meta: { title: '媒体素材库' }
    }
  ]
})

router.beforeEach((to) => {
  if (to.meta.title) {
    document.title = `${to.meta.title} - LocalMiniDrama`
  }
  return true
})

export default router
