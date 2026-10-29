import { test, expect } from '@playwright/test'
import { reset, connect, ready, openResource, saveAndCheck } from './helpers'
test('导航与设备上下文按固件能力展示', async ({ page }) => {
  await reset(page)
  const nav = page.getByRole('navigation', { name: '工作台导航' })
  await expect(nav.getByRole('button', { name: '外设调试', exact: true })).toHaveCount(0)
  for (const name of ['离线流程', '联网通信', '板上文件', '设备维护']) {
    await expect(nav.getByRole('button', { name, exact: true })).toBeDisabled()
  }
  await connect(page)
  await expect(nav.getByRole('button', { name: '联网通信', exact: true })).toBeDisabled()
  await expect(nav.getByRole('button', { name: '板上文件', exact: true })).toBeEnabled()
  await nav.getByRole('button', { name: '连接详情', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '连接设备', exact: true })).toBeVisible()
})
test('接线组草稿跨导航保留，导航不重复应用', async ({ page }) => {
  await reset(page)
  await connect(page)
  await ready(page)
  await openResource(page, 'PWM')
  await expect(page.getByLabel('当前引脚', { exact: true })).toHaveText('GPIO4')
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '设备工作台', exact: true })
    .click()
  await expect(page.getByLabel('当前引脚', { exact: true })).toHaveText('GPIO4')
  await saveAndCheck(page)
  await page.getByRole('button', { name: '应用本组', exact: true }).click()
  await expect(page.getByRole('heading', { name: /#\d+ · PWM/ })).toBeVisible()
  await page.getByRole('navigation').getByRole('button', { name: '离线流程', exact: true }).click()
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '设备工作台', exact: true })
    .click()
  await expect(page.getByRole('heading', { name: /#\d+ · PWM/ })).toBeVisible()
  const commands = (await (await page.request.get('/api/testing/commands')).json()).commands
  expect(commands.filter((c: { op: string }) => c.op === 'resource.open')).toHaveLength(1)
  for (const theme of ['vallum', 'abyssus']) {
    if (theme === 'abyssus') await page.getByRole('button', { name: '切换苍渊' }).click()
    for (const image of await page.locator('.nav-icon img:visible').all())
      await expect(image).toHaveJSProperty('naturalWidth', 16)
  }
})
