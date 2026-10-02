import request from '@/utils/request'

export const onboardingAPI = {
  /** 已开放的服务商（config.yaml providers.enabled）：[{ id, label, aliases }] */
  providers() {
    return request.get('/providers', { silentError: true })
  },
  /** { needed, has_key, dismissed, step, provider, config_id } */
  status() {
    return request.get('/onboarding/status')
  },
  /** 保存进度：{ step?, provider?, config_id?, dismissed? } */
  saveState(patch) {
    return request.put('/onboarding/state', patch)
  },
  /** 用已保存的配置做连通测试（Key 在服务端取，不回传浏览器）。 */
  test(configId) {
    return request.post('/onboarding/test', { config_id: configId }, { timeout: 60000 })
  },
  /** 内置示例项目。 */
  listSamples() {
    return request.get('/samples')
  },
  /** 载入示例（离线，不花钱）。返回 { drama_id, episode_id, created } */
  seedSample(id) {
    return request.post(`/samples/${encodeURIComponent(id)}/seed`)
  },
}
