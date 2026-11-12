"""`uv run eval` with the taskset's own Environment, as enterprise-bench's `eval` does.

verifiers 0.2 resolves the taskset and harness from package `__all__` but always builds
the base `Environment`. This entrypoint lets a taskset package export its subclass.
"""

from __future__ import annotations

from importlib import import_module
from typing import Any

from verifiers.v1.env import EnvConfig, Environment
from verifiers.v1.loaders import _plugin_class, import_taskset  # pyright: ignore[reportPrivateUsage]


def environment_class(taskset_id: str) -> type[Environment]:
    module = import_taskset(taskset_id)
    exported = any(
        isinstance(candidate := getattr(module, name, None), type)
        and issubclass(candidate, Environment)
        and candidate is not Environment
        for name in getattr(module, "__all__", ())
    )
    return _plugin_class(module, Environment, "environment") if exported else Environment


def load_environment(config: EnvConfig) -> Environment:
    return environment_class(config.taskset.id)(config)


def main() -> None:
    verifiers: Any = import_module("verifiers.v1")
    verifiers.Environment = load_environment
    from verifiers.v1.cli.eval.main import main as verifiers_main

    verifiers_main()


if __name__ == "__main__":
    main()
