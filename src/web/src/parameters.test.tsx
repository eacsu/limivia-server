import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Fields } from './Forms'
import { parameterOptions, parameterRange } from './parameters'

it('枚举默认值与渲染共用空格、逗号和竖线解析', () => {
  expect(
    parameterOptions({ name: 'mode', type: 'enum', values: ' input output,open_drain|extra ' }),
  ).toEqual(['input', 'output', 'open_drain', 'extra'])
})
it('空边界、布尔和枚举不显示伪范围，零边界保持有效', () => {
  expect(parameterRange({ name: 'invert', type: 'boolean', min: null, max: null })).toBeUndefined()
  expect(
    parameterRange({ name: 'mode', type: 'enum', values: 'input output', min: null, max: null }),
  ).toBeUndefined()
  expect(parameterRange({ name: 'n', type: 'number', min: null, max: null })).toBeUndefined()
  expect(parameterRange({ name: 'n', type: 'number', min: 0, max: 1 })).toBe('0–1')
  expect(parameterRange({ name: 'n', type: 'integer', min: 0, max: null })).toBe('≥ 0')
  expect(parameterRange({ name: 'n', type: 'integer', min: null, max: 5 })).toBe('≤ 5')
  const html = renderToStaticMarkup(
    <Fields
      fields={[
        { name: 'invert', type: 'boolean', min: null, max: null },
        { name: 'n', type: 'integer', min: 0, max: null },
      ]}
      value={{}}
      onChange={() => {}}
    />,
  )
  expect(html).not.toContain('不限')
  expect(html).not.toContain('min="null"')
  expect(html).toContain('≥ 0')
})
