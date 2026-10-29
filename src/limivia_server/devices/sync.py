"""连接内共享查询与读数健康；通知提示不撤销已经确认的事实。"""

from __future__ import annotations

import asyncio
import time


class StateSync:
    def __init__(self, service):
        self.service = service
        self.snapshot_task = None
        self.snapshot_scope = None
        self.snapshot_failed_at = None
        self.structure_version = 0
        self.foreground_version = 0
        self.reads = {}
        self.failures = {}
        self.versions = {}
        self.grace = 3.0
        self.snapshot_duration = 0.0
        self.initial_failure_scope = None

    def reset(self):
        self.snapshot_scope = None
        self.snapshot_failed_at = None
        self.snapshot_duration = 0.0
        self.foreground_version = 0
        self.initial_failure_scope = None
        self.reads.clear()
        self.failures.clear()
        self.versions.clear()

    def invalidate_structure(self):
        self.structure_version += 1

    def restore_readiness(self):
        service = self.service
        if (
            self.initial_failure_scope == (service.generation, service.business)
            and service.state["discovery"] is not None
            and service.state["snapshot_sync"]["state"] == "current"
        ):
            self.initial_failure_scope = None
            service.state.update(status="ready", stale=False, error=None)

    def invalidate(self, resource):
        key = str(resource)
        self.versions[key] = self.versions.get(key, 0) + 1

    def snapshot_failed(self, error, started=None):
        service = self.service
        now = time.monotonic()
        if self.snapshot_failed_at is None:
            self.snapshot_failed_at = now if started is None else started
        unavailable = now - self.snapshot_failed_at >= self.grace
        service.state["snapshot_sync"] = {
            **service.state["snapshot_sync"],
            "state": "unavailable" if unavailable else "recovering",
            "error": service.clean(
                {
                    "reason": getattr(getattr(error, "error", None), "reason", "snapshot_read"),
                    "message": str(error),
                }
            ),
        }
        service.state["stale"] = unavailable

    async def snapshot(self, *, wait_timeout=None):
        service = self.service
        driver, generation = service.business, service.generation
        if not driver or service.ending:
            raise ValueError("设备连接不可用。")
        scope = (generation, driver)
        if scope != self.snapshot_scope or self.snapshot_task is None or self.snapshot_task.done():
            self.snapshot_scope = scope
            self.snapshot_task = service.spawn(self._snapshot(driver, generation))
        task = self.snapshot_task
        started = time.monotonic()
        try:
            # BLE 多页快照可能超过读数宽限；用已确认查询耗时预留下一次完整分页的预算。
            budget = max(self.grace, self.snapshot_duration * 2 + self.grace)
            return await asyncio.wait_for(
                asyncio.shield(task), budget if wait_timeout is None else wait_timeout
            )
        except TimeoutError as exc:
            if scope == (service.generation, service.business) and not service.foreground_pending():
                self.snapshot_failed(exc, started)
                service.changed()
            raise

    async def _snapshot(self, driver, generation):
        service = self.service
        started = time.monotonic()
        try:
            while True:
                version = self.structure_version
                foreground = self.foreground_version
                try:
                    snapshot = (await driver.board.state.snapshot()).model_dump(mode="json")
                except Exception as exc:
                    if (
                        getattr(getattr(exc, "error", None), "reason", None) == "snapshot_expired"
                        and foreground != self.foreground_version
                        and generation == service.generation
                        and driver is service.business
                        and not service.ending
                    ):
                        # A local fast operation invalidated these pages. Restart only the
                        # read; this is scheduling progress, not a failed device observation.
                        continue
                    raise
                if (
                    generation != service.generation
                    or driver is not service.business
                    or service.ending
                ):
                    raise ValueError("连接代次已改变。")
                if version == self.structure_version:
                    break
            service._apply_snapshot(snapshot)
            self.snapshot_duration = time.monotonic() - started
            self.snapshot_failed_at = None
            service.state["snapshot_sync"] = {
                "state": "current",
                "last_success_at": time.time(),
                "error": None,
            }
            self.restore_readiness()
            service.changed()
            return snapshot
        except Exception as exc:
            if (
                generation == service.generation
                and driver is service.business
                and not service.foreground_pending()
            ):
                self.snapshot_failed(exc)
            raise

    def resource(self, resource_id):
        return next(
            (
                r
                for r in (self.service.state["snapshot"] or {}).get("resources", [])
                if r["id"] == resource_id
            ),
            None,
        )

    def failed(self, resource, error, started=None):
        key = str(resource["id"])
        now = time.monotonic()
        first = self.failures.setdefault(key, now if started is None else started)
        current = self.service.resource_observations.get(key)
        if current and current["instance"] == resource["instance"] and now - first < self.grace:
            current["quality"] = "recovering"
        else:
            self.service._observe(resource, error=True)
        observation = self.service.resource_observations.get(key)
        if observation:
            observation["error"] = self.service.clean(str(error))

    async def read(self, resource):
        service = self.service
        driver, generation = service.business, service.generation
        if not driver or service.ending:
            raise ValueError("设备连接不可用。")
        key = str(resource["id"])
        version = self.versions.get(key, 0)
        scope = (generation, driver, resource["instance"], version)
        existing = self.reads.get(key)
        if not existing or existing[0] != scope or existing[1].done():
            task = service.spawn(self._read(resource, driver, generation, version))
            self.reads[key] = (scope, task)
        else:
            task = existing[1]
        started = time.monotonic()
        try:
            return await asyncio.wait_for(asyncio.shield(task), self.grace)
        except TimeoutError as exc:
            if (
                generation == service.generation
                and driver is service.business
                and not service.ending
                and self.versions.get(key, 0) == version
                and (self.resource(resource["id"]) or {}).get("instance") == resource["instance"]
            ):
                self.failed(resource, exc, started)
            raise

    async def _read(self, resource, driver, generation, version):
        service = self.service
        key = str(resource["id"])

        def current():
            active = self.resource(resource["id"])
            return (
                generation == service.generation
                and driver is service.business
                and not service.ending
                and active
                and active["instance"] == resource["instance"]
                and self.versions.get(key, 0) == version
            )

        try:
            result = await driver.call(resource["id"], "status", {})
            if current():
                service._observe(resource, result)
                self.failures.pop(key, None)
            return result
        except Exception as exc:
            if current():
                self.failed(resource, exc)
            raise
