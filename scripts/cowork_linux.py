#!/usr/bin/env python3
"""Bounded AT-SPI actions against an already prepared Linux Cowork desktop.

This module does not provision, authenticate, launch a desktop session, or collect
answers. The MST host binds and reads native sessions. JSON input arrives on stdin;
stdout contains only an allowlisted receipt, never prompt or accessibility text.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from urllib.parse import quote


class DriverFailure(RuntimeError):
    pass


class Desktop:
    def __init__(self) -> None:
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
        self.api = Atspi

    def application(self):
        root = self.api.get_desktop(0)
        matches = []
        for index in range(root.get_child_count()):
            node = root.get_child_at_index(index)
            if node and (node.get_name() or "").casefold() in {"claude", "claude-desktop"}:
                matches.append(node)
        if len(matches) != 1:
            raise DriverFailure("desktop_missing_or_ambiguous")
        return matches[0]

    def controls(self, names: set[str], roles: set[str]):
        pending = [self.application()]
        found = []
        seen = 0
        while pending:
            node = pending.pop()
            seen += 1
            if seen > 5000:
                raise DriverFailure("accessibility_tree_budget")
            try:
                states = node.get_state_set()
                if (node.get_role_name() in roles and node.get_name() in names
                        and states.contains(self.api.StateType.VISIBLE)
                        and states.contains(self.api.StateType.ENABLED)
                        and states.contains(self.api.StateType.SENSITIVE)):
                    found.append(node)
                pending.extend(node.get_child_at_index(i) for i in range(node.get_child_count()))
            except DriverFailure:
                raise
            except Exception:
                continue
        return found

    def selected(self, node) -> bool:
        states = node.get_state_set()
        return states.contains(self.api.StateType.CHECKED) or states.contains(self.api.StateType.SELECTED)

    def activate(self, node) -> None:
        if not node.is_action() or not node.do_action(0):
            # Even a failed action acknowledgement may have had an effect.
            raise DriverFailure("action_acknowledgement_uncertain")

    def open_prompt(self, prompt: str, timeout: float) -> None:
        subprocess.run(
            ["/usr/bin/claude-desktop", "--no-sandbox", "claude://claude.ai/new?q=" + quote(prompt, safe="")],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout,
        )


class Driver:
    def __init__(self, desktop, timeout_ms: int, max_actions: int) -> None:
        self.desktop = desktop
        self.started = time.monotonic()
        self.deadline = self.started + timeout_ms / 1000
        self.max_actions = max_actions
        self.actions = 0

    def remaining(self) -> float:
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise DriverFailure("deadline_exceeded")
        return remaining

    def action(self, operation) -> None:
        self.remaining()
        if self.actions >= self.max_actions:
            raise DriverFailure("action_budget_exhausted")
        self.actions += 1
        operation()

    def receipt(self, status: str) -> dict:
        return {"status": status, "action_count": self.actions,
                "duration_ms": (time.monotonic() - self.started) * 1000}

    def probe(self) -> dict:
        controls = self.desktop.controls({"Cowork", "Start task"}, {"button", "radio button"})
        if not controls:
            raise DriverFailure("cowork_not_ready")
        return self.receipt("ready")

    def select_cowork(self) -> None:
        requested = set()
        while True:
            self.remaining()
            radios = self.desktop.controls({"Cowork"}, {"radio button"})
            if len(radios) > 1:
                raise DriverFailure("cowork_control_ambiguous")
            if radios:
                if self.desktop.selected(radios[0]):
                    return
                if "radio" not in requested:
                    requested.add("radio")
                    self.action(lambda: self.desktop.activate(radios[0]))
            elif self.desktop.controls({"Start task"}, {"button"}):
                return
            else:
                tabs = self.desktop.controls({"Cowork"}, {"button"})
                if len(tabs) > 1:
                    raise DriverFailure("cowork_control_ambiguous")
                if tabs and "tab" not in requested:
                    requested.add("tab")
                    self.action(lambda: self.desktop.activate(tabs[0]))
            time.sleep(min(0.1, self.remaining()))

    def submit(self, prompt: str) -> dict:
        if not isinstance(prompt, str) or not prompt.strip():
            raise DriverFailure("invalid_prompt")
        self.select_cowork()
        self.action(lambda: self.desktop.open_prompt(prompt, self.remaining()))
        while True:
            self.remaining()
            starts = self.desktop.controls({"Start task"}, {"button"})
            if len(starts) > 1:
                raise DriverFailure("submission_control_ambiguous")
            if starts:
                # Exactly one submit attempt. No key fallback or action retry.
                self.action(lambda: self.desktop.activate(starts[0]))
                return self.receipt("submitted")
            time.sleep(min(0.1, self.remaining()))

    def hitl(self, approve_writes: bool) -> dict:
        names = {"Allow once", "Allow"}
        if approve_writes:
            names |= {"Always allow", "Allow always", "Full access", "Allow full access"}
        controls = self.desktop.controls(names, {"button"})
        if not controls:
            return self.receipt("hitl_checked")
        # Do not choose among unrelated prompts or continue arbitrary onboarding.
        once = [node for node in controls if node.get_name() == "Allow once"]
        selected = once if len(once) == 1 else controls
        if len(selected) != 1:
            raise DriverFailure("approval_control_ambiguous")
        if not approve_writes:
            # A generic UI Allow button gives no reliable read/write classification.
            raise DriverFailure("approval_requires_explicit_write_policy")
        self.action(lambda: self.desktop.activate(selected[0]))
        return self.receipt("hitl_checked")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["probe", "submit", "hitl"], required=True)
    parser.add_argument("--timeout-ms", type=int, required=True)
    parser.add_argument("--max-actions", type=int, default=24)
    args = parser.parse_args()
    driver = None
    try:
        if args.timeout_ms <= 0 or not 1 <= args.max_actions <= 64:
            raise DriverFailure("invalid_budget")
        payload = json.loads(sys.stdin.read(2 * 1024 * 1024))
        if not isinstance(payload, dict):
            raise DriverFailure("invalid_input")
        driver = Driver(Desktop(), args.timeout_ms, args.max_actions)
        if args.mode == "submit":
            result = driver.submit(payload.get("prompt"))
        elif args.mode == "hitl":
            result = driver.hitl(payload.get("approveWriteTools") is True)
        else:
            result = driver.probe()
        print(json.dumps(result))
        return 0
    except Exception as error:
        result = driver.receipt("failed") if driver else {"status": "failed", "action_count": 0, "duration_ms": 0}
        result["error"] = str(error) if isinstance(error, DriverFailure) else "desktop_driver_failed"
        print(json.dumps(result))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
