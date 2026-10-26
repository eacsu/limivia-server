from __future__ import annotations

import logging
import os
import shutil
from importlib import metadata
from pathlib import Path
from typing import Annotated

import typer

from limivia_server.paths import WEB_DIST

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
logger = logging.getLogger(__name__)
app = typer.Typer(help="LIMIVIA 本机工作台服务", no_args_is_help=True)


@app.command()
def serve(
    host: str = typer.Option("0.0.0.0", envvar="LIMIVIA_HOST", help="监听地址"),
    port: int = typer.Option(8000, min=1, max=65535, envvar="LIMIVIA_PORT", help="监听端口"),
    data_dir: Annotated[
        Path | None, typer.Option(envvar="LIMIVIA_DATA_DIR", help="任务数据库与连接锁目录")
    ] = None,
    job_timeout: float = typer.Option(
        300, min=1, envvar="LIMIVIA_JOB_TIMEOUT", help="设备作业跟踪期限（秒，超时不取消设备作业）"
    ),
    ble_adapter: str | None = typer.Option(
        None, envvar="LIMIVIA_BLE_ADAPTER", help="Linux BLE 适配器，例如 hci1"
    ),
) -> None:
    """启动统一托管前端的 FastAPI 服务。"""
    if not (WEB_DIST / "index.html").is_file():
        logger.error("请先执行 pnpm --dir src/web run build")
        raise typer.Exit(1)
    import uvicorn

    if data_dir:
        os.environ["LIMIVIA_DATA_DIR"] = str(data_dir.resolve())
    os.environ["LIMIVIA_JOB_TIMEOUT"] = str(job_timeout)
    if ble_adapter:
        os.environ["LIMIVIA_BLE_ADAPTER"] = ble_adapter
    uvicorn.run("limivia_server.web.app:app", host=host, port=port)


@app.command()
def doctor() -> None:
    """检查工作台运行环境与前端构建。"""
    for name in ("poetry", "pnpm"):
        logger.info("%s: %s", name, shutil.which(name) or "未找到")
    logger.info("前端构建: %s", (WEB_DIST / "index.html").exists())
    try:
        import limivia
        from limivia import AsyncConnection, AsyncGPIOPin
        from limivia.types import DeviceIdentity

        contract = DeviceIdentity.model_json_schema()["properties"]["contract"]["const"]
        if (
            metadata.version("limivia") != "0.3.0a7"
            or not hasattr(AsyncConnection, "raw")
            or not hasattr(AsyncGPIOPin, "write")
        ):
            raise ValueError("需要 limivia 0.3.0a7 高层业务接口")
        if contract != "limivia-v3-jsonrpc2-r2":
            raise ValueError("SDK contract 不兼容")
        logger.info("SDK: %s / %s / %s", metadata.version("limivia"), limivia.__file__, contract)
        provenance = metadata.distribution("limivia").read_text("direct_url.json")
        logger.info("SDK 安装来源: %s", provenance or "包索引安装；请另外核对构建来源")
    except (ImportError, KeyError, ValueError, metadata.PackageNotFoundError) as exc:
        logger.error(
            "请使用项目 .venv 的 pip 手动安装已核验的 limivia 0.3.0a7 JSON-RPC v3 SDK wheel。"
        )
        raise typer.Exit(1) from exc


if __name__ == "__main__":
    app()
