import { test, expect } from '@playwright/test'
import { reset, connect, selectPin } from './helpers'

test.beforeEach(async ({ page }) => {
  await reset(page)
  await connect(page, 'bus')
})
test('GPIO10 连接后直接点亮、切换、保存和刷新，没有手动预检或重复资源', async ({ page }) => {
  await selectPin(page, 'R5')
  await page.locator('.pin-functions').getByRole('button', { name: /^GPIO/ }).click()
  await expect(page.getByRole('button', { name: '检查本组', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '应用本组', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '保存方案', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: /^模式：/ }).click()
  await page
    .locator('.direct-gpio-actions')
    .getByRole('button', { name: '输出高电平', exact: true })
    .click()
  await expect(page.locator('.gpio-current-reading')).toContainText('高电平 1')
  await page
    .locator('.direct-gpio-actions')
    .getByRole('button', { name: '高电平 1', exact: true })
    .click()
  await expect(page.locator('.gpio-current-reading')).toContainText('低电平 0')
  await page.locator('.wiring-notes > summary').click()
  await page.getByLabel('接线组名称').fill('外置 LED')
  await page.getByRole('button', { name: '保存到接线方案', exact: true }).click()
  await expect(
    page.getByRole('navigation').getByRole('button', { name: /^外置 LED/ }),
  ).toBeVisible()
  await page.reload()
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /^外置 LED/ })
    .click()
  await expect(page.locator('.gpio-current-reading')).toContainText('低电平 0')
  const commands = (await (await page.request.get('/api/testing/commands')).json()).commands
  expect(commands.filter((c: { op: string }) => c.op === 'resource.open')).toHaveLength(1)
  expect(commands.filter((c: { op: string }) => c.op === 'control.acquire')).toHaveLength(1)
  expect(commands.filter((c: { op: string }) => c.op === 'resource.close')).toHaveLength(0)
})

async function outputDraft(page: import('@playwright/test').Page) {
  await selectPin(page, 'R5')
  await page.locator('.pin-functions').getByRole('button', { name: /^GPIO/ }).click()
  await page.getByRole('button', { name: /^模式：/ }).click()
}

test('预检失败解释具体步骤，未创建资源且可修正重试', async ({ page }) => {
  await outputDraft(page)
  await page.route('**/api/device/operations', async (route) => {
    if (route.request().postDataJSON()?.op === 'resource.preflight')
      await route.fulfill({ status: 422, json: { detail: '引脚配置冲突' } })
    else await route.continue()
  })
  const button = page.locator('.direct-gpio-actions button.primary')
  await button.click()
  await expect(page.locator('.direct-gpio-feedback')).toContainText('预检失败')
  await expect(page.locator('.direct-gpio-feedback')).toContainText('引脚配置冲突')
  await expect(button).toBeEnabled()
  expect(
    (await (await page.request.get('/api/testing/commands')).json()).commands.filter(
      (c: { op: string }) => c.op === 'resource.open',
    ),
  ).toHaveLength(0)
  await page.unroute('**/api/device/operations')
  await button.click()
  await expect(page.locator('.gpio-current-reading')).toContainText('高电平 1')
})

test('创建结果不确定时不自动重试，不把目标值显示为实际输出', async ({ page }) => {
  await outputDraft(page)
  let creates = 0
  await page.route('**/api/device/operations', async (route) => {
    if (route.request().postDataJSON()?.op === 'resource.open') {
      creates++
      await route.fulfill({ status: 503, json: { detail: '连接中断，创建结果未知' } })
    } else await route.continue()
  })
  const button = page.locator('.direct-gpio-actions button.primary')
  await button.click()
  await expect(page.locator('.direct-gpio-feedback')).toContainText('创建 GPIO失败')
  await expect(button).toBeDisabled()
  await expect(page.locator('.gpio-current-reading')).not.toContainText('高电平 1')
  expect(creates).toBe(1)
})

test('已连接后主动作直接可用，无手动控制入口', async ({ page }) => {
  await outputDraft(page)
  await expect(page.getByRole('button', { name: /^(取得|释放|接管)设备控制$/ })).toHaveCount(0)
  await page.locator('.direct-gpio-actions button.primary').click()
  await expect(page.locator('.gpio-current-reading')).toContainText('高电平 1')
  await page.locator('.direct-gpio-actions button.primary').click()
  await expect(page.locator('.gpio-current-reading')).toContainText('低电平 0')
  const commands = (await (await page.request.get('/api/testing/commands')).json()).commands
  expect(commands.filter((c: { op: string }) => c.op === 'control.acquire')).toHaveLength(1)
})

test('模式替换直接执行，不弹确认且只重建一次', async ({ page }) => {
  await outputDraft(page)
  await page.locator('.direct-gpio-actions button.primary').click()
  await expect(page.locator('.gpio-current-reading')).toContainText('电平')
  const mode = page.getByRole('button', { name: /^模式：/ })
  await mode.click()
  await mode.click()
  await page.locator('.direct-gpio-actions button.primary').click()
  await expect(page.locator('.gpio-current-value')).toContainText('数字输入')
  const commands = (await (await page.request.get('/api/testing/commands')).json()).commands
  expect(commands.filter((c: { op: string }) => c.op === 'resource.open')).toHaveLength(2)
  expect(commands.filter((c: { op: string }) => c.op === 'resource.close')).toHaveLength(1)
})

for (const width of [1280, 1440])
  test(`主动作和阻塞原因在小窗口可见 ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 900 })
    await outputDraft(page)
    await expect(page.locator('.direct-gpio-actions button.primary')).toBeInViewport()
    await expect(page.locator('.direct-gpio-feedback')).toHaveCount(0)
    const mode = await page.getByRole('button', { name: /^模式：/ }).boundingBox()
    const actions = await page.locator('.direct-gpio-action-host').boundingBox()
    expect(mode!.y + mode!.height).toBeLessThanOrEqual(actions!.y + 1)
    await page.screenshot({ path: info.outputPath('direct-gpio-ready.png') })
  })

for (const width of [320, 1440])
  test(`GPIO10 输入资源刷新后点板图直接进入模式与电平控制，切换和释放均不弹窗 ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const dialogs: string[] = []
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss() })
    await selectPin(page, 'R5')
    await page.locator('.pin-functions').getByRole('button', { name: /^GPIO/ }).click()
    await page.locator('.direct-gpio-actions button.primary').click()
    await expect(page.locator('.gpio-current-value')).toContainText('数字输入')
    await page.reload()
    await selectPin(page, 'R5')
    const mode = page.getByRole('button', { name: /^模式：/ })
    await expect(mode).toHaveText('数字输入')
    await mode.click()
    const action = page.locator('.direct-gpio-actions button.primary')
    await expect(action).toHaveText(/输出(高|低)电平/)
    await action.click()
    await expect(page.locator('.gpio-current-value')).toContainText('数字输出')
    const previous = await action.textContent()
    await action.click()
    await expect(action).not.toHaveText(previous!)
    await page.getByRole('button', { name: '停止并释放引脚', exact: true }).click()
    await expect(page.locator('.gpio-current')).toContainText('尚未启用 GPIO')
    expect(dialogs).toEqual([])
    const commands = (await (await page.request.get('/api/testing/commands')).json()).commands
    expect(commands.filter((c: { op: string }) => c.op === 'resource.open')).toHaveLength(2)
    expect(commands.filter((c: { op: string }) => c.op === 'resource.close')).toHaveLength(2)
  })

test('已有 GPIO 可返回引脚功能选择，仍可选择 PWM 等其他功能', async ({ page }) => {
  await outputDraft(page)
  await page.locator('.direct-gpio-actions button.primary').click()
  await expect(page.locator('.gpio-current-value')).toContainText('数字输出')
  await page.reload()
  await selectPin(page, 'R5')
  await expect(page.getByRole('button', { name: /^模式：/ })).toBeVisible()
  await page.getByRole('button', { name: '选择其他功能', exact: true }).click()
  await expect(page.locator('.pin-functions').getByRole('button', { name: /^PWM/ })).toBeVisible()
})
