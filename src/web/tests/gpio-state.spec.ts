import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { reset, connect, ready, openResource, startGpio } from './helpers'

async function applyGpio(page: Page, mode: 'input' | 'output' | 'open_drain' = 'output') {
  await ready(page)
  await openResource(page, 'GPIO')
  const button = page.getByRole('button', { name: /^模式：/ })
  if (mode !== 'input') await button.click()
  if (mode === 'open_drain') await button.click()
  if (mode !== 'input') {
    await page.locator('.advanced-config > summary').click()
    await page.getByRole('button', { name: /^初始电平：/ }).click()
    await page.locator('.advanced-config > summary').click()
  }
  await startGpio(page)
  await expect(page.locator('.gpio-current-reading')).toContainText('电平')
}
test.beforeEach(async ({ page }) => {
  await reset(page)
  await connect(page, 'bus')
})

test('配置按钮具有按钮外观，草稿与实际输出独立', async ({ page }) => {
  await applyGpio(page)
  const status = page.getByRole('region', { name: '设备当前状态' })
  await expect(status).toContainText('GPIO4 · 数字输出')
  await expect(status).toContainText('低电平 0')
  await page.locator('.advanced-config > summary').click()
  const initial = page.getByRole('button', { name: /^初始电平：/ })
  await expect(initial).toHaveCSS('border-radius', '6px')
  await expect(initial.locator('svg')).toHaveCount(0)
  await initial.click()
  await expect(initial).toHaveText('高电平 1')
  await expect(status).toContainText('低电平 0')
  await page.locator('.direct-gpio-actions button.primary').click()
  await expect(status.locator('.gpio-current-reading')).toContainText('高电平 1')
  await expect(page.getByLabel('选中引脚当前状态')).toContainText('数字输出 · 高电平 1')
  const commands = (await (await page.request.get('/api/testing/commands')).json()).commands
  const calls = commands.filter((c: { op: string }) => c.op === 'resource.call')
  expect(calls.some((c: { params: { action: string } }) => c.params.action === 'status')).toBe(true)
  expect(
    calls.filter((c: { params: { action: string } }) => c.params.action === 'write'),
  ).toHaveLength(1)
})

test('慢写入保持确认值、禁止连点，失败后读取恢复', async ({ page }) => {
  await applyGpio(page)
  const status = page.locator('.gpio-current')
  await page.route('**/api/device/operations', async (route) => {
    if (route.request().postDataJSON()?.args?.action === 'write')
      await new Promise((resolve) => setTimeout(resolve, 400))
    await route.continue()
  })
  const toggle = page.locator('.direct-gpio-actions button.primary')
  await toggle.click()
  await expect(toggle).toBeDisabled()
  await expect(status.locator('.gpio-current-reading')).toContainText('低电平 0')
  await expect(status.locator('.gpio-current-reading')).toContainText('高电平 1')
  await page.unroute('**/api/device/operations')
  await page.route('**/api/device/operations', async (route) => {
    const data = route.request().postDataJSON()
    if (data?.args?.action === 'write')
      await route.fulfill({ status: 503, json: { detail: '测试写入失败' } })
    else await route.continue()
  })
  await toggle.click()
  await expect(page.locator('.direct-gpio-feedback[role=alert]')).toContainText('待核实')
  await expect(toggle).toBeDisabled()
  await page.getByRole('button', { name: '核对当前资源', exact: true }).click()
  await expect(toggle).toBeEnabled()
  await expect(status.locator('.gpio-current-reading')).toContainText('高电平 1')
})

test('输入只读、观察页不可切换，开漏高电平说明释放', async ({ page, context }) => {
  await applyGpio(page, 'open_drain')
  await page.locator('.direct-gpio-actions button.primary').click()
  await expect(page.locator('.gpio-current')).toContainText('开漏输出需要外部上拉')
  const observer = await context.newPage()
  await observer.goto('/')
  await observer
    .getByRole('navigation')
    .getByRole('button', { name: /^GPIO · GPIO 4/ })
    .click()
  await expect(observer.locator('.gpio-current-reading')).toContainText('电平')
  await expect(observer.locator('.direct-gpio-actions button.primary')).toBeEnabled()
  await observer.close()
})

test('数字输入只显示输入电平，未应用不推断硬件状态', async ({ page }) => {
  await openResource(page, 'GPIO')
  await expect(page.locator('.gpio-current')).toContainText('未启用')
  await expect(page.locator('.gpio-current-controls')).toHaveCount(0)
  await ready(page)
  await startGpio(page)

  await expect(page.locator('.gpio-current-reading')).toContainText(/输入电平：(高|低)电平 [01]/)
  await expect(
    page.locator('.gpio-current').getByRole('button', { name: /^切换实际输出/ }),
  ).toHaveCount(0)
})

test('资源关闭后清除确认状态，不把旧电平当作未应用引脚的状态', async ({ page }) => {
  await applyGpio(page)
  await page.getByText('资源详情与高级操作', { exact: true }).click()
  await page.getByRole('button', { name: '关闭资源', exact: true }).click()
  await expect(page.locator('.gpio-current')).toContainText('尚未启用 GPIO')
  await expect(page.locator('.gpio-current')).not.toContainText('低电平 0')
  await expect(page.locator('.gpio-output-button')).toHaveCount(0)
})

for (const theme of ['vallum', 'abyssus'])
  for (const width of [320, 1280, 1440])
    test(`状态与按钮布局 ${theme} ${width}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 1280 ? 720 : 900 })
      if (theme === 'abyssus') await page.getByRole('button', { name: '切换苍渊' }).click()
      await applyGpio(page)
      await expect(page.locator('.gpio-current')).toBeVisible()
      if (width === 1280)
        for (const pin of await page.locator('.board-stage .board-viewport > svg.board .pin').all())
          await expect(pin).toBeInViewport({ ratio: 0.999 })
      await expect(page.locator('.gpio-current-controls button').first()).toBeInViewport()
      const button = page.getByRole('button', { name: /^模式：/ })
      expect((await button.boundingBox())!.width).toBeLessThan(width === 320 ? 288 : 367)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      if (width === 320) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await page.locator('.inspector-content').evaluate((node) => node.scrollTo({ top: 0 }))
      const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
      expect(accessibility.violations.map((v) => v.id)).toEqual([])
      await page.screenshot({ path: info.outputPath('gpio-state.png') })
    })
