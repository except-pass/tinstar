import { describe, it, expectTypeOf } from 'vitest'
import type { WidgetProps } from '../index'

describe('WidgetProps<T>', () => {
  it('defaults T to unknown when omitted', () => {
    expectTypeOf<WidgetProps['data']>().toEqualTypeOf<unknown>()
  })

  it('narrows data when T is provided', () => {
    interface MyWidget { foo: string }
    expectTypeOf<WidgetProps<MyWidget>['data']>().toEqualTypeOf<MyWidget>()
  })

  it('preserves the rest of the props regardless of T', () => {
    expectTypeOf<WidgetProps['zoom']>().toEqualTypeOf<number>()
    expectTypeOf<WidgetProps['isSelected']>().toEqualTypeOf<boolean>()
  })
})
