import type { FloorScene } from './presentation'
import { freshObservation } from '../shared/workHealth'

export function completeSceneSources(scene: FloorScene, now: number) {
  return freshObservation(scene.coverage.intentions, now) && scene.coverage.homes.length > 0 &&
    scene.coverage.homes.every(home => freshObservation(home.observation, now))
}

