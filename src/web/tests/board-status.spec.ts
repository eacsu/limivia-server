import { test, expect, type Page } from '@playwright/test'
import { reset, connect, selectPin } from './helpers'

async function output(page: Page) {
  await selectPin(page, 'R5')
  await page.locator('.pin-functions').getByRole('button', { name: /^GPIO/ }).click()
  await page.getByRole('button', { name: /^模式：/ }).click()
  await page.locator('.direct-gpio-actions button.primary').click()
  await expect(page.locator('.gpio-current-reading')).toContainText('高电平 1')
}
for (const theme of ['vallum', 'abyssus'])
  for (const width of [320, 1280, 1440])
    test(`逐引脚显示模式和确认值且切换不改变右栏几何 ${theme} ${width}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 1280 ? 720 : 900 })
      await reset(page)
      await connect(page, 'bus')
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      )
      await output(page)
      await page.evaluate(() => document.fonts.ready)
      const toggle = page.locator('.direct-gpio-actions button.primary')
      await toggle.scrollIntoViewIfNeeded()
      await page.route('**/api/device/operations', async (route) => {
        if (route.request().postDataJSON()?.args?.action === 'write')
          await new Promise((r) => setTimeout(r, 250))
        await route.continue()
      })
      await page.evaluate(() => {
        const samples: number[][] = []
        const target = window as typeof window & { gpioGeometry?: number[][]; gpioStop?: boolean }
        target.gpioGeometry = samples
        target.gpioStop = false
        const sample = () => {
          const selectors = [
            '.gpio-current',
            '.direct-gpio h3',
            '.direct-gpio-action-host',
            '.direct-gpio-actions button.primary',
          ]
          samples.push(
            selectors.flatMap((selector) => {
              const box = document.querySelector(selector)!.getBoundingClientRect()
              return [box.y, box.height, box.width]
            }),
          )
          if (!target.gpioStop) requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      })
      for (let n = 0; n < 3; n++) {
        await toggle.click()
        await expect(toggle).toBeEnabled()
      }
      await expect(page.locator('.gpio-current-reading')).toContainText('低电平 0')
      await expect(page.locator('.gpio-current-feedback')).toHaveCount(0)
      await expect(page.locator('.direct-gpio-feedback')).toHaveCount(0)
      const frames = await page.evaluate(() => {
        const target = window as typeof window & { gpioGeometry?: number[][]; gpioStop?: boolean }
        target.gpioStop = true
        return target.gpioGeometry!
      })
      expect(frames.length).toBeGreaterThan(12)
      for (let i = 0; i < frames[0].length; i++)
        expect(
          Math.max(...frames.map((f) => f[i])) - Math.min(...frames.map((f) => f[i])),
        ).toBeLessThanOrEqual(1)
      if (width === 320) await page.getByRole('button', { name: '← 返回板卡', exact: true }).click()
      await expect(
        page.locator('.board-stage .board-viewport [data-pin-id="L1"] .pin-state'),
      ).toHaveCount(0)
      await expect(
        page.locator('.board-stage .board-viewport [data-pin-id="R2"] .pin-state'),
      ).toHaveCount(0)
      const pin = page.locator('.board-stage .board-viewport [data-pin-id="R5"]')
      await expect(pin).toHaveAttribute('data-pin-mode', 'output')
      await expect(pin).toHaveAttribute('data-pin-level', '0')
      await expect(pin.locator('.pin-state-icon')).toHaveAttribute('data-state-icon', 'low')
      await expect(pin.locator('.pin-state-icon')).toHaveAttribute('data-flipped', 'false')
      await expect(pin).toHaveAttribute('aria-label', /数字输出.*低电平 0/)
      const bounds = await page.locator('.board-stage .board-viewport svg.board').evaluate((svg) => {
        const width = svg.getBoundingClientRect().width
        return [...svg.querySelectorAll('.pin > text')].map((text) => {
          const box = text.getBoundingClientRect(),
            parent = svg.getBoundingClientRect()
          return box.left >= parent.left - 1 && box.right <= parent.left + width + 1
        })
      })
      expect(bounds.every(Boolean)).toBe(true)
      await page.screenshot({ path: info.outputPath('board-mode-level.png') })
    })
