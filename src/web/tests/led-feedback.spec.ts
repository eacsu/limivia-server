import { test, expect } from '@playwright/test'
import { reset, connect, ready, selectLed } from './helpers'

test.beforeEach(async ({ page }) => {
  await reset(page)
  await connect(page)
  await selectLed(page)
  await ready(page)
})

for (const theme of ['vallum', 'abyssus'])
  for (const width of [1280, 1440]) {
    test(`连续开关 LED 的反馈不推动页面 · ${theme} · ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width === 1280 ? 720 : 900 })
      if (theme === 'abyssus') await page.getByRole('button', { name: '切换苍渊' }).click()
      const led = page.getByRole('region', { name: '板载 LED 快捷控制' })
      await led.getByRole('button', { name: '点亮 LED', exact: true }).click()
      await expect(led.getByRole('heading', { name: '已点亮', exact: true })).toBeVisible()
      await led.getByRole('button', { name: '熄灭 LED', exact: true }).click()
      await expect(led.getByRole('heading', { name: '已熄灭', exact: true })).toBeVisible()
      await expect(led.getByRole('button', { name: '点亮 LED', exact: true })).toBeEnabled()
      const beforeCommands = (await (await page.request.get('/api/testing/commands')).json())
        .commands.length
      await page.evaluate(() => document.fonts.ready)
      await page.evaluate(() => {
        const samples: {
          y: number
          height: number
          buttonY: number
          notice: boolean
          heading: string
          navigation: string
          summary: string
          connection: string
          record: string
          protocol: string
        }[] = []
        const sample = () => {
          const led = document.querySelector('.home-led')!.getBoundingClientRect()
          const button = document.querySelector('.led-actions button')!.getBoundingClientRect()
          samples.push({
            y: led.y,
            height: led.height,
            buttonY: button.y,
            notice: !!document.querySelector('main > .notice'),
            heading: document.querySelector('.led-output-state h3')!.textContent!,
            navigation: document.querySelector('.sidebar-navigation')!.textContent!,
            summary: document.querySelector('.wiring-toolbar > span')!.textContent!,
            connection: document.querySelector('.connection-status')!.textContent!,
            record: document.querySelector('.diagnostic-bar button')!.textContent!.trim(),
            protocol: document.querySelector('.identity-tag')!.textContent!,
          })
          raf = requestAnimationFrame(sample)
        }
        let raf = requestAnimationFrame(sample)
        Object.assign(window, {
          stopLedGeometrySamples: () => {
            cancelAnimationFrame(raf)
            return samples
          },
        })
      })
      for (let i = 0; i < 3; i++) {
        await led.getByRole('button', { name: '点亮 LED', exact: true }).click()
        await expect(led.getByRole('heading', { name: '已点亮', exact: true })).toBeVisible()
        await expect(led.getByRole('button', { name: '熄灭 LED', exact: true })).toBeEnabled()
        await led.getByRole('button', { name: '熄灭 LED', exact: true }).click()
        await expect(led.getByRole('heading', { name: '已熄灭', exact: true })).toBeVisible()
        await expect(led.getByRole('button', { name: '点亮 LED', exact: true })).toBeEnabled()
      }
      const samples = await page.evaluate(() =>
        (
          window as unknown as {
            stopLedGeometrySamples: () => {
              y: number
              height: number
              buttonY: number
              notice: boolean
              heading: string
              navigation: string
              summary: string
              connection: string
              record: string
              protocol: string
            }[]
          }
        ).stopLedGeometrySamples(),
      )
      expect(samples.length).toBeGreaterThan(10)
      const first = samples[0]
      for (const sample of samples) {
        expect(['已点亮', '已熄灭']).toContain(sample.heading)
        expect(sample.navigation).toBe(first.navigation)
        expect(sample.navigation).not.toContain('待识别')
        expect(sample.summary).toBe(first.summary)
        expect(sample.connection).toBe('已连接')
        expect(sample.record).toBe('操作记录')
        expect(sample.protocol).toBe('signal · 0.3.0-dev')
      }
      const headings = samples
        .map((sample) => sample.heading)
        .filter((heading, index, all) => index === 0 || heading !== all[index - 1])
      expect(headings).toEqual([
        '已熄灭',
        '已点亮',
        '已熄灭',
        '已点亮',
        '已熄灭',
        '已点亮',
        '已熄灭',
      ])
      const commands = (
        await (await page.request.get('/api/testing/commands')).json()
      ).commands.slice(beforeCommands)
      expect(commands.some((c: { op: string }) => c.op === 'capabilities')).toBe(false)
      expect(samples.some((sample) => sample.notice)).toBe(false)
      for (const field of ['y', 'height', 'buttonY'] as const)
        expect(
          Math.max(...samples.map((sample) => sample[field])) -
            Math.min(...samples.map((sample) => sample[field])),
        ).toBeLessThan(0.5)
      await expect(led.getByLabel('LED 操作反馈', { exact: true })).toHaveCSS('height', '40px')
      await testInfo.attach('continuous-layout-samples', {
        body: JSON.stringify(samples),
        contentType: 'application/json',
      })
      await page.mouse.move(0, 0)
      await page.screenshot({ path: testInfo.outputPath('led-feedback-stable.png') })
    })
  }

test('LED 错误在固定反馈区持续显示，修正后可重试', async ({ page }) => {
  const led = page.getByRole('region', { name: '板载 LED 快捷控制' })
  await led.getByRole('button', { name: '呼吸演示', exact: true }).click()
  const before = await led.boundingBox()
  await led.getByLabel('峰值占空比').fill('101')
  await led.getByRole('button', { name: '开始呼吸', exact: true }).click()
  const error = led.getByRole('alert')
  await expect(error).toContainText('峰值占空比须在 0–100% 之间')
  await expect(error).toHaveCSS('height', '40px')
  await expect(led.locator('.inline-error')).toHaveCount(0)
  expect(await led.boundingBox()).toEqual(before)
  // A later user action, rather than a timer, replaces the error.
  await led.getByRole('button', { name: '开关控制', exact: true }).click()
  await led.getByRole('button', { name: '呼吸演示', exact: true }).click()
  await expect(error).toBeVisible()
  await led.getByLabel('峰值占空比').fill('50')
  await led.getByRole('button', { name: '开始呼吸', exact: true }).click()
  await expect(led.getByRole('heading', { name: '呼吸运行中', exact: true })).toBeVisible()
  await expect(led.getByRole('alert')).toHaveCount(0)
})

test('连接关闭仍然明确显示断开提示', async ({ page }) => {
  await page.getByRole('navigation').getByRole('button', { name: '连接详情', exact: true }).click()
  await page
    .getByRole('dialog', { name: '连接设备', exact: true })
    .getByRole('button', { name: '结束实验并断开', exact: true })
    .click()
  await expect(page.locator('.connection-status')).toHaveText('未连接')
  await expect(page.locator('main > .notice')).toContainText('设备状态待同步')
})

test('慢操作保持上次确认值，错误失效后可通过读取恢复', async ({ page }) => {
  const led = page.getByRole('region', { name: '板载 LED 快捷控制' })
  await led.getByRole('button', { name: '点亮 LED', exact: true }).click()
  await expect(led.getByRole('heading', { name: '已点亮', exact: true })).toBeVisible()
  await expect(led.getByRole('button', { name: '熄灭 LED', exact: true })).toBeEnabled()
  await page.request.post('/api/testing/configure', { data: { hold_jobs: true } })
  await led.getByRole('button', { name: '熄灭 LED', exact: true }).click()
  await expect(led.getByRole('button', { name: '熄灭 LED', exact: true })).toBeDisabled()
  await expect(led.getByLabel('LED 操作反馈', { exact: true })).toContainText('等待设备确认')
  await expect(led.getByRole('heading', { name: '已点亮', exact: true })).toBeVisible()
  await expect(led.locator('.led-indicator')).toHaveClass(/\bon\b/)
  await page.request.post('/api/testing/configure', { data: { hold_jobs: false } })
  await expect(led.getByRole('heading', { name: '已熄灭', exact: true })).toBeVisible()
  await expect(led.getByRole('button', { name: '点亮 LED', exact: true })).toBeEnabled()
  // A rejected status call must remove the historical confirmation rather than showing success.
  await page.route('**/api/device/operations', async (route) => {
    const body = route.request().postDataJSON()
    if (body.op === 'resource.call' && body.args.action === 'status')
      await route.fulfill({ status: 409, json: { detail: '测试读回失败，结果待核实' } })
    else await route.continue()
  })
  await led.getByRole('button', { name: '读取状态', exact: true }).click()
  await expect(led.getByRole('heading', { name: '结果待核实', exact: true })).toBeVisible()
  await expect(led.getByRole('alert')).toContainText('测试读回失败')
  await page.unroute('**/api/device/operations')
  await led.getByRole('button', { name: '读取状态', exact: true }).click()
  await expect(led.getByRole('heading', { name: '已熄灭', exact: true })).toBeVisible()
})
