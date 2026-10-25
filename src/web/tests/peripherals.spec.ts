import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import {
  reset,
  connect,
  ready,
  openResource,
  selectPin,
  selectLed,
  saveAndCheck,
  saveGpio,
} from './helpers'
test.beforeEach(async ({ page }) => {
  await reset(page)
  await connect(page)
})
test('局域网 HTTP 缺少 randomUUID 时 GPIO10 仍可打开并保存接线草稿', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.crypto, 'randomUUID', { value: undefined })
  })
  await page.reload()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))
  const before = (await (await page.request.get('/api/testing/commands')).json()).commands.length
  await selectPin(page, 'R5')
  await page.locator('.pin-functions').getByRole('button', { name: /^GPIO/ }).click()
  await expect(page.getByLabel('当前引脚', { exact: true })).toHaveText('GPIO10')
  await saveGpio(page)
  await expect(page.getByRole('button', { name: '保存方案', exact: true })).toBeDisabled()
  await page.reload()
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /^GPIO\d* GPIO · 方案待应用$/ })
    .click()
  await expect(page.getByLabel('当前引脚', { exact: true })).toHaveText('GPIO10')
  expect(errors).toEqual([])
  const commands = (await (await page.request.get('/api/testing/commands')).json()).commands.slice(
    before,
  )
  expect(commands.filter((c: { op: string }) => !['state', 'session.ping'].includes(c.op))).toEqual(
    [],
  )
})
test('从已接线引脚开始，选择与保存不执行设备写入', async ({ page }) => {
  const before = (await (await page.request.get('/api/testing/commands')).json()).commands.length
  await expect(page.getByRole('button', { name: '外设调试', exact: true })).toHaveCount(0)
  await openResource(page, 'PWM')
  await expect(page.getByLabel('当前引脚', { exact: true })).toHaveText('GPIO4')
  await page.locator('.wiring-notes > summary').click()
  await page.getByLabel('接线组名称').fill('风扇调速')
  await page.getByRole('button', { name: '保存方案', exact: true }).click()
  await expect(page.getByRole('button', { name: '保存方案', exact: true })).toBeDisabled()
  await page.reload()
  await page.getByRole('button', { name: /风扇调速/ }).click()
  await expect(page.getByLabel('当前引脚', { exact: true })).toHaveText('GPIO4')
  const commands = (await (await page.request.get('/api/testing/commands')).json()).commands.slice(
    before,
  )
  expect(
    commands.some((c: { op: string }) =>
      ['resource.open', 'resource.call', 'control.acquire'].includes(c.op),
    ),
  ).toBe(false)
})
test('共享方案版本冲突保留本地编辑，不覆盖其他页面', async ({ page, context }) => {
  await openResource(page, 'GPIO')
  await saveGpio(page)
  await expect(page.getByRole('button', { name: '保存方案', exact: true })).toBeDisabled()
  const other = await context.newPage()
  await other.goto('/')
  await other.getByRole('button', { name: /^GPIO\d* GPIO · 方案待应用$/ }).click()

  await other.getByLabel('接线方案名称').fill('另一个页面的草稿')
  await page.getByLabel('接线方案名称').fill('主页面已保存')
  await page.getByRole('button', { name: '保存方案', exact: true }).click()
  await expect(other.getByText('另一页面已修改方案。', { exact: false })).toBeVisible()
  await expect(other.getByLabel('接线方案名称')).toHaveValue('另一个页面的草稿')
  await other.getByRole('button', { name: '保存方案', exact: true }).click()
  await expect(other.getByRole('alert').first()).toBeVisible()
  await other.getByRole('button', { name: '放弃本地修改并载入服务器版本' }).click()
  await expect(other.getByLabel('接线方案名称')).toHaveValue('主页面已保存')
})
test('总线从一个引脚开始，整组补齐接线并带出子设备', async ({ page }) => {
  await openResource(page, 'I²C 主总线')
  await expect(page.getByLabel('SDA 数据 *', { exact: true })).toHaveValue('4')
  await page.getByRole('button', { name: '在板图选择SCL 时钟', exact: true }).click()
  await page.locator('.board-stage [data-pin-id="R11"]:visible').click()
  await expect(page.getByLabel('SCL 时钟 *', { exact: true })).toHaveValue('5')
  await page.getByRole('button', { name: '添加I²C 子设备', exact: true }).click()
  await expect(page.getByLabel('所属总线')).not.toHaveValue('')
  await page.getByRole('button', { name: '保存方案', exact: true }).click()
  await expect(page.getByLabel('接线组名称')).toHaveValue('I²C 子设备')
  await expect(page.locator('.board-stage .grouped-pin:visible')).toHaveCount(2)
})
test('供电、保护脚与片内功能不伪造可配置 GPIO', async ({ page }) => {
  await selectPin(page, 'L1')
  await expect(page.getByRole('heading', { name: '此位置仅查看信息' })).toBeVisible()
  await selectPin(page, 'L4')
  await expect(page.locator('.pin-functions button')).toHaveCount(0)
  await page.getByRole('button', { name: '片内功能', exact: true }).click()
  await page.getByRole('button', { name: '片内温度', exact: true }).click()
  await expect(page.getByLabel('引脚 *', { exact: true })).toHaveCount(0)
})
for (const width of [1280, 1440])
  for (const theme of ['vallum', 'abyssus'])
    test(`板图完整显示与详情局部滚动 · ${width} · ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 1280 ? 720 : 900 })
      if (theme === 'abyssus') await page.getByRole('button', { name: '切换苍渊' }).click()
      await openResource(page, 'GPIO')
      const fixed = () =>
        page.evaluate(() =>
          ['.topbar', '.page-heading', '.wiring-toolbar', '.diagnostic-bar'].map((s) => {
            const r = document.querySelector(s)!.getBoundingClientRect()
            return { y: r.y, h: r.height }
          }),
        )
      const before = await fixed()
      const stage = page.getByLabel('实物板卡与接线', { exact: true })
      await stage.hover()
      await page.mouse.wheel(0, 700)
      expect(await stage.evaluate((n) => n.scrollTop)).toBe(0)
      await expect(
        stage.locator('.board-viewport > svg.board [data-pin-id="L16"]'),
      ).toBeInViewport()
      await expect(
        stage.locator('.board-viewport > svg.board [data-pin-id="R16"]'),
      ).toBeInViewport()
      expect(await fixed()).toEqual(before)
      const notes = page.locator('.wiring-notes')
      if ((await notes.getAttribute('open')) === null) await notes.locator('summary').click()
      const detail = page.locator('.inspector-content')
      await detail.hover()
      await page.mouse.wheel(0, 700)
      await expect.poll(() => detail.evaluate((n) => n.scrollTop)).toBeGreaterThan(0)
      expect(await fixed()).toEqual(before)
      expect(await page.getByRole('main').evaluate((n) => n.scrollTop)).toBe(0)
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
      expect(
        results.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
      ).toEqual([])
      await page.screenshot({ path: info.outputPath('board-workspace.png') })
    })
for (const layout of [
  { width: 320, zoom: 1 },
  { width: 768, zoom: 1 },
  { width: 1280, zoom: 2 },
])
  test(`窄屏与放大可以返回板卡并配置 · ${layout.width} · ${layout.zoom}`, async ({ page }) => {
    await page.setViewportSize({ width: layout.width, height: 900 })
    await page.evaluate((z) => {
      document.documentElement.style.zoom = String(z)
    }, layout.zoom)
    await openResource(page, 'GPIO')
    await expect(page.getByLabel('当前引脚', { exact: true })).toHaveText('GPIO4')
    await expect(page.getByLabel('接线与调试详情', { exact: true })).toBeFocused()
    await page.getByRole('button', { name: '← 返回板卡', exact: true }).click()
    await expect(page.locator('.board-stage [data-pin-id="R12"]:visible')).toBeFocused()
    await selectLed(page)
    await page.getByRole('button', { name: '读取状态', exact: true }).scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
test('接线组明确应用后才创建硬件资源', async ({ page }) => {
  await ready(page)
  await openResource(page, 'PWM')
  await saveAndCheck(page)
  await page.getByRole('button', { name: '应用本组', exact: true }).click()
  await expect(page.getByRole('heading', { name: /#\d+ · PWM/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '应用本组', exact: true })).toBeDisabled()
})
