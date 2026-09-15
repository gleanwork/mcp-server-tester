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
import os
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
        image.thumbnail((DISPLAY_WIDTH, DISPLAY_HEIGHT), Image.Resampling.LANCZOS)
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
    import mss

    with mss.MSS() as capture:
        monitor = capture.monitors[1]
        return (
            int(coordinate[0] * monitor["width"] / DISPLAY_WIDTH),
            int(coordinate[1] * monitor["height"] / DISPLAY_HEIGHT),
        )


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
        pyautogui.write(action["text"], interval=0.002)
        return "text entered", False
    if name == "key":
        text = str(action["text"])
        keys = [part.strip().lower() for part in text.split("+")]
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


async def run(query: str, max_actions: int, mode: str) -> dict[str, Any]:
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
                "stop without taking an action."
            ),
        }]
        system = (
            "You are a bounded HITL resolver. Use screenshots and Computer Use actions only. "
            "Choose the first visible option when a task approval/choice prompt is present. "
            "Never submit a query or change account settings. If no HITL prompt is visible, stop."
        )
    else:
        messages = [{
            "role": "user",
            "content": (
                "Control the already installed Claude Desktop app. Open or focus Cowork, "
                "create a fresh Cowork task, enter the exact query below, and submit it once. "
                "After the first Enter/Return that submits the query, stop immediately and "
                "reply with SUBMITTED. Do not wait for or read the answer.\n\n"
                f"Exact query:\n{query}"
            ),
        }]
        system = (
            "You are a bounded desktop submission operator. Use screenshots and Computer Use "
            "actions only. You may open/focus Claude, select Cowork, create a fresh task, "
            "type the supplied query, and submit it once. Never submit twice. After the first "
            "successful Enter/Return, stop. Do not approve permissions or change account settings."
        )

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
        messages.append({"role": "assistant", "content": response.content})
        tool_results: list[dict[str, Any]] = []
        for block in response.content:
            if getattr(block, "type", None) != "tool_use":
                continue
            log(f"executing action {action_number}: {block.input.get('action', 'unknown')}")
            result, submitted = execute_action(block.input)
            if submitted and mode != "hitl":
                log("submission boundary reached; stopping immediately")
                return {
                    "status": "submitted",
                    "action_count": action_number,
                    "model": model,
                    "submission_action": block.input,
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
                return {"status": "hitl_checked", "action_count": action_number, "model": model}
            raise RuntimeError("Computer Use planner stopped before submitting the Cowork query")
        messages.append({"role": "user", "content": tool_results})

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
        print(json.dumps({"status": "failed", "error": str(error)}), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
