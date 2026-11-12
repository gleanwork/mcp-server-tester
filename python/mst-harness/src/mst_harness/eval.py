"""verifiers' eval for any taskset, with MST as the harness.

    python -m mst_harness.eval <taskset> [verifiers eval options]

`<taskset>` is a taskset package directory (its `pyproject.toml` names the package) or a
taskset id that is already installed. `mst verifiers run` starts this in a temporary venv
that holds mst-harness and the taskset.

Two things differ from verifiers' own `eval`:

- **MST's defaults.** Without a config file (`@ file.toml`), the run uses `mst-harness`
  as the harness, a subprocess runtime and verifiers' interception server, unless the
  options name them. With a config file, the file decides.
- **The taskset's Environment.** verifiers 0.2 resolves the taskset and harness from a
  package's `__all__` but always builds the base `Environment`. A taskset package that
  exports an `Environment` subclass gets it here.
"""

from __future__ import annotations

import sys
import tomllib
from collections.abc import Sequence
from importlib import import_module
from pathlib import Path
from typing import Any

from verifiers.v1.env import EnvConfig, Environment
from verifiers.v1.loaders import _plugin_class, import_taskset  # pyright: ignore[reportPrivateUsage]

DEFAULTS: tuple[tuple[str, str], ...] = (
    ("--harness.id", "mst-harness"),
    ("--harness.runtime.type", "subprocess"),
    ("--interception.type", "server"),
)


def taskset_id(taskset: str) -> str:
    """The taskset's id: a package directory's project name, else `taskset` as given."""
    pyproject = Path(taskset) / "pyproject.toml"
    if not pyproject.is_file():
        return taskset
    project = tomllib.loads(pyproject.read_text()).get("project", {})
    name = project.get("name")
    if not isinstance(name, str) or not name:
        raise SystemExit(f"{pyproject} has no [project].name, so it names no taskset.")
    return name


def eval_argv(argv: Sequence[str]) -> list[str]:
    """`argv` with the taskset as an id, and MST's defaults where nothing set them."""
    args = list(argv)
    if args and not args[0].startswith("-") and args[0] != "@":
        args[0] = taskset_id(args[0])
    if "@" in args or any(arg.startswith("@") and len(arg) > 1 for arg in args):
        return args
    for flag, value in DEFAULTS:
        if not any(arg == flag or arg.startswith(f"{flag}=") for arg in args):
            args += [flag, value]
    return args


def environment_class(taskset: str) -> type[Environment]:
    module = import_taskset(taskset)
    exported = any(
        isinstance(candidate := getattr(module, name, None), type)
        and issubclass(candidate, Environment)
        and candidate is not Environment
        for name in getattr(module, "__all__", ())
    )
    return _plugin_class(module, Environment, "environment") if exported else Environment


def load_environment(config: EnvConfig) -> Environment:
    return environment_class(config.taskset.id)(config)


def main(argv: Sequence[str] | None = None) -> None:
    args = eval_argv(sys.argv[1:] if argv is None else argv)
    verifiers: Any = import_module("verifiers.v1")
    verifiers.Environment = load_environment
    from verifiers.v1.cli.eval.main import main as verifiers_main

    verifiers_main(args)


if __name__ == "__main__":
    main()
