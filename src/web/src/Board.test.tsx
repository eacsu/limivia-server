import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Board } from './Board'

it('多个板图及放大图使用独立天线引用，保护状态改用锁图标', () => {
  const markup = renderToStaticMarkup(
    <>
      <Board state={null} selected={11} ready={false} />
      <Board state={null} selected={12} ready={false} />
    </>,
  )
  const ids = [...markup.matchAll(/<mask id="([^"]+)"/g)].map((match) => match[1])
  expect(ids).toHaveLength(4)
  expect(new Set(ids).size).toBe(4)
  const references = [...markup.matchAll(/mask="url\(#([^)]+)\)"/g)].map((match) => match[1])
  expect(references).toHaveLength(4)
  for (const reference of references) expect(ids).toContain(reference)
})
