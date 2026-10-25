import { test, expect } from '@playwright/test'
import { reset, connect } from './helpers'

test('反复通知缺口不改变空闲标签和 LED 按钮可用性', async ({ page }) => {
  await reset(page)
  await connect(page, 'bus')
  await page.request.post('/api/testing/configure', { data: { notification_gaps: true } })
  let gaps = 0
  page.on('websocket', ws => ws.on('framereceived', event => {
    const value = JSON.parse(String(event.payload))
    if (value.type === 'notification' && value.data?.type === 'notifications.gap') gaps++
  }))
  // Reconnect the page feed so the test records every hint during observation.
  await page.reload()
  const led = page.getByRole('region', { name: '板载 LED 快捷控制' })
  await led.getByRole('button', { name: '点亮 LED', exact: true }).click()
  await expect(led.getByRole('heading', { name: '已点亮', exact: true })).toBeVisible()
  await page.evaluate(() => {
    const target = window as typeof window & { stability?: { disabled: boolean[]; labels: string[]; stop: boolean } }
    target.stability = { disabled: [], labels: [], stop: false }
    const sample = () => {
      const s = target.stability!
      s.disabled.push((document.querySelector('.led-actions button.primary') as HTMLButtonElement).disabled)
      s.labels.push(document.querySelector('.board-stage [data-pin-id="R5"]')?.getAttribute('data-pin-symbol') ?? '')
      if (!s.stop) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  await page.waitForTimeout(6500)
  const samples = await page.evaluate(() => {
    const target = window as typeof window & { stability: { disabled: boolean[]; labels: string[]; stop: boolean } }
    target.stability.stop = true
    return target.stability
  })
  expect(gaps).toBeGreaterThanOrEqual(3)
  expect(samples.disabled.every(value => !value)).toBe(true)
  expect(samples.labels.every(value => value === 'empty')).toBe(true)
  for (let n = 0; n < 20; n++) {
    await led.getByRole('button', { name: n % 2 === 0 ? '熄灭 LED' : '点亮 LED', exact: true }).click()
    await expect(led.getByRole('heading', { name: n % 2 === 0 ? '已熄灭' : '已点亮', exact: true })).toBeVisible()
  }
  await led.getByRole('button', { name: '关闭 LED 资源', exact: true }).click()
  await expect(led.getByRole('heading', { name: '未创建 LED 资源', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^(取得|释放|接管)设备控制$/ })).toHaveCount(0)
})
