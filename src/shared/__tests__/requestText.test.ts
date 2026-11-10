import { expect, it } from 'vitest'
import { displayRequestText } from '../requestText'
import { workflowMarkers } from '../workflowMarkers'

it('hides every workflow protocol marker while preserving surrounding human prose', () => {
  for (const prefix of Object.values(workflowMarkers)) {
    const protocol = `${prefix} {"id":"private-request","data":["private-operation"]}`
    for (const value of [protocol, `  ${protocol}`]) {
      expect(displayRequestText(`Keep the existing replica.\n${value}\nVerify after release.`)).toBe('Keep the existing replica.\nVerify after release.')
      expect(displayRequestText(value, 'Source details')).toBe('Source details')
    }
  }
})
