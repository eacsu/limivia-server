import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from limivia import Backend

from limivia_server.devices.api import device_router, enforce_origin
from limivia_server.devices.service import DeviceService
from limivia_server.paths import WEB_DIST


def create_app(
    dist: Path = WEB_DIST, backend: Backend | None = None, data_dir: Path | None = None
) -> FastAPI:
    if not (dist / "index.html").is_file():
        raise RuntimeError("前端尚未构建，请先执行 pnpm --dir src/web run build")
    directory = data_dir or Path(
        os.environ.get(
            "LIMIVIA_DATA_DIR",
            str(
                Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share")))
                / "limivia-server"
            ),
        )
    )
    service = DeviceService(
        backend, directory, job_timeout=float(os.environ.get("LIMIVIA_JOB_TIMEOUT", "300"))
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await service.start()
        try:
            yield
        finally:
            await service.close()

    app = FastAPI(title="LIMIVIA", version="0.1.0", lifespan=lifespan)
    app.state.devices = service
    app.middleware("http")(enforce_origin)

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/info")
    async def info() -> dict:
        return {
            "name": "LIMIVIA",
            "version": "0.1.0",
            "protocol": 3,
            "contract": "limivia-v3-jsonrpc2-r2",
            "transports": ["ble", "usb", "ws", "mqtt"],
            "device_owner": "backend",
            "default_transport": "ble",
        }

    app.include_router(device_router(service))

    @app.api_route("/api", methods=["GET", "HEAD"], include_in_schema=False)
    @app.api_route("/api/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    async def unknown_api(path: str = ""):
        raise HTTPException(404, detail="API route not found")

    if (dist / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")
    app.frontend("/", directory=dist, fallback="index.html", check_dir=True)
    return app


app = create_app()
