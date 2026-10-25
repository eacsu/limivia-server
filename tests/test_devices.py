import asyncio
import time

import pytest
from fastapi.testclient import TestClient

from limivia_server.devices.catalog import KINDS, OPERATIONS
from limivia_server.devices.transfers import validate_flow
from limivia_server.web.app import create_app

from .fakes import FakeBackend

ORIGIN = {"origin": "http://testserver"}


@pytest.fixture
def api(tmp_path):
    (tmp_path / "index.html").write_text("<title>LIMIVIA</title>")
    backend = FakeBackend()
    app = create_app(tmp_path, backend, tmp_path / "data")
    with TestClient(app) as client:
        token = client.post("/api/pages").json()["page_session"]
        client.headers["x-page-session"] = token
        yield client, backend, app.state.devices, token


def until(client, path, predicate):
    for _ in range(400):
        result = client.get(path).json()
        if predicate(result):
            return result
        time.sleep(0.005)
    pytest.fail(f"timed out: {result}")


def connect(client):
    assert (
        client.post("/api/device/connect", json={"kind": "usb", "target": "test"}).status_code
        == 202
    )
    return until(client, "/api/device", lambda state: state["status"] == "ready")


def command(client, op, args=None, **extra):
    response = client.post("/api/device/operations", json={"op": op, "args": args or {}, **extra})
    assert response.status_code == 202, response.text
    return response.json()


def completed(client, task):
    return until(
        client,
        "/api/operations/" + task["id"],
        lambda t: t["status"] in {"completed", "failed", "cancelled", "unknown"},
    )


def ready(client):
    return completed(client, command(client, "diagnostics"))


def test_observer_connection_identity_discovery_and_catalog(api):
    client, backend, _, _ = api
    assert client.get("/api/device/discover").json()["kind"] == "ble"
    assert client.get("/api/device/discover?kind=ws").status_code == 422
    state = connect(client)
    assert state["identity"]["contract"] == "limivia-v3-jsonrpc2"
    assert state["snapshot"]["revision"] == 1
    assert "control" not in state
    assert len(client.get("/api/device/catalog").json()) == len(OPERATIONS) == 76
    assert len(KINDS) == 18
    assert "control.acquire" not in [c["op"] for c in backend.connection.commands]
    assert client.post("/api/device/operations", json={"op": "control.acquire"}).status_code == 422


def test_scanning_and_connections_share_lifespan_sdk_search_cache(tmp_path, monkeypatch):
    from limivia import AsyncLimivia

    from limivia_server.devices import service as service_module

    backends = []

    class SearchRequiredBackend(FakeBackend):
        def transport(self, kind, target, options=None):
            assert self.discovered, "连接必须复用执行扫描的 SDK Backend"
            return super().transport(kind, target, options)

    def make_sdk(**kwargs):
        backend = SearchRequiredBackend()
        backends.append(backend)
        return AsyncLimivia(**{**kwargs, "backend": backend})

    monkeypatch.setattr(service_module, "AsyncLimivia", make_sdk)
    (tmp_path / "index.html").write_text("<title>LIMIVIA</title>")
    app = create_app(tmp_path, data_dir=tmp_path / "data")
    with TestClient(app) as client:
        client.headers["x-page-session"] = client.post("/api/pages").json()["page_session"]
        for _ in range(2):
            assert client.get("/api/device/discover?kind=usb").status_code == 200
            connect(client)
            assert client.post("/api/device/disconnect").status_code == 200
        assert len(backends) == 1
    assert backends[0].connection.closed


def test_resource_lifecycle_and_secret_projection(api):
    client, backend, _, _ = api
    connect(client)
    assert ready(client)["status"] == "completed"
    opened = completed(
        client,
        command(
            client,
            "resource.open",
            {"kind": "gpio", "pins": {"pin": 13}, "config": {"mode": "output", "level": 0}},
        ),
    )
    resource = opened["result"]["resource"]
    assert resource > 0 and opened["job_id"] is None and opened["request_id"] is None
    called = completed(
        client,
        command(
            client, "resource.call", {"resource": resource, "action": "write", "args": {"level": 1}}
        ),
    )
    assert called["status"] == "completed"
    assert (
        completed(client, command(client, "resource.close", {"resource": resource}))["status"]
        == "completed"
    )
    assert not backend.connection.resources
    body = client.get("/api/operations").text + client.get("/api/device").text
    assert "session-test" not in body and "control-test" not in body


def test_pages_share_connection_and_managed_resources(api):
    client, backend, _, token = api
    connect(client)
    opened = completed(
        client,
        command(
            client,
            "resource.open",
            {"kind": "gpio", "pins": {"pin": 0}, "config": {"mode": "output", "level": 0}},
        ),
    )
    resource = opened["result"]["resource"]
    other = client.post("/api/pages").json()["page_session"]
    with client.websocket_connect("/api/device/events", headers=ORIGIN) as ws:
        ws.send_json({"page_session": token})
        assert ws.receive_json()["type"] == "snapshot"
        response = client.post(
            "/api/device/operations",
            headers={"x-page-session": other},
            json={
                "op": "resource.call",
                "args": {"resource": resource, "action": "write", "args": {"level": 1}},
            },
        )
        assert response.status_code == 202
        assert completed(client, response.json())["status"] == "completed"
    assert not backend.connection.closed
    assert backend.connection.levels[resource] == 1
    assert sum(c["op"] == "control.acquire" for c in backend.connection.commands) == 1


def test_stop_is_independent_and_revokes_control(api):
    client, _, _, _ = api
    connect(client)
    ready(client)
    observer = client.post("/api/pages").json()["page_session"]
    task = client.post("/api/device/stop", headers={"x-page-session": observer}).json()
    stop = completed(client, task)
    assert stop["status"] == "completed"
    assert stop["result"]["autostart_inhibited"]
    assert "control" not in client.get("/api/device").json()


def test_batch_out_of_order_independent_results(api):
    client, _, _, _ = api
    connect(client)
    tasks = client.post(
        "/api/device/batches", json=[{"op": "diagnostics"}, {"op": "diagnostics"}]
    ).json()
    assert tasks[0]["id"] != tasks[1]["id"]
    assert [completed(client, t)["status"] for t in tasks] == ["completed", "completed"]


def test_batch_uses_same_explicit_binary_encoding_as_single_commands(api):
    client, backend, _, _ = api
    connect(client)
    ready(client)
    created = completed(client, command(client, "buffer.create", {"size": 2}))
    response = client.post(
        "/api/device/batches",
        json=[
            {
                "op": "buffer.write",
                "args": {
                    "buffer_id": created["result"]["buffer_id"],
                    "offset": 0,
                    "data": {"encoding": "hex", "value": "00ff"},
                },
            }
        ],
    )
    assert response.status_code == 202
    assert completed(client, response.json()[0])["status"] == "completed"
    assert (
        next(c for c in reversed(backend.connection.commands) if c["op"] == "buffer.write")[
            "params"
        ]["data"]
        == "AP8="
    )


def test_upload_rechecks_target_after_reading_host_file(api):
    from fastapi import HTTPException

    from limivia_server.devices.api import ConnectInput
    from limivia_server.devices.transfers import start_upload

    client, backend, service, page = api
    connect(client)
    ready(client)
    original = backend.connection

    class SwitchFile:
        async def read(self, _limit):
            await service.disconnect()
            await service.connect(ConnectInput(kind="usb", target="signal"))
            return b"old target contents"

        async def close(self):
            pass

    with pytest.raises(HTTPException) as error:
        client.portal.call(start_upload, service, SwitchFile(), "old.txt", page)
    assert error.value.status_code == 409
    assert not any(command["op"] == "storage.begin" for command in original.commands)


def test_local_validation_and_unknown_disconnect(api):
    client, backend, _, _ = api
    connect(client)
    ready(client)
    response = client.post(
        "/api/device/operations", json={"op": "resource.open", "args": {"unknown": 1}}
    )
    assert response.status_code == 202
    assert completed(client, response.json())["status"] == "failed"
    backend.connection.disconnect_op = "resource.open"
    task = command(client, "resource.open", {"kind": "gpio", "pins": {"pin": 0}, "config": {}})
    result = completed(client, task)
    assert result["status"] == "unknown"
    assert result["error"]["may_have_executed"]


def test_explicit_job_cancel_uses_real_job_identity(api):
    client, backend, _, _ = api
    connect(client)
    ready(client)
    backend.connection.hold_jobs = True
    submitted = completed(
        client,
        command(
            client,
            "job.submit",
            {
                "command": {
                    "type": "resource.open",
                    "params": {"kind": "gpio", "pins": {"pin": 0}, "config": {}},
                }
            },
        ),
    )
    assert submitted["status"] == "completed"
    job_id = submitted["job_id"]
    assert job_id and submitted["result"]["state"] == "accepted"
    cancel = completed(client, command(client, "job.cancel", {"job_id": job_id}))
    assert cancel["status"] == "completed"
    backend.connection.hold_jobs = False
    queried = completed(client, command(client, "job.get", {"job_id": job_id}))
    assert queried["result"]["state"] == "cancelled"


@pytest.mark.parametrize(
    "field,value", [("contract", "old-v3"), ("protocol", 1), ("protocol", 2), ("jsonrpc", "1.0")]
)
def test_invalid_identity_and_cross_origin(api, field, value):
    client, backend, _, _ = api
    assert client.post("/api/pages", headers={"origin": "http://evil.test"}).status_code == 403
    backend.connection.hello[field] = value
    client.post("/api/device/connect", json={"kind": "usb", "target": "test"})
    state = until(client, "/api/device", lambda s: s["status"] == "disconnected")
    assert state["error"] and not state["identity"]


@pytest.mark.parametrize(
    "body",
    [
        {"kind": "ws", "target": "ws://user:password@device/v3"},
        {"kind": "mqtt", "target": "mqtt://broker"},
        {"kind": "ws", "target": "http://device"},
    ],
)
def test_network_options_validation(api, body):
    assert api[0].post("/api/device/connect", json=body).status_code == 422


def test_store_restart_unknown_and_retention(tmp_path):
    from limivia_server.devices.service import DeviceService
    from limivia_server.devices.store import OperationStore

    store = OperationStore(tmp_path / "operations.sqlite3")
    store.save({"id": "interrupted", "status": "accepted", "updated": time.time()})
    store.close()

    async def restart():
        service = DeviceService(None, tmp_path)
        await service.start()
        assert service.store.get("interrupted")["status"] == "unknown"
        assert service.connection is None
        await service.close()

    asyncio.run(restart())


def test_slow_subscriber_never_blocks_reducer(api):
    _, _, service, _ = api
    queue = asyncio.Queue(maxsize=1)
    service.subscribers["slow"] = queue
    for _ in range(100):
        service.emit("test", {})
    assert queue.qsize() == 1
    assert queue.get_nowait()["type"] == "resync"
    service.subscribers.clear()


def test_flow_validation():
    flow = {
        "version": 1,
        "profile": "bus",
        "autostart": False,
        "resources": [],
        "variables": {"x": 0},
        "steps": [{"op": "delay", "ms": 10}, {"op": "end"}],
    }
    assert validate_flow(flow, "bus")["valid"]
    assert not validate_flow(flow, "signal")["valid"]
    flow["steps"] = [{"op": "if", "then": 0, "variable": "x", "value": 0}]
    assert not validate_flow(flow, "bus")["valid"]
    flow["variables"]["x"] = float("nan")
    assert not validate_flow(flow)["valid"]


def test_upload_commit_download_and_owned_abort(api):
    client, backend, _, _ = api
    connect(client)
    ready(client)
    data = b"v3-file-" * 100
    task = client.post(
        "/api/device/files/upload?name=experiment.json", files={"file": ("experiment.json", data)}
    ).json()
    done = completed(client, task)
    assert done["status"] == "completed"
    assert done["progress"]["bytes"] == len(data)
    assert backend.connection.files["experiment.json"]["data"] == data
    assert client.get("/api/device/files/experiment.json/download").content == data
    backend.connection.fail_chunk = True
    failed = client.post(
        "/api/device/files/upload?name=experiment.json",
        files={"file": ("experiment.json", b"new-data")},
    ).json()
    assert completed(client, failed)["status"] == "failed"
    assert backend.connection.files["experiment.json"]["data"] == data
    assert not backend.connection.uploads
    assert [c["op"] for c in backend.connection.commands].count("storage.abort") == 1


def test_secret_file_never_read_back_or_listed(api):
    client, _, _, _ = api
    connect(client)
    ready(client)
    task = client.post(
        "/api/device/files/upload?name=secret.json&secret=true",
        files={"file": ("secret.json", b'{"password":"never-display"}')},
    ).json()
    assert completed(client, task)["status"] == "completed"
    assert "never-display" not in client.get("/api/operations").text
    listing = completed(client, command(client, "storage.list"))
    assert listing["result"]["files"] == []
    assert client.get("/api/device/files/secret.json/download").status_code == 409


def test_ota_commit_defaults_no_reboot(api):
    client, backend, _, _ = api
    connect(client)
    ready(client)
    task = client.post(
        "/api/device/ota/upload?profile=bus", files={"file": ("firmware.bin", b"image" * 100)}
    ).json()
    done = completed(client, task)
    assert done["status"] == "completed"
    assert done["result"]["reboot"] is False
    assert (
        next(c for c in backend.connection.commands if c["op"] == "ota.commit")["params"]["reboot"]
        is False
    )


def test_flow_upload_load_run_stop_remove_are_distinct(api):
    client, backend, _, _ = api
    connect(client)
    ready(client)
    definition = {
        "version": 1,
        "profile": "bus",
        "autostart": False,
        "resources": [],
        "variables": {},
        "steps": [{"op": "delay", "ms": 20}, {"op": "end"}],
    }
    import json

    upload = client.post(
        "/api/device/files/upload?name=test.flow.json",
        files={"file": ("test.flow.json", json.dumps(definition).encode())},
    ).json()
    assert completed(client, upload)["status"] == "completed"
    loaded = completed(client, command(client, "flow.load", {"name": "test.flow.json"}))
    flow_id = loaded["result"]["flow_id"]
    assert (
        completed(client, command(client, "flow.start", {"flow_id": flow_id}))["result"]["state"]
        == "running"
    )
    assert (
        completed(client, command(client, "flow.pause", {"flow_id": flow_id}))["result"]["state"]
        == "paused"
    )
    assert (
        completed(client, command(client, "flow.stop", {"flow_id": flow_id}))["result"]["state"]
        == "stopped"
    )
    completed(client, command(client, "flow.remove", {"flow_id": flow_id}))
    assert "test.flow.json" in backend.connection.files


def test_fault_resource_stays_occupied_until_recover(api):
    client, backend, _, _ = api
    connect(client)
    ready(client)
    opened = completed(
        client,
        command(client, "resource.open", {"kind": "gpio", "pins": {"pin": 13}, "config": {}}),
    )
    resource = opened["result"]["resource"]
    backend.connection.cleanup_fault = True
    closed = completed(client, command(client, "resource.close", {"resource": resource}))
    assert closed["status"] == "failed"
    assert closed["job"]["driver_error"] == 5
    assert backend.connection.resources[resource]["state"] == "fault"
    backend.connection.cleanup_fault = False
    assert (
        completed(client, command(client, "resource.recover", {"resource": resource}))["status"]
        == "completed"
    )
    assert resource not in backend.connection.resources


def test_parent_child_resources_require_explicit_cascade(api):
    client, backend, _, _ = api
    connect(client)
    ready(client)
    parent = completed(
        client,
        command(
            client,
            "resource.open",
            {
                "kind": "i2c.master",
                "pins": {"sda": 0, "scl": 1},
                "config": {},
            },
        ),
    )["result"]["resource"]
    child = completed(
        client,
        command(
            client,
            "resource.open",
            {
                "kind": "i2c.device",
                "parent": parent,
                "pins": {},
                "config": {"address": 83},
            },
        ),
    )["result"]["resource"]
    client.post("/api/device/refresh")
    state = until(client, "/api/device", lambda state: len(state["snapshot"]["resources"]) == 2)
    assert next(r for r in state["snapshot"]["resources"] if r["id"] == child)["parent"] == parent
    rejected = completed(client, command(client, "resource.close", {"resource": parent}))
    assert rejected["error"]["reason"] == "children_exist"
    assert {parent, child}.issubset(backend.connection.resources)
    cascaded = completed(
        client,
        command(
            client,
            "resource.recover",
            {
                "resource": parent,
                "cascade": True,
            },
        ),
    )
    assert cascaded["status"] == "completed"
    assert not backend.connection.resources


def test_expired_job_handle_is_distinct_from_expired_result(api):
    client, _, _, _ = api
    connect(client)
    query = completed(client, command(client, "job.get", {"job_id": 99999}))
    assert query["status"] == "failed"
    assert query["error"]["reason"] == "job_expired"
    assert query["handle_expired"] and not query["result_expired"]


def test_result_expired_and_response_capacity(api):
    client, backend, _, _ = api
    connect(client)
    ready(client)
    backend.connection.result_expired = True
    opened = completed(
        client, command(client, "resource.open", {"kind": "gpio", "pins": {"pin": 0}, "config": {}})
    )
    assert opened["status"] == "unknown" and opened["result_expired"]
    backend.connection.result_expired = False
    confirmed_open = completed(
        client, command(client, "resource.open", {"kind": "gpio", "pins": {"pin": 1}, "config": {}})
    )
    backend.connection.bad_response = lambda response: {
        "id": response["id"],
        "ok": False,
        "error": {"code": 1001, "reason": "response_capacity", "external_effect_possible": True},
    }
    failed = completed(
        client,
        command(
            client,
            "resource.call",
            {
                "resource": confirmed_open["result"]["resource"],
                "action": "write",
                "args": {"level": 1},
            },
        ),
    )
    assert failed["status"] == "unknown" and failed["external_effect_possible"]
    assert len([c for c in backend.connection.commands if c["op"] == "resource.call"]) <= 1
    assert not any(
        c["op"] == "resource.call" and c["params"].get("action") == "write"
        for c in backend.connection.commands
    )


def test_revision_zero_is_not_ignored(api, monkeypatch):
    from .fakes import STATE

    monkeypatch.setitem(STATE, "revision", 0)
    state = connect(api[0])
    assert state["snapshot"]["revision"] == 0
    assert all(page["revision"] == 0 for page in state["snapshot"]["pages"])


def test_fast_batch_event_before_registration_is_replayed(api, monkeypatch):
    from limivia.types import CommandCompletedEvent

    client, _, service, _ = api
    connect(client)

    async def immediate(commands):
        await service.reduce(
            CommandCompletedEvent(request_id=4242, op="diagnostics", result={"fast": True}),
            service.generation,
        )
        return [4242]

    monkeypatch.setattr(service.connection.raw, "batch", immediate)
    response = client.post("/api/device/batches", json=[{"op": "diagnostics"}])
    task = completed(client, response.json()[0])
    assert task["status"] == "completed" and task["result"]["fast"]


def test_binary_text_hex_encoding_and_canonical_base64(api):
    client, backend, _, _ = api
    connect(client)
    ready(client)
    opened = completed(
        client,
        command(
            client, "resource.open", {"kind": "uart", "pins": {"tx": 20, "rx": 21}, "config": {}}
        ),
    )
    resource = opened["result"]["resource"]
    for encoding, value in [("text", "你好"), ("hex", "01 02")]:
        task = completed(
            client,
            command(
                client,
                "resource.call",
                {
                    "resource": resource,
                    "action": "write",
                    "args": {"data": {"encoding": encoding, "value": value}},
                },
            ),
        )
        assert task["status"] == "completed"
    writes = [c for c in backend.connection.commands if c["op"] == "resource.call"]
    assert writes[0]["params"]["args"]["data"] == "5L2g5aW9"
    assert writes[1]["params"]["args"]["data"] == "AQI="
    assert (
        client.post(
            "/api/device/operations",
            json={
                "op": "resource.call",
                "args": {
                    "resource": resource,
                    "action": "write",
                    "args": {"data": {"encoding": "hex", "value": "abc"}},
                },
            },
        ).status_code
        == 422
    )


def test_adc_consumer_is_shared_and_bounded(api):
    client, backend, _, _ = api
    connect(client)
    ready(client)
    opened = completed(
        client,
        command(
            client,
            "resource.open",
            {"kind": "adc", "pins": {"pin": 0}, "config": {"interval_ms": 100}},
        ),
    )
    resource = opened["result"]["resource"]
    until(client, "/api/device", lambda s: bool(s["snapshot"]["resources"]))
    assert client.post(f"/api/device/resources/{resource}/sampling?enabled=true").status_code == 200
    state = until(client, "/api/device", lambda s: bool(s["samples"].get(str(resource))))
    assert len(state["samples"][str(resource)]) <= 120
    assert (
        client.post(f"/api/device/resources/{resource}/sampling?enabled=false").status_code == 200
    )
    assert not backend.connection.closed


@pytest.mark.parametrize(
    "op",
    [
        op
        for op in OPERATIONS
        if op
        not in {
            "hello",
            "session.ping",
            "event.subscribe",
            "event.unsubscribe",
            "capabilities",
            "state",
            "control.acquire",
            "control.release",
            "outputs.stop",
        }
    ],
)
def test_all_public_operations_reach_sdk_with_stable_task_id(api, monkeypatch, op):
    """网关分派覆盖；参数/驱动语义另由集成测试和 SDK 负责，不冒充硬件验收。"""
    client, _, service, _ = api
    connect(client)
    ready(client)
    captured = []

    async def execute(operation, args):
        captured.append(operation)
        if operation == "state.snapshot":
            return service.state["snapshot"]
        return {"gateway_operation": operation, "resource": 987, "instance": 987}

    monkeypatch.setattr(service.business, "execute", execute)
    args = {"resource": 987, "buffer_id": 987, "flow_id": 987, "upload_id": 987}
    if op == "storage.format":
        args["confirm"] = "erase_littlefs"
    if op == "system.nvs_format":
        args["confirm"] = "erase_nvs"
    task = completed(client, command(client, op, args))
    assert task["status"] == "completed"
    assert task["result"]["gateway_operation"] == op
    assert captured[0] == op
    assert task["id"] and task["generation"] == 1
    assert task["request_id"] is None and task["job_id"] is None


def test_stale_explicit_connection_scope_never_submits(api):
    client, backend, _, _ = api
    connect(client)
    ready(client)
    before = len(backend.connection.commands)
    response = client.post(
        "/api/device/operations",
        json={
            "op": "resource.call",
            "args": {"resource": 1, "action": "write", "args": {"level": 1}},
            "generation": 0,
            "boot_id": "old-boot",
        },
    )
    assert response.status_code == 409
    assert not any(c["op"] == "resource.call" for c in backend.connection.commands[before:])


def test_capability_refresh_reuses_handshake_but_reads_pages(api):
    client, backend, _, _ = api
    connect(client)
    before = len([c for c in backend.connection.commands if c["op"] == "capabilities"])
    client.post("/api/device/refresh")
    until(
        client,
        "/api/operations",
        lambda tasks: sum(t["op"] == "discover" and t["status"] == "completed" for t in tasks) >= 2,
    )
    assert len([c for c in backend.connection.commands if c["op"] == "capabilities"]) > before
    assert len([c for c in backend.connection.commands if c["op"] == "hello"]) == 1
    assert not any(c["op"] == "control.acquire" for c in backend.connection.commands)


def test_unknown_profile_is_preserved_and_capabilities_drive_ui(api):
    client, backend, _, _ = api
    backend.connection.hello["profile"] = "custom-lab"
    state = connect(client)
    assert state["identity"]["profile"] == "custom-lab"
    assert len(state["discovery"]["resources"]) == 18


@pytest.mark.parametrize(
    "step",
    [
        {"op": []},
        {"op": "service", "action": []},
        {"op": "call", "resource": {}, "action": "read", "args": {}, "timeout_ms": 5},
        {"op": "set", "variable": [], "value": 1},
        {
            "op": "call",
            "resource": "x",
            "action": "read",
            "args": {"value": {"$var": []}},
            "timeout_ms": 5,
        },
    ],
)
def test_flow_invalid_structured_values_are_validation_errors(step):
    definition = {"version": 1, "profile": "bus", "resources": [], "variables": {}, "steps": [step]}
    assert not validate_flow(definition, "bus")["valid"]


def test_finite_loop_without_wait_is_bounded_not_a_busy_cycle():
    definition = {
        "version": 1,
        "profile": "bus",
        "resources": [],
        "variables": {"x": 0},
        "steps": [
            {"op": "add", "variable": "x", "value": 1},
            {"op": "loop", "count": 5, "target": 0},
            {"op": "end"},
        ],
    }
    assert validate_flow(definition, "bus")["valid"]


def test_expired_result_query_never_fabricates_original_completion(api):
    client, backend, _, _ = api
    connect(client)
    ready(client)
    backend.connection.result_expired = True
    task = completed(
        client, command(client, "resource.open", {"kind": "gpio", "pins": {"pin": 0}, "config": {}})
    )
    assert task["status"] == "unknown" and task["result_expired"]
    completed(client, command(client, "job.get", {"job_id": task["job_id"]}))
    original = client.get("/api/operations/" + task["id"]).json()
    assert original["status"] == "unknown" and original["result_expired"]


def test_stop_query_still_requires_cleanup_and_persistence_confirmation(api):
    client, backend, _, _ = api
    connect(client)
    ready(client)
    backend.connection.stop_persist_error = 9
    task = completed(client, client.post("/api/device/stop").json())
    assert task["status"] == "unknown"
    completed(client, command(client, "job.get", {"job_id": task["job_id"]}))
    assert client.get("/api/operations/" + task["id"]).json()["status"] == "unknown"
    assert "control" not in client.get("/api/device").json()


def test_notifications_gap_recovers_read_only_and_retains_single_consumer(api):
    from limivia.types import NotificationGapEvent

    client, backend, service, _ = api
    connect(client)
    before = len(backend.connection.commands)
    event = NotificationGapEvent(
        boot_id=backend.connection.hello["boot_id"],
        session="session-test",
        expected=1,
        received=4,
        dropped=3,
    )
    client.portal.call(service.reduce, event, service.generation)
    until(
        client,
        "/api/device",
        lambda state: (
            not state["stale"]
            and any(c["op"] == "state" for c in backend.connection.commands[before:])
        ),
    )
    after = backend.connection.commands[before:]
    assert any(c["op"] == "state" for c in after)
    assert not any(c["op"] in {"resource.call", "control.acquire", "outputs.stop"} for c in after)


def test_cross_page_revision_never_exposes_partial_snapshot(api):
    client, backend, _, _ = api

    def corrupt(response):
        if (
            backend.connection.commands[-1]["op"] == "state"
            and response.get("result", {}).get("page") == 1
        ):
            response["result"]["revision"] = 2
        return response

    backend.connection.bad_response = corrupt
    client.post("/api/device/connect", json={"kind": "usb", "target": "test"})
    state = until(client, "/api/device", lambda s: s["status"] == "discovery_failed")
    assert state["snapshot"] is None


def test_completed_history_is_bounded_without_evicting_unfinished(tmp_path):
    import json

    from limivia_server.devices.store import OperationStore

    store = OperationStore(tmp_path / "history.sqlite3")
    now = time.time()
    rows = [
        (str(i), now, 1, json.dumps({"id": str(i), "updated": now, "status": "completed"}))
        for i in range(10002)
    ]
    store.db.executemany("INSERT INTO operations VALUES (?,?,?,?)", rows)
    store.db.commit()
    store.save({"id": "active", "updated": 0, "status": "accepted"})
    store.prune()
    assert (
        store.db.execute("SELECT COUNT(*) FROM operations WHERE terminal=1").fetchone()[0] == 10000
    )
    assert store.get("active")["status"] == "accepted"
    store.close()


def test_concurrent_pages_share_one_automatic_sdk_acquisition(api):
    client, backend, _, _ = api
    connect(client)
    backend.connection.write_delay = 0.01
    original = command(client, "resource.open", {"kind": "gpio", "pins": {"pin": 0}, "config": {}})
    other = client.post("/api/pages").json()["page_session"]
    response = client.post(
        "/api/device/operations",
        headers={"x-page-session": other},
        json={"op": "resource.open", "args": {"kind": "gpio", "pins": {"pin": 1}, "config": {}}},
    )
    assert response.status_code == 202
    assert completed(client, original)["status"] == "completed"
    assert completed(client, response.json())["status"] == "completed"
    assert sum(c["op"] == "control.acquire" for c in backend.connection.commands) == 1


def test_reconnect_cancels_previous_capability_initializer(api, monkeypatch):
    client, _, service, _ = api
    initialise = service._initialise

    async def delayed_initialise(generation, **kwargs):
        if generation == 1:
            await asyncio.Event().wait()
        await initialise(generation, **kwargs)

    monkeypatch.setattr(service, "_initialise", delayed_initialise)
    client.post("/api/device/connect", json={"kind": "usb", "target": "test"})
    until(client, "/api/device", lambda state: state["status"] == "discovering")
    client.post("/api/device/disconnect")
    client.post("/api/device/connect", json={"kind": "usb", "target": "signal"})
    state = until(client, "/api/device", lambda state: state["status"] == "ready")
    assert state["discovery"]["identity"]["profile"] == "signal"
    assert state["generation"] == 2


@pytest.mark.parametrize(
    "kind,target,options",
    [
        ("ws", "ws://board.test/v3", {"ca_file": "host-ca.pem"}),
        (
            "mqtt",
            "mqtts://broker.test:8883",
            {
                "device_id": "02:00:00:00:00:01",
                "protocol": "3.1.1",
                "password": "transport-private",
            },
        ),
        ("mqtt", "mqtt://broker.test:1883", {"device_id": "02:00:00:00:00:01", "protocol": "5.0"}),
    ],
)
def test_four_transport_public_options_and_private_projection(api, kind, target, options):
    client, _, _, _ = api
    assert (
        client.post(
            "/api/device/connect", json={"kind": kind, "target": target, "options": options}
        ).status_code
        == 202
    )
    state = until(client, "/api/device", lambda state: state["status"] == "ready")
    assert state["kind"] == kind
    assert "transport-private" not in client.get("/api/device").text


def test_expected_identity_mismatch_never_enters_ready(api):
    client, _, _, _ = api
    client.post(
        "/api/device/connect",
        json={"kind": "usb", "target": "test", "expected_device_id": "02:00:00:00:00:99"},
    )
    state = until(client, "/api/device", lambda state: state["status"] == "disconnected")
    assert not state["identity"] and state["error"]


def test_sdk_subscriber_overflow_recovers_without_losing_connection(api, monkeypatch):
    client, backend, service, _ = api
    connect(client)

    async def burst():
        resume = asyncio.Event()
        reduce = service.reduce

        async def delayed_reduce(event, generation):
            if event.type == "data.available":
                await resume.wait()
            await reduce(event, generation)

        monkeypatch.setattr(service, "reduce", delayed_reduce)
        for sequence in range(1, 400):
            await backend.connection.emit(
                {
                    "event": "data.available",
                    "event_sequence": sequence,
                    "revision": 1,
                    "resource": 1,
                    "instance": 1,
                    "job_id": 0,
                    "sequence": sequence,
                    "dropped": 0,
                }
            )
        await asyncio.sleep(0.05)
        resume.set()

    client.portal.call(burst)
    assert not backend.connection.closed
    assert completed(client, command(client, "diagnostics"))["status"] == "completed"


@pytest.mark.parametrize("kind", ["gpio", "pwm"])
def test_observer_reads_output_status_without_control_or_output_changes(api, kind):
    client, backend, _, _ = api
    connect(client)
    ready(client)
    opened = completed(
        client,
        command(
            client,
            "resource.open",
            {
                "kind": kind,
                "pins": {"pin": 13},
                "config": {"mode": "output", "level": 1}
                if kind == "gpio"
                else {
                    "frequency": 1000,
                    "resolution": 10,
                    "duty": 50,
                    "breath_ms": 2000,
                },
            },
        ),
    )
    resource = opened["result"]["resource"]
    until(
        client,
        "/api/device",
        lambda state: any(r["id"] == resource for r in state["snapshot"]["resources"]),
    )
    before = len(backend.connection.commands)
    result = completed(
        client,
        command(
            client,
            "resource.call",
            {
                "resource": resource,
                "action": "status",
                "args": {},
            },
        ),
    )
    assert result["status"] == "completed"
    assert result["result"]["enabled"] is True
    if kind == "gpio":
        assert result["result"]["level"] == 1
    assert "control" not in client.get("/api/device").json()
    assert not any(
        c["op"] in {"control.acquire", "resource.open", "resource.close"}
        for c in backend.connection.commands[before:]
    )
