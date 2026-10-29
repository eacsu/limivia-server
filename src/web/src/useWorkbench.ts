import { useEffect, useState } from 'react'
import { api, friendlyError, initialState, type DeviceState, type Operation } from './device'
export function useWorkbench() {
  const [state, setState] = useState(initialState)
  const [tasks, setTasks] = useState<Operation[]>([])
  const [online, setOnline] = useState(false)
  const [error, setError] = useState('')
  useEffect(
    () =>
      api.subscribe((feed) => {
        if (feed.type === 'snapshot') {
          setState(feed.data as DeviceState)
          if (feed.operations) setTasks(feed.operations)
        }
        if (feed.type === 'operation') {
          const task = feed.data as Operation
          setTasks((previous) =>
            [task, ...previous.filter((t) => t.id !== task.id)]
              .sort((a, b) => b.updated - a.updated)
              .slice(0, 100),
          )
        }
      }, setOnline),
    [],
  )
  const attempt = async <T>(run: () => Promise<T>): Promise<T | undefined> => {
    setError('')
    try {
      return await run()
    } catch (e) {
      setError(friendlyError(e))
      return undefined
    }
  }
  return {
    state,
    tasks,
    online,
    error,
    setError,
    attempt,
    ready: state.status === 'ready',
    enabled: online && state.status === 'ready',
  }
}
