from __future__ import annotations

import json
import threading
import webbrowser

import typer
import uvicorn

from hashtag_robotics import __version__
from hashtag_robotics.config import get_settings
from hashtag_robotics.doctor import DoctorService

app = typer.Typer(
    name="hashtag-robotics",
    help="Hashtag Robotics local SO-101 control plane.",
    no_args_is_help=False,
)


def _serve() -> None:
    settings = get_settings()
    if settings.open_browser:
        threading.Timer(
            0.9,
            lambda: webbrowser.open(f"http://{settings.host}:{settings.port}"),
        ).start()
    uvicorn.run(
        "hashtag_robotics.api:create_app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
        factory=True,
    )


@app.callback(invoke_without_command=True)
def main(context: typer.Context) -> None:
    """Start the local dashboard when no subcommand is supplied."""
    if context.invoked_subcommand is None:
        _serve()


@app.command()
def serve() -> None:
    """Start the local control plane and dashboard."""
    _serve()


@app.command()
def doctor() -> None:
    """Print a read-only compatibility and safety report."""
    settings = get_settings()
    report = DoctorService(settings).run()
    typer.echo(json.dumps(report.model_dump(mode="json"), indent=2))
    if report.overall.value == "blocked":
        raise typer.Exit(code=2)


@app.command()
def capabilities() -> None:
    """Print the detected runtime capability manifest."""
    settings = get_settings()
    manifest = DoctorService(settings).capabilities()
    typer.echo(json.dumps(manifest.model_dump(mode="json"), indent=2))


@app.command("hil-checklist")
def hil_checklist() -> None:
    """Print the physical hardware-in-the-loop gate."""
    typer.echo(
        "\n".join(
            [
                "SO-101 HIL gate",
                "[ ] Workspace is clear and collision-free",
                "[ ] Leader and follower identities are verified",
                "[ ] Calibration backup and revision are verified",
                "[ ] Joint and relative target limits are verified",
                "[ ] Emergency stop is tested",
                "[ ] Power, torque and safe pose are verified",
                "",
                "Physical actuation remains disabled until this gate is completed.",
            ]
        )
    )


@app.command()
def version() -> None:
    """Print the application version."""
    typer.echo(__version__)
