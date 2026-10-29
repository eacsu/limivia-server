import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFileSync } from 'node:fs'
import { reset, connect, ready, openResource } from './helpers'
import { kindNames } from '../src/device'
const fixture = JSON.parse(readFileSync('../../tests/capabilities-v3.json', 'utf8')) as {
  profiles: Record<string, Record<string, { items: unknown[] }>>
}
const kinds = new Map<string, string>()
for (const [profile, pages] of Object.entries(fixture.profiles))
  for (const page of Object.values(pages))
    for (const raw of page.items) {
      const item = raw as { kind?: string; available?: boolean }
      if (item.kind && item.available && !kinds.has(item.kind)) kinds.set(item.kind, profile)
    }
for (const [kind, profile] of kinds)
  test(`能力表单 · ${kind}`, async ({ page }) => {
    await reset(page)
    await connect(page, profile)
    await ready(page)
    await openResource(page, kindNames[kind] ?? kind)
    const nameField = page.getByLabel('接线组名称', { exact: true })
    if (!(await nameField.isVisible())) await page.locator('.wiring-notes > summary').click()
    await expect(nameField).toBeVisible()
    if (kind === 'gpio') {
      await expect(page.locator('.direct-gpio-actions button.primary')).toBeEnabled()
      return
    }
    await expect(page.getByRole('button', { name: '应用本组', exact: true })).toBeDisabled()
    await expect(page.getByText('先保存方案，再检查并应用本组。')).toBeVisible()
  })
for (const theme of ['vallum', 'abyssus'])
  for (const width of [320, 768, 1280, 1440])
    test(`布局与可访问性 · ${theme} · ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width === 1280 ? 720 : 900 })
      await reset(page)
      await connect(page)
      if (theme === 'abyssus') await page.getByRole('button', { name: '切换苍渊' }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
      expect(
        results.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
        })),
      ).toEqual([])
      await page.screenshot({ path: testInfo.outputPath('workbench.png'), fullPage: true })
      await page
        .getByRole('navigation')
        .getByRole('button', { name: '离线流程', exact: true })
        .click()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      await page.screenshot({ path: testInfo.outputPath('flow.png'), fullPage: true })
    })
for (const theme of ['vallum', 'abyssus'])
  test(`工作页面表单可访问性 · ${theme}`, async ({ page }) => {
    await reset(page)
    await connect(page, 'iot')
    await ready(page)
    if (theme === 'abyssus') await page.getByRole('button', { name: '切换苍渊' }).click()
    for (const title of ['设备工作台', '离线流程', '板上文件', '联网通信', '设备维护']) {
      await page.getByRole('navigation').getByRole('button', { name: title, exact: true }).click()
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
      expect(results.violations.map((v) => ({ id: v.id, nodes: v.nodes }))).toEqual([])
    }
  })
test('键盘跳转主区和 200% 放大布局', async ({ page }, testInfo) => {
  await reset(page)
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: '跳到主工作区' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('main')).toBeFocused()
  await connect(page)
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2'
  })
  await page.screenshot({ path: testInfo.outputPath('zoom.png'), fullPage: true })
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    outside: Array.from(document.querySelectorAll('*'))
      .filter(
        (element) =>
          element.getBoundingClientRect().right > innerWidth + 1 &&
          element.getBoundingClientRect().width > 0,
      )
      .slice(0, 16)
      .map((element) => ({ tag: element.tagName, name: element.className })),
  }))
  expect(layout.scroll, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width)
  await page.getByRole('navigation').getByRole('button', { name: '离线流程', exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
test('物理板图保留 32 引脚、正反面和 Escape 返回焦点', async ({ page }) => {
  await reset(page)
  await connect(page)
  const trigger = page.getByRole('button', { name: '放大接线图', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: '实物接线图 · 32 引脚' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('svg.board').first().locator('.pin')).toHaveCount(32)
  await dialog.getByRole('button', { name: '背面', exact: true }).first().click()
  await expect(dialog.getByRole('group', { name: /背面接线图/ }).first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(trigger).toBeFocused()
})
