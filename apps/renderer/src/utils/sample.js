import { onboardingAPI } from '@/api/onboarding'
import { seedAndLocate } from './sampleRoute'

export { SAMPLE_ID, storyboardLocation } from './sampleRoute'

export function seedSampleLocation() {
  return seedAndLocate(onboardingAPI)
}
