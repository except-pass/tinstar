// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { StatSpark } from '../StatSpark'

describe('<StatSpark>', () => {
  it('renders label and value', () => {
    const { getByText } = render(
      <StatSpark accent="gold" label="COST" value="$0.42" series={[]} delta={null} />
    )
    expect(getByText('COST')).toBeTruthy()
    expect(getByText('$0.42')).toBeTruthy()
  })

  it('renders em-dash chip when delta is null', () => {
    const { getByText } = render(
      <StatSpark accent="gold" label="COST" value="$0.42" series={[]} delta={null} />
    )
    expect(getByText('—')).toBeTruthy()
  })

  it('renders chip text and tone class when delta is provided', () => {
    const { getByText } = render(
      <StatSpark
        accent="blue"
        label="TOKENS/MIN"
        value="3.2k"
        series={[1, 2, 3]}
        delta={{ text: '+0.8k', tone: 'up' }}
      />
    )
    const chip = getByText('+0.8k')
    expect(chip.className).toMatch(/\bup\b/)
  })

  it('does not render <Sparkline> paths when series is empty', () => {
    const { container } = render(
      <StatSpark accent="green" label="CACHE HIT" value="--" series={[]} delta={null} />
    )
    expect(container.querySelectorAll('path').length).toBe(0)
  })

  it('renders <Sparkline> paths when series has >= 2 numeric points', () => {
    const { container } = render(
      <StatSpark accent="violet" label="DUTY · 60m" value="68%" series={[0.5, 0.6, 0.7]} delta={null} />
    )
    expect(container.querySelectorAll('path').length).toBe(2)
  })
})
