#!/usr/bin/env python3
"""Submit one Claude Cowork query through a bounded screenshot/action loop.

The process stops immediately after the first submit key. MST owns native-session
correlation, terminal validation, response extraction, and telemetry collection.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import math
import os
import re
import subprocess
import sys
import time
from typing import Any

DISPLAY_WIDTH = 1280
DISPLAY_HEIGHT = 800
DEFAULT_MODEL = "claude-sonnet-4-6"
DEFAULT_MAX_ACTIONS = 24


def log(message: str) -> None:
    print(f"[mst:cowork-cu] {message}", file=sys.stderr, flush=True)


def screenshot() -> dict[str, Any]:
    import mss
    from PIL import Image

    with mss.MSS() as capture:
        monitor = capture.monitors[1]
        raw = capture.grab(monitor)
        image = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
        image = image.resize((DISPLAY_WIDTH, DISPLAY_HEIGHT), Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        return {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": base64.standard_b64encode(buffer.getvalue()).decode("ascii"),
            },
        }


def screen_point(coordinate: list[int]) -> tuple[int, int]:
    import pyautogui

    width, height = pyautogui.size()  # Logical points, not Retina capture pixels.
    return (
        int(coordinate[0] * width / DISPLAY_WIDTH),
        int(coordinate[1] * height / DISPLAY_HEIGHT),
    )


def type_query(text: str) -> None:
    """Unicode keyboard events; line breaks must not submit the composer."""
    import Quartz
    import pyautogui

    for line_index, line in enumerate(text.split("\n")):
        if line_index:
            pyautogui.hotkey("shift", "enter")
        for start in range(0, len(line), 16):
            chunk = line[start:start + 16]
            units = len(chunk.encode("utf-16-le")) // 2
            for down in (True, False):
                event = Quartz.CGEventCreateKeyboardEvent(None, 0, down)
                Quartz.CGEventKeyboardSetUnicodeString(event, units, chunk)
                Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
            time.sleep(0.01)


def execute_action(action: dict[str, Any]) -> tuple[Any, bool]:
    import pyautogui

    name = action.get("action")
    if name == "screenshot":
        return screenshot(), False
    if name in {
        "left_click",
        "right_click",
        "middle_click",
        "double_click",
        "triple_click",
    }:
        x, y = screen_point(action["coordinate"])
        button = {
            "right_click": "right",
            "middle_click": "middle",
        }.get(name, "left")
        clicks = {
            "double_click": 2,
            "triple_click": 3,
        }.get(name, 1)
        pyautogui.click(x, y, clicks=clicks, button=button)
        return f"{name} completed", False
    if name == "cursor_position":
        x, y = pyautogui.position()
        return {"x": int(x), "y": int(y)}, False
    if name == "mouse_move":
        x, y = screen_point(action["coordinate"])
        pyautogui.moveTo(x, y)
        return "mouse_move completed", False
    if name == "left_click_drag":
        start_x, start_y = screen_point(action["start_coordinate"])
        end_x, end_y = screen_point(action["coordinate"])
        pyautogui.moveTo(start_x, start_y)
        pyautogui.dragTo(end_x, end_y, duration=0.4, button="left")
        return "drag completed", False
    if name == "type":
        type_query(action["text"])
        return "text entered", False
    if name == "key":
        text = str(action["text"])
        aliases = {"return": "enter", "super": "command", "cmd": "command", "ctrl": "ctrl"}
        keys = [aliases.get(part.strip().lower(), part.strip().lower()) for part in text.split("+")]
        if len(keys) == 1:
            pyautogui.press(keys[0])
        else:
            pyautogui.hotkey(*keys)
        submitted = any(key in {"enter", "return"} for key in keys)
        return f"key completed: {text}", submitted
    if name == "scroll":
        x, y = screen_point(action.get("coordinate", [DISPLAY_WIDTH // 2, DISPLAY_HEIGHT // 2]))
        amount = int(action.get("scroll_amount", 3))
        direction = action.get("scroll_direction", "down")
        pyautogui.moveTo(x, y)
        pyautogui.scroll(-amount if direction == "down" else amount)
        return "scroll completed", False
    if name == "wait":
        time.sleep(min(float(action.get("duration", 1)), 5.0))
        return "wait completed", False
    raise RuntimeError(f"unsupported Computer Use action: {name}")


TOKEN_FIELDS = (
    "input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens",
)


class ComputerUseDriverError(RuntimeError):
    def __init__(self, message: str, telemetry: dict[str, Any]):
        super().__init__(message)
        self.telemetry = telemetry


class Telemetry:
    """Only completed API responses and allowlisted scalar data; never request content."""

    def __init__(self) -> None:
        self.started = time.monotonic()
        self.models: list[str] = []
        self.responses = 0
        self.usage: dict[str, int | float] = {}
        self.coverage = {field: 0 for field in TOKEN_FIELDS}
        self.actions = 0
        self.attempted = 0
        self.executed = 0
        self.refused = 0

    def observe(self, response: Any) -> None:
        self.responses += 1
        model = getattr(response, "model", None)
        secrets = [value for key, value in os.environ.items()
                   if value and re.search(r"token|key|secret|password|authorization", key, re.I)]
        if (isinstance(model, str) and re.fullmatch(r"claude-[a-z0-9][a-z0-9.-]{0,99}", model)
                and not any(secret in model for secret in secrets) and model not in self.models):
            self.models.append(model)
        usage = getattr(response, "usage", None)
        for field in TOKEN_FIELDS:
            value = getattr(usage, field, None)
            if (type(value) in (int, float) and 0 <= value <= 9007199254740991
                    and math.isfinite(value) and value == int(value)):
                total = self.usage.get(field, 0) + value
                if total <= 9007199254740991:
                    self.usage[field] = total
                    self.coverage[field] += 1

    def snapshot(self, accounting: str) -> dict[str, Any]:
        return {
            "accounting": accounting,
            "response_models": list(self.models),
            "planner_response_count": self.responses,
            "usage": dict(self.usage),
            "usage_observation_counts": dict(self.coverage),
            "duration_ms": max(0, (time.monotonic() - self.started) * 1000),
            "action_count": self.actions,
            "attempted_action_count": self.attempted,
            "executed_action_count": self.executed,
            "refused_action_count": self.refused,
            # Anthropic Messages usage does not supply authoritative dollar cost.
            "cost": {"status": "unavailable"},
        }


async def run(query: str, max_actions: int, mode: str) -> dict[str, Any]:
    telemetry = Telemetry()
    try:
        result = await run_driver(query, max_actions, mode, telemetry)
        result["telemetry"] = telemetry.snapshot("complete")
        return result
    except Exception as error:
        raise ComputerUseDriverError(str(error), telemetry.snapshot("partial")) from error


async def run_driver(query: str, max_actions: int, mode: str, telemetry: Telemetry) -> dict[str, Any]:
    try:
        import anthropic
    except ImportError as error:
        raise RuntimeError("Install the Computer Use dependencies: pip install anthropic pyautogui mss Pillow") from error

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is required for the Computer Use submission driver")

    client = anthropic.Anthropic(api_key=api_key)
    model = os.environ.get("MST_COWORK_CUA_MODEL", DEFAULT_MODEL)
    log(f"starting driver with model={model}, max_actions={max_actions}")
    subprocess.run(["open", "-a", "Claude"], check=False, capture_output=True)
    log("requested Claude Desktop launch/focus")
    time.sleep(float(os.environ.get("MST_COWORK_CUA_START_DELAY", "3")))

    tools = [{
        "type": "computer_20251124",
        "name": "computer",
        "display_width_px": DISPLAY_WIDTH,
        "display_height_px": DISPLAY_HEIGHT,
    }]
    if mode == "hitl":
        messages: list[dict[str, Any]] = [{
            "role": "user",
            "content": (
                "Inspect the currently visible Claude Desktop Cowork task. If a human-in-the-loop "
                "approval or choice prompt is blocking progress, choose the first visible option. "
                "Do not submit a new query, do not change account settings, and do not approve a "
                "prompt unless it is the visible task's first option. If no such prompt is visible, "
                "stop without taking an action.\n\nTask to locate (do not type or submit this text):\n" + query
            ),
        }]
        system = (
            "You are a bounded HITL resolver. Use screenshots and Computer Use actions only. "
            "Choose the first visible option when a task approval/choice prompt is present. "
            "Never submit a query or change account settings. If no HITL prompt is visible, stop."
        )
    else:
        tools.append({
            "name": "fill_query",
            "description": (
                "Insert the unchanged original evaluation query into the focused "
                "empty Cowork task composer. First locate and focus that composer using a screenshot. "
                "This tool takes no text: the harness supplies the exact text. It may run only once. "
                "After it succeeds, use computer key Enter to submit, never click Send."
            ),
            "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
        })
        messages = [{
            "role": "user",
            "content": (
                "Control Claude Desktop. Open Cowork, create a fresh task, and focus its empty "
                "prompt composer. Call fill_query with no arguments. It inserts the original "
                "query for you. Do not reconstruct or type the query yourself. Then press "
                "unmodified Enter once to submit. Do not wait for or read the answer."
            ),
        }]
        system = (
            "You are a bounded desktop submission operator. Use screenshots and Computer Use "
            "actions to open/focus Claude, select Cowork, create a fresh task, and focus its composer. "
            "Use fill_query, not computer type, to insert the query. After fill_query succeeds, "
            "submit with unmodified Enter, never by clicking Send. Never submit twice. Stop after "
            "submission. Do not approve permissions or change account settings."
        )

    # Ground the first action in a current screenshot, not an assumed layout.
    messages[0]["content"] = [{"type": "text", "text": messages[0]["content"]}, screenshot()]
    hitl_action_taken = False
    actions_executed = 0
    typed_query = False
    for action_number in range(1, max_actions + 1):
        log(f"requesting Computer Use plan {action_number}/{max_actions}")
        response = client.beta.messages.create(
            model=model,
            max_tokens=1024,
            system=system,
            tools=tools,
            messages=messages,
            betas=["computer-use-2025-11-24"],
        )
        telemetry.observe(response)
        messages.append({"role": "assistant", "content": response.content})
        tool_results: list[dict[str, Any]] = []
        for block in response.content:
            if getattr(block, "type", None) != "tool_use":
                continue
            if actions_executed >= max_actions:
                raise RuntimeError("Computer Use action budget exhausted; no further actions executed")
            actions_executed += 1
            telemetry.actions += 1
            tool_name = getattr(block, "name", "computer")
            action = block.input
            action_name = action.get('action', 'unknown')
            refusal = None
            if mode == "hitl" and (tool_name != "computer" or action_name not in {"screenshot", "wait", "mouse_move", "cursor_position", "left_click", "scroll"}):
                telemetry.refused += 1
                raise RuntimeError("HITL cannot type, press keys, drag, or submit tasks")
            if mode == "submit":
                if tool_name == "fill_query":
                    if typed_query:
                        refusal = "The query is already entered. Do not fill again. Use unmodified Enter to submit."
                    elif block.input != {}:
                        refusal = "fill_query takes no arguments; the harness owns the original text."
                    else:
                        action = {"action": "type", "text": query}
                        action_name = "type"
                elif tool_name != "computer":
                    refusal = "Unknown tool. Use computer for navigation and fill_query for text entry."
                elif action_name == "type":
                    refusal = "Do not reconstruct the query. Focus the empty composer, then call fill_query with no arguments."
                elif action_name == "key" and any(k.strip().lower() in {"enter", "return"} for k in str(action.get("text", "")).split("+")):
                    if not typed_query or str(action.get("text", "")).lower() not in {"enter", "return"}:
                        refusal = "Only an unmodified Enter after fill_query succeeds may submit."
                elif typed_query and action_name not in {"screenshot", "wait", "cursor_position"}:
                    refusal = "The query is entered. Only screenshots or the single Enter submission are allowed."
            if refusal:
                telemetry.refused += 1
                # A rejected proposal has no desktop side effects. Let the planner correct it
                # within the same action budget; never retry a failed physical text entry.
                tool_results.append({"type": "tool_result", "tool_use_id": block.id, "content": refusal, "is_error": True})
                continue
            log(f"executing action {actions_executed}: {action_name}")
            if mode == "hitl" and action_name not in {
                "screenshot",
                "wait",
                "mouse_move",
                "cursor_position",
            }:
                hitl_action_taken = True
            telemetry.attempted += 1
            result, submitted = execute_action(action)
            telemetry.executed += 1
            if tool_name == "fill_query":
                typed_query = True
            if submitted and mode != "hitl":
                log("submission boundary reached; stopping immediately")
                return {
                    "status": "submitted",
                    "action_count": actions_executed,
                    "model": model,
                    "submission_action": {"action": "key", "text": "enter"},
                }
            if isinstance(result, dict) and result.get("type") == "image":
                tool_content: Any = [result]
            else:
                tool_content = str(result)
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": tool_content,
            })
        if not tool_results:
            if mode == "hitl":
                log("no HITL action was needed")
                return {"status": "hitl_checked", "action_count": actions_executed, "model": model}
            raise RuntimeError("Computer Use planner stopped before submitting the Cowork query")
        messages.append({"role": "user", "content": tool_results})

    if mode == "hitl" and not hitl_action_taken:
        log("no visible HITL prompt found within the bounded check")
        return {
            "status": "hitl_checked",
            "action_count": actions_executed,
            "prompt_found": False,
            "model": model,
        }
    if mode == "hitl":
        raise RuntimeError(
            f"Computer Use HITL check exceeded {max_actions} actions after attempting a visible prompt"
        )
    raise RuntimeError(f"Computer Use submission exceeded {max_actions} actions without submitting")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("query")
    parser.add_argument("--max-actions", type=int, default=DEFAULT_MAX_ACTIONS)
    parser.add_argument("--mode", choices=["submit", "hitl"], default="submit")
    args = parser.parse_args()
    try:
        print(json.dumps(asyncio.run(run(args.query, args.max_actions, args.mode))), flush=True)
        return 0
    except Exception as error:
        log(f"driver failed: {error}")
        result = {"status": "failed", "error": str(error)}
        if isinstance(error, ComputerUseDriverError):
            result["telemetry"] = error.telemetry
        print(json.dumps(result), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
