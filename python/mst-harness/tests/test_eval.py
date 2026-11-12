from pathlib import Path

import pytest

from mst_harness.eval import eval_argv, taskset_id


def write_taskset(tmp_path: Path, name: str = "acme-tasks") -> Path:
    (tmp_path / "pyproject.toml").write_text(f'[project]\nname = "{name}"\n')
    return tmp_path


def test_a_package_directory_names_its_taskset(tmp_path: Path) -> None:
    assert taskset_id(str(write_taskset(tmp_path))) == "acme-tasks"


def test_anything_else_is_the_taskset_id() -> None:
    assert taskset_id("acme-tasks") == "acme-tasks"


def test_a_directory_without_a_project_name_fails(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[tool.x]\n")
    with pytest.raises(SystemExit, match=r"\[project\]\.name"):
        taskset_id(str(tmp_path))


def test_without_a_config_file_mst_defaults_fill_what_is_unset(tmp_path: Path) -> None:
    args = eval_argv([str(write_taskset(tmp_path)), "--harness.runtime.type=docker"])
    assert args == [
        "acme-tasks",
        "--harness.runtime.type=docker",
        "--harness.id",
        "mst-harness",
        "--interception.type",
        "server",
    ]


def test_with_a_config_file_the_file_decides(tmp_path: Path) -> None:
    args = eval_argv([str(write_taskset(tmp_path)), "@", "eval.json", "--model", "m"])
    assert args == ["acme-tasks", "@", "eval.json", "--model", "m"]
