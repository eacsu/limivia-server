import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkbenchAPI, type Operation } from './device'

class Socket {
  static current: Socket
  readyState = 1
  onmessage?: (event: { data: string }) => void
  onclose?: () => void
  send() {}
  close() {}
  constructor() {
    Socket.current = this
  }
  event(task: Operation) {
    this.onmessage?.({ data: JSON.stringify({ type: 'operation', data: task }) })
  }
}
const task = {
  id: 'one',
  generation: 2,
  boot_id: 'boot',
  status: 'running',
  result: null,
} as Operation
let api: WorkbenchAPI
let dispose: () => void
let fetcher: ReturnType<typeof vi.fn>
beforeEach(async () => {
  vi.useFakeTimers()
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem() {} })
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  })
  vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
  vi.stubGlobal('WebSocket', Socket)
  fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ page_session: 'page' }) })
  vi.stubGlobal('fetch', fetcher)
  api = new WorkbenchAPI()
  dispose = api.subscribe(
    () => {},
    () => {},
  )
  for (let i = 0; i < 10; i++) await Promise.resolve()
  fetcher.mockClear()
})
afterEach(() => {
  dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it('uses a terminal event received before wait, without polling', async () => {
  Socket.current.event({ ...task, status: 'completed', result: { level: 1 } })
  await expect(api.wait(task)).resolves.toMatchObject({ result: { level: 1 } })
  expect(fetcher).not.toHaveBeenCalled()
})
it('waits for confirmed completion and ignores an unrelated connection generation', async () => {
  let settled = false
  const waiting = api.wait(task).then((value) => {
    settled = true
    return value
  })
  Socket.current.event({ ...task, generation: 1, status: 'completed' })
  await Promise.resolve()
  expect(settled).toBe(false)
  Socket.current.event({ ...task, status: 'completed', result: { level: 0 } })
  await expect(waiting).resolves.toMatchObject({ result: { level: 0 } })
  await vi.advanceTimersByTimeAsync(1500)
  expect(fetcher).not.toHaveBeenCalled()
})
it('uses a one second read-only watchdog if the terminal event is lost', async () => {
  fetcher.mockResolvedValue({ ok: true, json: async () => ({ ...task, status: 'completed' }) })
  const waiting = api.wait(task)
  await vi.advanceTimersByTimeAsync(999)
  expect(fetcher).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await expect(waiting).resolves.toMatchObject({ status: 'completed' })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0][0]).toBe('/api/operations/one')
  expect(fetcher.mock.calls[0][1].method).toBe('GET')
})
it('reports an unknown outcome without replaying the write', async () => {
  const waiting = expect(api.wait(task)).rejects.toThrow('result_unknown')
  Socket.current.event({ ...task, status: 'unknown', error: { reason: 'result_unknown' } })
  await waiting
  expect(fetcher).not.toHaveBeenCalled()
})
