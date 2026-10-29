import { test, expect } from '@playwright/test'
import { reset, connect, selectPin, openResource, saveGpio } from './helpers'

for (const width of [1280, 1440])
  for (const theme of ['vallum', 'abyssus'])
    test(`紧凑板图完整、图例统一、检查区固定 · ${width} · ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 1280 ? 720 : 900 })
      await reset(page)
      await connect(page, 'bus')
      if (theme === 'abyssus') await page.getByRole('button', { name: '切换苍渊' }).click()
      await selectPin(page, 'R11')
      const board = page.locator('.board-stage .board-viewport > svg.board')
      await expect(board.locator('.pin')).toHaveCount(32)
      await expect(board).toHaveAttribute('data-size', 'regular')
      const box = await board.boundingBox()
      expect(box?.height).toBe(480)
      expect(box?.width).toBe(360)
      await expect(board.locator('.pin text').first()).toHaveCSS('font-size', '13px')
      for (const pin of await board.locator('.pin').all()) {
        await expect(pin).toBeInViewport({ ratio: 0.999 })
        await expect(pin.locator('.pin-hit')).toHaveAttribute('height', '24')
      }
      await expect(page.locator('.board-stage > .board-wrap > .board-legend')).toHaveCount(0)
      await expect(page.locator('.board-stage > .board-wrap > .board-detail')).toHaveCount(0)
      expect(
        await page.locator('.inspector-identity').evaluate((n) => n.getBoundingClientRect().height),
      ).toBe(52)
      expect(
        await page
          .locator('.inspector-diagnostics')
          .evaluate((n) => n.getBoundingClientRect().height),
      ).toBe(32)
      expect(
        await page.locator('.board-stage').evaluate((n) => n.scrollHeight - n.clientHeight),
      ).toBe(0)
      const mask = board.locator('mask image')
      await expect(mask).toHaveAttribute('width', '136')
      await expect(mask).toHaveAttribute('height', '28')
      const assetSize = await page.evaluate(
        async (href) => {
          const image = new Image()
          image.src = href!
          await image.decode()
          return { width: image.naturalWidth, height: image.naturalHeight }
        },
        await mask.getAttribute('href'),
      )
      expect(assetSize).toEqual({ width: 136, height: 28 })
      await page.screenshot({ path: info.outputPath('compact-board.png') })
    })

test('真实十二项能力收纳为八家族，展开互斥、键盘可达且不写设备', async ({ page }) => {
  await reset(page)
  await connect(page, 'bus')
  await selectPin(page, 'R11')
  const before = (await (await page.request.get('/api/testing/commands')).json()).commands.length
  await expect(page.locator('.function-family > button')).toHaveCount(8)
  for (const [family, count] of [
    ['I²C', 2],
    ['SPI', 3],
    ['RMT', 2],
  ] as const) {
    const button = page.locator('.function-family > button').filter({ hasText: family })
    await button.focus()
    await page.keyboard.press('Space')
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.function-family > button[aria-expanded="true"]')).toHaveCount(1)
    await expect(page.locator('.function-subtypes button')).toHaveCount(count)
  }
  await page.getByRole('button', { name: /^诊断信息/ }).click()
  const dialog = page.getByRole('dialog', { name: '诊断信息', exact: true })
  await expect(dialog.getByText('当前固件不可用功能', { exact: true })).toBeVisible()
  await expect(dialog.locator('.unavailable-functions')).not.toHaveAttribute('open')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: /^诊断信息/ })).toBeFocused()
  const commands = (await (await page.request.get('/api/testing/commands')).json()).commands.slice(
    before,
  )
  expect(commands.filter((c: { op: string }) => !['state', 'session.ping'].includes(c.op))).toEqual(
    [],
  )
})

test('窄屏重排保留字号、命中区和说明入口，返回后可从引脚列表选择', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await reset(page)
  await connect(page)
  await page.getByRole('button', { name: '← 返回板卡', exact: true }).click()
  const board = page.locator('.board-stage .board-viewport > svg.board')
  await expect(board).toHaveAttribute('viewBox', '0 0 288 388')
  await expect(board.locator('.pin text').first()).toHaveCSS('font-size', '13px')
  await expect(board.locator('.pin-hit').first()).toHaveAttribute('height', '24')
  await page.getByRole('button', { name: '图例', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '图形含义 · 空闲时不显示图标' })).toContainText('实心与空心表示高／低')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '接线与引脚列表', exact: true }).click()
  await page
    .getByRole('dialog', { name: '接线与引脚列表' })
    .getByRole('button', { name: /^R11 · IO05/ })
    .click()
  await expect(page.locator('.inspector-identity h2')).toHaveText('IO05 / GPIO 5')
  await expect(page.getByLabel('接线与调试详情', { exact: true })).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('从其他引脚切回侧栏接线组时，板图选中与详情保持一致', async ({ page }) => {
  await reset(page)
  await connect(page)
  await openResource(page, 'GPIO')
  await saveGpio(page)
  await selectPin(page, 'R11')
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /^GPIO\d* GPIO · 方案待应用$/ })
    .click()
  await expect(page.locator('.inspector-identity h2')).toHaveText('GPIO4')
  const board = page.locator('.board-stage .board-viewport > svg.board')
  await expect(board.locator('[data-pin-id="R12"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(board.locator('[data-pin-id="R11"]')).toHaveAttribute('aria-pressed', 'false')
})
