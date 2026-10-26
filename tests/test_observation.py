import time

from . import test_devices
from .test_devices import ORIGIN, command, completed, connect, ready, until

observation_api = test_devices.api


def open_gpio(client, mode="input"):
    ready(client)
    result = completed(
        client,
        command(
            client,
            "resource.open",
            {"kind": "gpio", "pins": {"pin": 10}, "config": {"mode": mode, "level": 1}},
        ),
    )
    assert result["status"] == "completed"
    return result["result"]["resource"]


def test_visible_pages_share_reads_hidden_pages_pause_and_reads_do_not_create_tasks(
    observation_api,
):
    client, backend, service, token = observation_api
    connect(client)
    resource = open_gpio(client)
    service.monitor_interval = 0.06
    before_tasks = len(service.tasks)
    before_acquires = sum(c["op"] == "control.acquire" for c in backend.connection.commands)
    with client.websocket_connect("/api/device/events", headers=ORIGIN) as first:
        first.send_json({"page_session": token})
        first.receive_json()
        first.send_json({"type": "observe", "visible": True})
        state = until(client, "/api/device", lambda s: str(resource) in s["resource_observations"])
        observation = state["resource_observations"][str(resource)]
        assert observation["instance"] == resource and observation["quality"] == "confirmed"
        assert observation["boot_id"] == state["identity"]["boot_id"]
        backend.connection.levels[resource] = 0
        until(
            client, "/api/device", lambda s: s["resource_observations"][str(resource)]["level"] == 0
        )
        with client.websocket_connect("/api/device/events", headers=ORIGIN) as second:
            second.send_json({"page_session": token})
            second.receive_json()
            second.send_json({"type": "observe", "visible": True})
            until(client, "/api/device", lambda _: len(service.monitor_requests) == 2)
            first.send_json({"type": "observe", "visible": False})
            backend.connection.levels[resource] = 1
            until(
                client,
                "/api/device",
                lambda s: s["resource_observations"][str(resource)]["level"] == 1,
            )
            second.send_json({"type": "observe", "visible": False})
            until(client, "/api/device", lambda _: not service.monitor_requests)
            time.sleep(0.08)  # allow the one in-flight round to finish
            commands = len(backend.connection.commands)
            time.sleep(0.15)
            assert len(backend.connection.commands) == commands
    assert len(service.tasks) == before_tasks
    assert sum(c["op"] == "control.acquire" for c in backend.connection.commands) == before_acquires
    assert (
        resource in backend.connection.resources
    )  # closing browser sockets never ends experiments
    assert not service.monitor_requests


def test_confirmed_write_readback_and_reused_resource_instance_never_keep_old_level(
    observation_api,
):
    client, backend, service, _ = observation_api
    connect(client)
    resource = open_gpio(client, "output")
    written = completed(
        client,
        command(
            client, "resource.call", {"resource": resource, "action": "write", "args": {"level": 0}}
        ),
    )
    assert written["status"] == "completed" and written["request_id"] is None
    assert client.get("/api/device").json()["resource_observations"][str(resource)]["level"] == 0
    backend.connection.resources[resource]["instance"] += 100
    client.post("/api/device/refresh")
    until(
        client, "/api/device", lambda s: s["snapshot"]["resources"][0]["instance"] == resource + 100
    )
    assert str(resource) not in service.resource_values
    assert str(resource) not in service.resource_observations


def test_explicit_disconnect_cleans_only_owned_resources(observation_api):
    client, backend, _, _ = observation_api
    connect(client)
    owned = open_gpio(client, "output")
    # An externally created resource is visible, but is never adopted by the SDK object registry.
    external = {**backend.connection.resources[owned], "id": 99, "instance": 99, "pin_mask": 1}
    backend.connection.resources[99] = external
    state = client.post("/api/device/disconnect").json()
    assert state["status"] == "disconnected"
    assert owned not in backend.connection.resources and 99 in backend.connection.resources
    assert not state["error"]
    assert not state["resource_values"]


def test_disconnect_cleanup_failure_retains_actionable_uncertainty(observation_api):
    client, backend, _, _ = observation_api
    connect(client)
    resource = open_gpio(client, "output")
    backend.connection.cleanup_fault = True
    state = client.post("/api/device/disconnect").json()
    assert state["status"] == "disconnected" and "清理未确认" in state["error"]
    assert resource in backend.connection.resources
    assert not state["resource_values"]


def test_notification_gaps_preserve_confirmed_state_and_do_not_create_tasks(observation_api):
    client, backend, service, token = observation_api
    connect(client)
    resource = open_gpio(client, "output")
    completed(
        client,
        command(client, "resource.call", {"resource": resource, "action": "status", "args": {}}),
    )
    service.monitor_interval = 0.03
    backend.connection.notification_gaps = True
    baseline = len(service.tasks)
    gaps = snapshots = 0
    with client.websocket_connect("/api/device/events", headers=ORIGIN) as ws:
        ws.send_json({"page_session": token})
        ws.send_json({"type": "observe", "visible": True})
        for _ in range(50):
            event = ws.receive_json()
            if event["type"] == "notification" and event["data"]["type"] == "notifications.gap":
                gaps += 1
            if event["type"] == "snapshot":
                snapshots += 1
                state = event["data"]
                assert not state["stale"] and state["status"] == "ready"
                assert state["resource_observations"][str(resource)]["level"] == 1
                assert state["resource_observations"][str(resource)]["quality"] == "confirmed"
    assert gaps >= 3 and snapshots >= 3
    assert len(service.tasks) == baseline


def test_snapshot_queries_are_shared_and_timeout_does_not_multiply_work(
    observation_api, monkeypatch
):
    import asyncio

    client, _, service, _ = observation_api
    connect(client)
    original = service.connection.state.snapshot
    service.sync.grace = 0.03
    calls = 0

    async def exercise():
        nonlocal calls
        gate = asyncio.Event()

        async def slow():
            nonlocal calls
            calls += 1
            await gate.wait()
            return await original()

        monkeypatch.setattr(service.connection.state, "snapshot", slow)
        results = await asyncio.gather(
            *(service.sync.snapshot() for _ in range(5)), return_exceptions=True
        )
        assert all(isinstance(r, TimeoutError) for r in results)
        assert calls == 1
        assert service.state["snapshot_sync"]["state"] == "unavailable"
        gate.set()
        await service.sync.snapshot_task
        assert service.state["snapshot_sync"]["state"] == "current"
        assert not service.state["stale"]

    client.portal.call(exercise)


def test_read_failures_are_scoped_and_have_recovery_grace(observation_api, monkeypatch):
    import asyncio

    import pytest

    client, _, service, _ = observation_api
    connect(client)
    resource = open_gpio(client, "output")
    completed(
        client,
        command(client, "resource.call", {"resource": resource, "action": "status", "args": {}}),
    )
    info = service.sync.resource(resource)
    original = service.business.call

    async def fail(*_args):
        raise ValueError("test transient read failure")

    monkeypatch.setattr(service.business, "call", fail)
    service.sync.grace = 0.5
    with pytest.raises(ValueError):
        client.portal.call(service.sync.read, info)
    value = service.resource_observations[str(resource)]
    assert value["level"] == 1 and value["quality"] == "recovering"
    assert not service.state["stale"]
    client.portal.call(asyncio.sleep, 0.55)
    with pytest.raises(ValueError):
        client.portal.call(service.sync.read, info)
    assert service.resource_observations[str(resource)]["quality"] == "unknown"
    assert service.resource_observations[str(resource)]["level"] is None
    assert not service.state["stale"]
    monkeypatch.setattr(service.business, "call", original)
    client.portal.call(service.sync.read, info)
    assert service.resource_observations[str(resource)]["quality"] == "confirmed"


def test_stop_rejects_old_action_scope_but_new_action_runs_automatically(observation_api):
    client, backend, _, _ = observation_api
    state = connect(client)
    old_epoch = state["operation_epoch"]
    completed(client, client.post("/api/device/stop").json())
    args = {"kind": "gpio", "pins": {"pin": 13}, "config": {"mode": "output", "level": 0}}
    rejected = client.post(
        "/api/device/operations",
        json={"op": "resource.open", "args": args, "operation_epoch": old_epoch},
    )
    assert rejected.status_code == 409
    result = completed(client, command(client, "resource.open", args))
    assert result["status"] == "completed"
    assert len(backend.connection.resources) == 1


def test_snapshot_started_before_resource_change_is_not_published(observation_api, monkeypatch):
    import asyncio

    client, _, service, _ = observation_api
    connect(client)
    original = service.connection.state.snapshot

    async def exercise():
        started, release = asyncio.Event(), asyncio.Event()
        calls = 0

        async def snapshot():
            nonlocal calls
            calls += 1
            result = await original()
            if calls == 1:
                started.set()
                await release.wait()
            return result

        monkeypatch.setattr(service.connection.state, "snapshot", snapshot)
        query = asyncio.create_task(service.sync.snapshot())
        await started.wait()
        service.sync.invalidate_structure()
        release.set()
        await query
        assert calls == 2  # sequential retry; the obsolete snapshot never reaches consumers

    client.portal.call(exercise)


def test_old_read_timeout_and_completion_do_not_replace_new_write(observation_api, monkeypatch):
    import asyncio

    client, _, service, _ = observation_api
    connect(client)
    resource = open_gpio(client, "output")
    info = service.sync.resource(resource)
    service.sync.grace = 0.02

    async def exercise():
        started, release = asyncio.Event(), asyncio.Event()

        async def slow(*_args):
            started.set()
            await release.wait()
            return {"level": 1}

        monkeypatch.setattr(service.business, "call", slow)
        query = asyncio.create_task(service.sync.read(info))
        await started.wait()
        service.sync.invalidate(resource)
        service._observe(info, {"level": 0})
        result = await asyncio.gather(query, return_exceptions=True)
        assert isinstance(result[0], TimeoutError)
        assert service.resource_observations[str(resource)]["quality"] == "confirmed"
        release.set()
        await service.sync.reads[str(resource)][1]
        assert service.resource_observations[str(resource)]["level"] == 0
        assert service.resource_observations[str(resource)]["quality"] == "confirmed"

    client.portal.call(exercise)


def test_failed_automatic_batch_acquire_does_not_leave_inflight_count(observation_api, monkeypatch):
    client, _, service, _ = observation_api
    connect(client)

    async def fail():
        raise ValueError("test acquire failure")

    monkeypatch.setattr(service.connection.control, "acquire", fail)
    response = client.post(
        "/api/device/batches",
        json=[
            {
                "op": "resource.open",
                "args": {
                    "kind": "gpio",
                    "pins": {"pin": 13},
                    "config": {"mode": "output", "level": 0},
                },
            }
        ],
    )
    assert response.status_code == 422
    assert service.batches_inflight == 0


def test_gpio_open_publishes_confirmed_state_without_waiting_for_snapshot(
    observation_api, monkeypatch
):
    import asyncio

    client, backend, service, _ = observation_api
    connect(client)

    async def exercise():
        async def blocked(**_kwargs):
            await asyncio.Event().wait()

        monkeypatch.setattr(service.sync, "snapshot", blocked)
        before = len(backend.connection.commands)
        task = await service.submit(
            "resource.open",
            {"kind": "gpio", "pins": {"pin": 10}, "config": {"mode": "output", "level": 1}},
            internal=True,
        )
        result = await asyncio.wait_for(service.wait(task["id"]), 1)
        assert result["status"] == "completed"
        info = service.sync.resource(result["result"]["resource"])
        assert info and info["state"] == "ready"
        assert service.resource_observations[str(info["id"])]["level"] == 1
        sent = [c["op"] for c in backend.connection.commands[before:]]
        assert sent == ["control.acquire", "resource.open"]

    client.portal.call(exercise)


def test_initialization_waits_for_slow_snapshot_and_clears_previous_error(
    observation_api, monkeypatch
):
    import asyncio

    client, _, service, _ = observation_api
    connect(client)
    original = service.connection.state.snapshot
    service.sync.grace = 0.01

    async def exercise():
        started, release = asyncio.Event(), asyncio.Event()

        async def slow():
            started.set()
            await release.wait()
            return await original()

        monkeypatch.setattr(service.connection.state, "snapshot", slow)
        service.state.update(status="discovering", stale=True, error="之前的读取失败")
        initializing = asyncio.create_task(service._initialise(service.generation))
        try:
            await started.wait()
            await asyncio.sleep(service.sync.grace * 3)
            assert not initializing.done()
            assert service.state["status"] == "discovering"
        finally:
            release.set()
            await initializing
        assert service.state["status"] == "ready"
        assert not service.state["stale"]
        assert service.state["error"] is None

    client.portal.call(exercise)


def test_initialization_failure_identifies_snapshot_timeout(observation_api, monkeypatch):
    client, _, service, _ = observation_api
    connect(client)

    async def timed_out():
        raise TimeoutError

    monkeypatch.setattr(service.connection.state, "snapshot", timed_out)
    client.portal.call(service._initialise, service.generation)
    assert service.state["status"] == "discovery_failed"
    assert "状态快照读取失败（timeout）" in service.state["error"]
    assert "等待设备确认或状态读取超时" in service.state["error"]


def test_stop_waits_for_slow_readback_without_reporting_unknown(observation_api, monkeypatch):
    import asyncio

    client, _, service, _ = observation_api
    connect(client)
    original = service.connection.state.snapshot
    service.sync.grace = 0.01

    async def exercise():
        started, release = asyncio.Event(), asyncio.Event()

        async def slow():
            started.set()
            await release.wait()
            return await original()

        monkeypatch.setattr(service.connection.state, "snapshot", slow)
        task = await service.submit("outputs.stop", {}, internal=True)
        try:
            await started.wait()
            await asyncio.sleep(service.sync.grace * 3)
            assert task["status"] == "running"
        finally:
            release.set()
        result = await service.wait(task["id"])
        assert result["status"] == "completed"
        assert result["error"] is None
        assert result["result"]["cleanup_faults"] == 0

    client.portal.call(exercise)


def test_background_snapshot_adapts_to_confirmed_pagination_latency(observation_api, monkeypatch):
    import asyncio

    client, _, service, _ = observation_api
    connect(client)
    original = service.connection.state.snapshot
    service.sync.grace = 0.01

    async def slow():
        await asyncio.sleep(0.04)
        return await original()

    monkeypatch.setattr(service.connection.state, "snapshot", slow)

    async def exercise():
        # 初始化允许完整分页；后台读取应接受同样的真实传输延迟。
        await service.sync.snapshot(wait_timeout=1)
        query = asyncio.create_task(service.sync.snapshot())
        await asyncio.sleep(0.025)
        assert not query.done()
        assert not service.state["stale"]
        assert service.state["snapshot_sync"]["state"] == "current"
        await query
        assert not service.state["stale"]
        service.sync.reset()
        assert service.sync.snapshot_duration == 0

    client.portal.call(exercise)


def test_initial_snapshot_late_success_restores_readiness(observation_api, monkeypatch):
    import asyncio

    client, _, service, _ = observation_api
    connect(client)
    original = service.connection.state.snapshot
    service.job_timeout = 0.02

    async def exercise():
        release = asyncio.Event()

        async def slow():
            await release.wait()
            return await original()

        monkeypatch.setattr(service.connection.state, "snapshot", slow)
        await service._initialise(service.generation, refresh=True)
        assert service.state["status"] == "discovery_failed"
        assert service.state["stale"]
        await service._initialise(service.generation - 1)
        release.set()
        await service.sync.snapshot_task
        assert service.state["status"] == "ready"
        assert not service.state["stale"]
        assert service.state["error"] is None
        assert service.state["snapshot_sync"]["state"] == "current"

    client.portal.call(exercise)


def test_foreground_open_waits_for_inflight_snapshot_and_defers_background_refresh(
    observation_api, monkeypatch
):
    import asyncio

    client, backend, service, _ = observation_api
    connect(client)
    original = service.connection.state.snapshot

    async def exercise():
        started, release = asyncio.Event(), asyncio.Event()

        async def slow():
            started.set()
            await release.wait()
            return await original()

        monkeypatch.setattr(service.connection.state, "snapshot", slow)
        query = asyncio.create_task(service.sync.snapshot())
        await started.wait()
        before = len(backend.connection.commands)
        task = await service.submit(
            "resource.open",
            {"kind": "pwm", "pins": {"pin": 13}, "config": {"frequency": 1000, "duty": 50}},
            internal=True,
        )
        await asyncio.sleep(0.02)
        assert service.foreground_pending()
        service.schedule_refresh()
        assert not service.refreshing or service.refreshing.done()
        assert not any(c["op"] == "resource.open" for c in backend.connection.commands[before:])
        release.set()
        await query
        assert (await service.wait(task["id"]))["status"] == "completed"
        assert not service.foreground_pending()

    client.portal.call(exercise)


def test_local_fast_operation_restarts_expired_pages_without_marking_failure(
    observation_api, monkeypatch
):
    import asyncio
    from types import SimpleNamespace

    client, _, service, _ = observation_api
    connect(client)
    original = service.connection.state.snapshot
    calls = 0

    class Expired(Exception):
        error = SimpleNamespace(reason="snapshot_expired")

    async def changed():
        nonlocal calls
        calls += 1
        if calls == 1:
            service.sync.foreground_version += 1
            raise Expired()
        return await original()

    async def exercise():
        monkeypatch.setattr(service.connection.state, "snapshot", changed)
        await asyncio.wait_for(service.sync.snapshot(), 1)
        assert calls == 2
        assert service.sync.snapshot_failed_at is None
        assert service.state["snapshot_sync"]["state"] == "current"
        assert service.state["snapshot_sync"]["error"] is None

    client.portal.call(exercise)
