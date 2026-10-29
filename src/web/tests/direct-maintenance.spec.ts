import { test, expect } from '@playwright/test'
import { reset, connect } from './helpers'

test('维护操作直接提交，协议确认参数自动附加且不显示二次确认字段', async ({ page }) => {
  await reset(page)
  await connect(page, 'bus')
  const dialogs: string[] = []
  const submissions: { op: string; args: { confirm: string } }[] = []
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss() })
  // Intercept maintenance commands before they reach the server/device.
  await page.route('**/api/device/operations', async route => {
    const data = route.request().postDataJSON()
    if (['storage.format', 'system.nvs_format'].includes(data.op)) {
      submissions.push(data)
      await route.fulfill({
        status: 202,
        json: { id: 'maintenance-ui-test', status: 'completed', result: { ok: true } },
      })
    } else await route.continue()
  })
  for (const [op, confirmation] of [['storage.format', 'erase_littlefs'], ['system.nvs_format', 'erase_nvs']]) {
    const navigation = page.getByRole('navigation')
    if (op === 'storage.format') {
      await navigation.getByRole('button', { name: '板上文件', exact: true }).click()
      await page.getByRole('button', { name: '打开文件操作', exact: true }).click()
    } else {
      await navigation.getByRole('button', { name: '设备维护', exact: true }).click()
    }
    await page.getByLabel('选择功能').selectOption(op)
    await expect(page.getByText('确认文字', { exact: false })).toHaveCount(0)
    await expect(page.locator('main input[name="confirm"]')).toHaveCount(0)
    await page.locator('main form button.primary').click()
    await expect.poll(() => submissions.some(item => item.op === op)).toBe(true)
    expect(submissions.find(item => item.op === op)?.args.confirm).toBe(confirmation)
  }
  expect(dialogs).toEqual([])
  const commands = (await (await page.request.get('/api/testing/commands')).json()).commands
  expect(commands.some((c: { op: string }) => ['storage.format', 'system.nvs_format'].includes(c.op))).toBe(false)
})
