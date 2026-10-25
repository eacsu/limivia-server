import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type DeviceState } from './device'
import { mergeSavedPlan, type WiringPlan } from './wiring'
export function useWiring(state: DeviceState) {
  const deviceId = state.identity?.device_id ?? ''
  const [loadedDevice, setLoadedDevice] = useState('')
  const [plan, setPlan] = useState<WiringPlan | null>(null)
  const [saved, setSaved] = useState<WiringPlan | null>(null)
  const [remote, setRemote] = useState<WiringPlan | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const current = useRef({ deviceId, plan, saved, loadedDevice, remote })
  useEffect(() => {
    current.current = { deviceId, plan, saved, loadedDevice, remote }
  }, [deviceId, plan, saved, loadedDevice, remote])
  const load = useCallback(async () => {
    if (!deviceId) return
    try {
      const value = await api.request<WiringPlan>(
        '/api/wiring-plans/' + encodeURIComponent(deviceId),
      )
      if (current.current.deviceId !== deviceId) return
      const local = current.current
      if (local.loadedDevice === deviceId && value.revision < (local.saved?.revision ?? 0)) return
      if (
        local.loadedDevice === deviceId &&
        local.plan &&
        local.saved &&
        JSON.stringify(local.plan) !== JSON.stringify(local.saved)
      ) {
        if (value.revision !== local.saved.revision) setRemote(value)
      } else {
        setLoadedDevice(deviceId)
        setPlan(value)
        setSaved(value)
        setRemote(null)
      }
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [deviceId])
  useEffect(() => {
    const initial = setTimeout(() => {
      void load()
    }, 0)
    // One existing socket owns reconnection and page presence; observe its notifications via window events.
    const changed = (event: Event) => {
      const detail = (event as CustomEvent).detail
      const id = detail?.device_id
      const local = current.current
      if (
        local.loadedDevice === deviceId &&
        detail?.revision !== undefined &&
        (local.saved?.revision === detail.revision || local.remote?.revision === detail.revision)
      )
        return
      if (!id || id === deviceId) void load()
    }
    window.addEventListener('wiring-changed', changed)
    return () => {
      clearTimeout(initial)
      window.removeEventListener('wiring-changed', changed)
    }
  }, [deviceId, load])
  const dirty =
    loadedDevice === deviceId && !!plan && JSON.stringify(plan) !== JSON.stringify(saved)
  const saveDraft = async (
    submitted: WiringPlan,
    association?: {
      group_id: string
      name: string
      notes: string
      resource: number
      instance: number
    },
  ) => {
    if (!plan || !deviceId) return
    const baseline = plan
    setSaving(true)
    setError('')
    try {
      const value = association
        ? await api.request<WiringPlan>('/api/device/wiring-groups/from-resource', 'POST', {
            ...association,
            plan: submitted,
            revision: submitted.revision,
            device_id: deviceId,
            ...api.deviceScope(),
          })
        : await api.request<WiringPlan>(
            '/api/wiring-plans/' + encodeURIComponent(deviceId),
            'PUT',
            submitted,
          )
      if (current.current.deviceId !== deviceId) return
      setSaved(value)
      setPlan((local) =>
        local === baseline ? value : local ? mergeSavedPlan(local, baseline, value) : value,
      )
      setRemote(null)
      return value
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      await load()
      throw e
    } finally {
      setSaving(false)
    }
  }
  return {
    plan: loadedDevice === deviceId ? plan : null,
    setPlan,
    dirty,
    saving,
    saved,
    remote,
    error,
    load,
    save: async () => {
      if (plan) await saveDraft(plan)
    },
    saveDraft,
    acceptRemote: () => {
      if (remote) {
        setPlan(remote)
        setSaved(remote)
        setRemote(null)
        setError('')
      }
    },
  }
}
export type WiringWorkspace = ReturnType<typeof useWiring>
