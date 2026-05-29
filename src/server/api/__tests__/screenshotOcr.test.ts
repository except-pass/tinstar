import { describe, it, expect } from 'vitest'
import { runOcr } from '../screenshotOcr'

describe('runOcr', () => {
  it('returns null without throwing when the image path does not exist', async () => {
    // tesseract exits non-zero on a missing input; runOcr must swallow.
    const out = await runOcr('/nonexistent/path/that/does/not/exist.png')
    expect(out).toBeNull()
  })
})
