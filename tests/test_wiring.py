import copy

import pytest
from fastapi import HTTPException

from limivia_server.devices.wiring import WiringPlan, WiringStore

from . import test_devices
from .test_devices import completed, connect, ready, until

wiring_api = test_devices.api


def setup_plan(client):
    state = connect(client)
    device = state["identity"]["device_id"]
    url = "/api/wiring-plans/" + device
    plan = client.get(url).json()
    plan["groups"] = [
        {
            "id": "button",
            "name": "按键",
            "kind": "gpio",
            "pins": {"pin": 4},
            "config": {"mode": "input", "pull": "up"},
        }
    ]
    saved = client.put(url, json=plan)
    assert saved.status_code == 200, saved.text
    scope = {
        "device_id": device,
        "boot_id": state["identity"]["boot_id"],
        "generation": state["generation"],
        "revision": saved.json()["revision"],
    }
    return url, saved.json(), scope


def test_shared_save_has_no_hardware_effect_and_conflicts(wiring_api):
    client, backend, _, _ = wiring_api
    url, plan, _ = setup_plan(client)
    before = copy.deepcopy(backend.connection.commands)
    token = client.post("/api/pages").json()["page_session"]
    other = {"x-page-session": token}
    assert client.get(url, headers=other).json() == plan
    modified = {**plan, "title": "另一页面"}
    assert client.put(url, json=modified, headers=other).status_code == 200
    conflict = client.put(url, json=plan)
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["current"]["title"] == "另一页面"
    assert backend.connection.commands == before


def test_group_check_apply_and_existing_binding_not_replaced(wiring_api):
    client, backend, _, _ = wiring_api
    _, plan, scope = setup_plan(client)
    base = "/api/device/wiring-groups/button/"
    assert client.post(base + "apply", json=scope).status_code == 409
    ready(client)
    assert client.post(base + "apply", json=scope).status_code == 409
    assert (
        completed(client, client.post(base + "check", json=scope).json())["status"] == "completed"
    )
    task = completed(client, client.post(base + "apply", json=scope).json())
    assert task["status"] == "completed", task
    assert task["result"]["plan_revision"] == plan["revision"]
    state = until(client, "/api/device", lambda s: bool(s["wiring_bindings"]))
    assert state["wiring_bindings"]["button"]["instance"] > 0
    assert client.post(base + "apply", json=scope).status_code == 409
    assert len(backend.connection.resources) == 1


def test_revision_and_boot_are_checked_before_hardware_write(wiring_api):
    client, backend, _, _ = wiring_api
    url, plan, scope = setup_plan(client)
    ready(client)
    base = "/api/device/wiring-groups/button/"
    assert client.post(base + "check", json={**scope, "boot_id": "old"}).status_code == 409
    assert (
        completed(client, client.post(base + "check", json=scope).json())["status"] == "completed"
    )
    assert client.put(url, json={**plan, "title": "新版本"}).status_code == 200
    assert client.post(base + "apply", json=scope).status_code == 409
    assert not backend.connection.resources


def test_store_restart_retains_intent_and_atomic_revision(tmp_path):
    path = tmp_path / "wiring.sqlite3"
    first = WiringStore(path)
    plan = WiringPlan(board="test", revision=0)
    first.save("device", plan)
    first.close()
    second = WiringStore(path)
    assert second.get("device")["revision"] == 1
    with pytest.raises(HTTPException):
        second.save("device", plan)
    second.close()


def test_parent_cycle_is_rejected():
    with pytest.raises(ValueError, match="父总线"):
        WiringPlan(
            board="test",
            revision=0,
            groups=[
                {"id": "a", "name": "a", "parent_group": "b"},
                {"id": "b", "name": "b", "parent_group": "a"},
            ],
        )


def resource_save_body(client):
    state = connect(client)
    ready(client)
    opened = completed(
        client,
        test_devices.command(
            client,
            "resource.open",
            {"kind": "gpio", "pins": {"pin": 10}, "config": {"mode": "output", "level": 1}},
        ),
    )
    resource = opened["result"]["resource"]
    state = until(
        client, "/api/device", lambda s: not s["stale"] and len(s["snapshot"]["resources"]) == 1
    )
    return {
        "device_id": state["identity"]["device_id"],
        "boot_id": state["identity"]["boot_id"],
        "generation": state["generation"],
        "revision": 0,
        "resource": resource,
        "instance": state["snapshot"]["resources"][0]["instance"],
        "group_id": "external-led",
        "name": "外置 LED",
        "notes": "实验记录",
        "plan": {"board": state["identity"]["board"], "revision": 0},
    }


def test_save_existing_gpio_is_atomic_idempotent_and_has_no_write(wiring_api):
    client, backend, _, _ = wiring_api
    body = resource_save_body(client)
    before = copy.deepcopy(backend.connection.resources)
    start = len(backend.connection.commands)
    response = client.post("/api/device/wiring-groups/from-resource", json=body)
    assert response.status_code == 200, response.text
    assert response.json()["groups"][0]["config"]["level"] == 1
    repeated = client.post("/api/device/wiring-groups/from-resource", json=body)
    assert repeated.status_code == 200, repeated.text
    assert repeated.json() == response.json()
    assert backend.connection.resources == before
    assert not any(
        c["op"] in {"resource.open", "resource.close", "resource.recover", "control.acquire"}
        or (c["op"] == "resource.call" and c["params"]["action"] != "status")
        for c in backend.connection.commands[start:]
    )
    state = client.get("/api/device").json()
    assert state["wiring_bindings"]["external-led"]["resource"] == body["resource"]


def test_save_existing_gpio_rejects_scope_conflict_and_duplicate_association(wiring_api):
    client, backend, _, _ = wiring_api
    body = resource_save_body(client)
    url = "/api/device/wiring-groups/from-resource"
    for patch in [{"boot_id": "old"}, {"instance": 999}, {"revision": 3}]:
        assert client.post(url, json={**body, **patch}).status_code == 409
    saved = client.post(url, json=body)
    assert saved.status_code == 200, saved.text
    duplicate = {**body, "group_id": "other", "revision": 1, "plan": saved.json()}
    assert client.post(url, json=duplicate).status_code == 409
    plan = saved.json()
    plan["title"] = "另一页面修改"
    assert client.put("/api/wiring-plans/" + body["device_id"], json=plan).status_code == 200
    conflict = client.post(url, json=body)
    assert conflict.status_code == 409
    assert len(backend.connection.resources) == 1


def test_observer_can_record_existing_gpio_without_gaining_control(wiring_api):
    client, backend, _, _ = wiring_api
    body = resource_save_body(client)
    observer = client.post("/api/pages").json()["page_session"]
    headers = {"x-page-session": observer}
    saved = client.post("/api/device/wiring-groups/from-resource", json=body, headers=headers)
    assert saved.status_code == 200, saved.text
    state = client.get("/api/device", headers=headers).json()
    assert "control" not in state
    assert state["resource_origin"][str(body["resource"])] == "managed"
    assert len(backend.connection.resources) == 1
    completed(
        client, test_devices.command(client, "resource.close", {"resource": body["resource"]})
    )
    until(client, "/api/device", lambda s: not s["snapshot"]["resources"])
    assert (
        client.post(
            "/api/device/wiring-groups/from-resource", json=body, headers=headers
        ).status_code
        == 409
    )
