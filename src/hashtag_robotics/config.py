from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="HASHTAG_",
        env_file=".env",
        extra="ignore",
    )

    app_name: str = "Hashtag Robotics"
    host: str = "127.0.0.1"
    port: int = 8765
    open_browser: bool = True
    enable_physical: bool = False
    agent_model: str | None = None
    log_level: str = "INFO"
    data_dir: Path = Field(default_factory=lambda: Path.home() / ".hashtag-robotics")
    frontend_dev_url: str | None = None
    simulation_step_seconds: float = 0.08

    @property
    def database_path(self) -> Path:
        return self.data_dir / "state.db"

    @property
    def diagnostics_dir(self) -> Path:
        return self.data_dir / "diagnostics"

    def ensure_directories(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.diagnostics_dir.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.ensure_directories()
    return settings
