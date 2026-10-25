import { test, expect } from '@playwright/test'
import { reset, connect, selectPin } from './helpers'

test('首次进入默认展开 D5，显式选择不会被后续界面更新覆盖', async ({ page, context }) => {
  await reset(page)
  await connect(page)
  const before = (await (await page.request.get('/api/testing/commands')).json()).commands.length
  await expect(page.locator('.board-inspector .home-led')).toBeVisible()
  await expect(
    page.locator('.board-stage svg.board').first().locator('[data-pin-id="L10"]'),
  ).toHaveAttribute('aria-pressed', 'true')
  await selectPin(page, 'R12')
  await expect(page.locator('.board-inspector .inspector-identity h2')).toContainText('IO04')
  await page.getByRole('button', { name: '切换苍渊' }).click()
  await expect(page.locator('.board-inspector .inspector-identity h2')).toContainText('IO04')
  const other = await context.newPage()
  await other.goto('/')
  await expect(other.locator('.board-inspector .home-led')).toBeVisible()
  const commands = (await (await page.request.get('/api/testing/commands')).json()).commands.slice(
    before,
  )
  expect(
    commands.filter((c: { op: string }) =>
      ['control.acquire', 'resource.open', 'resource.call'].includes(c.op),
    ),
  ).toEqual([])
})

test('窄屏首次显示 LED，返回板卡后保持选择；定位标记尊重减少动态效果', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await reset(page)
  await connect(page)
  await expect(page.locator('.board-inspector .home-led')).toBeVisible()
  await page.getByRole('button', { name: '← 返回板卡', exact: true }).click()
  const svg = page.locator('.board-stage .board-wrap > .board-viewport > svg.board')
  await expect(svg).toBeVisible()
  await expect(svg.locator('.pin-led-mark')).toHaveCount(1)
  await expect(svg.locator('[data-pin-id="L10"] .pin-led-mark')).toBeVisible()
  await expect(svg.locator('[data-pin-id="R11"] .pin-led-mark')).toHaveCount(0)
  await expect(svg.locator('.pin-led-mark')).toHaveCSS('animation-duration', '7.2s')
  await expect(svg.locator('.pin-led-mark')).toHaveCSS('animation-iteration-count', 'infinite')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(svg.locator('.pin-led-mark')).toHaveCSS('animation-name', 'none')
  await page.getByRole('button', { name: '切换苍渊' }).click()
  await expect(svg).toBeVisible()
})

test('标签页使用原始品牌矢量，并随浏览器配色切换', async ({ page, context }) => {
  await reset(page)
  const href = await page.locator('link[rel="icon"]').getAttribute('href')
  expect(href).toBe('/favicon.svg')
  for (const [scheme, color] of [
    ['light', 'rgb(93, 112, 108)'],
    ['dark', 'rgb(180, 210, 233)'],
  ] as const) {
    const icon = await context.newPage()
    await icon.emulateMedia({ colorScheme: scheme })
    await icon.goto('/favicon.svg')
    await expect(icon.locator('svg')).toHaveAttribute('viewBox', '0 0 32 32')
    await expect(icon.locator('path')).toHaveAttribute('d', 'M6 3H11V24H26V29H6V3Z')
    await expect(icon.locator('path')).toHaveCSS('fill', color)
    await icon.close()
  }
})
