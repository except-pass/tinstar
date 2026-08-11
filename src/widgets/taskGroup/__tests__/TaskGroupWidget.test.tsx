// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TaskGroupWidget } from '../TaskGroupWidget'

vi.mock('../../../hooks/useDimensionMeta', () => ({
  useDimensionMeta: () => [
    { internalType: 'project', label: 'Project', icon: 'folder' },
  ],
}))

describe('TaskGroupWidget', () => {
  it('renders a dimension ligature as a Material Symbol without styling the label as an icon', () => {
    render(
      <TaskGroupWidget
        data={{
          node: {
            id: 'project-tinstar',
            label: 'tinstar',
            type: 'project',
            entityId: 'tinstar',
            children: [],
          },
          depth: 0,
        }}
        zoom={1}
        isSelected={false}
        isDragging={false}
        isHovered={false}
        isDropTarget={false}
      />,
    )

    expect(screen.getByText('folder')).toHaveClass('material-symbols-outlined')
    expect(screen.getByText('tinstar')).not.toHaveClass('material-symbols-outlined')
  })
})
