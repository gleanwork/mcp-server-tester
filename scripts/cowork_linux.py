#!/usr/bin/env python3
"""Bounded AT-SPI actions against an already prepared Linux Cowork desktop.

This module does not provision, authenticate, launch a desktop session, or collect
answers. The MST client binds and reads native sessions. JSON input arrives on stdin;
stdout contains only an allowlisted receipt, never prompt or accessibility text.

`--mode diagnose` takes no action: after a failed case it writes what the desktop
shows into the payload's `dir` (a trial artifact, as private as the session it
failed to produce): `screen.png` and `accessibility.txt`.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import struct
import time
import zlib
from urllib.parse import quote


class DriverFailure(RuntimeError):
    pass


# A scan that can't finish: the app's tree is too large to walk, or walking
# it would outlast the call. Nothing is known about the controls, so nothing
# was found or acted on.
SCAN_INCOMPLETE = {"accessibility_tree_budget", "accessibility_scan_timeout"}

# Controls never live inside a table: an answer's markdown table, or a
# presented spreadsheet's preview, whose cells can number in the thousands.
# The scan skips their subtrees.
SKIPPED_ROLES = {"table", "tree table"}


class Desktop:
    def __init__(self) -> None:
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
        self.api = Atspi
        # A scan gives up (accessibility_scan_timeout) past this monotonic
        # time, so the call still returns its receipt before it's killed.
        self.scan_deadline: float | None = None

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

    def controls(self, names: set[str], roles: set[str], *, require_enabled: bool = True,
                 require_showing: bool = True):
        pending = [self.application()]
        found = []
        seen = 0
        while pending:
            node = pending.pop()
            seen += 1
            if seen > 5000:
                raise DriverFailure("accessibility_tree_budget")
            deadline = getattr(self, "scan_deadline", None)
            if seen % 50 == 0 and deadline is not None and time.monotonic() > deadline:
                raise DriverFailure("accessibility_scan_timeout")
            try:
                states = node.get_state_set()
                role = node.get_role_name()
                if role in SKIPPED_ROLES:
                    continue
                if (role in roles and self.label(node) in names
                        and states.contains(self.api.StateType.VISIBLE)
                        and (not require_showing or states.contains(self.api.StateType.SHOWING))
                        and (not require_enabled or (
                            states.contains(self.api.StateType.ENABLED)
                            and states.contains(self.api.StateType.SENSITIVE)))):
                    found.append(node)
                pending.extend(node.get_child_at_index(i) for i in range(node.get_child_count()))
            except DriverFailure:
                raise
            except Exception:
                continue
        return found

    @staticmethod
    def label(node) -> str:
        # Newer desktops append a control's keyboard shortcut to its
        # accessible name ("Allow once 3", "Deny 1").
        return SHORTCUT_SUFFIX.sub("", node.get_name() or "")

    def reveal(self, node) -> None:
        """Scrolls a control into view. Never presses it."""
        if not node.scroll_to(self.api.ScrollType.ANYWHERE):
            raise DriverFailure("reveal_failed")

    def selected(self, node) -> bool:
        states = node.get_state_set()
        return states.contains(self.api.StateType.CHECKED) or states.contains(self.api.StateType.SELECTED)

    def activate(self, node) -> None:
        if not node.is_action() or not node.do_action(0):
            # Even a failed action acknowledgement may have had an effect.
            raise DriverFailure("action_acknowledgement_uncertain")

    def open_prompt(self, prompt: str, timeout: float) -> None:
        configured_opener = os.environ.get("MST_COWORK_URL_OPENER")
        if configured_opener is not None and not os.path.isabs(configured_opener):
            raise DriverFailure("invalid_url_opener")
        subprocess.run(
            [configured_opener or "xdg-open", "claude://claude.ai/new?q=" + quote(prompt, safe="")],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=min(timeout, 15),
        )


def accessibility_text(desktop, budget: int = 5000) -> str:
    """Every showing, named node of the app: role, name, and whether it is enabled."""
    lines = []
    pending = [(desktop.application(), 0)]
    while pending and len(lines) < budget:
        node, depth = pending.pop()
        try:
            states = node.get_state_set()
            name = (node.get_name() or "").replace("\n", " ")[:200]
            if name and states.contains(desktop.api.StateType.SHOWING):
                enabled = states.contains(desktop.api.StateType.ENABLED)
                lines.append(f"{'  ' * min(depth, 16)}{node.get_role_name()}: {name}{'' if enabled else ' [disabled]'}")
            pending.extend((node.get_child_at_index(i), depth + 1)
                           for i in reversed(range(node.get_child_count())))
        except Exception:
            continue
    return "\n".join(lines) + "\n"


def xwd_to_png(data: bytes) -> bytes:
    """A TrueColor X window dump (`xwd`, ZPixmap, 24/32 bits per pixel) as a PNG."""
    header = struct.unpack(">25I", data[:100])
    header_size, _, pixmap_format, _, width, height = header[:6]
    byte_order, bits_per_pixel, bytes_per_line = header[7], header[11], header[12]
    red_mask, green_mask, blue_mask, ncolors = header[14], header[15], header[16], header[19]
    if pixmap_format != 2 or bits_per_pixel not in (24, 32):
        raise ValueError("unsupported_xwd")
    pixels = data[header_size + ncolors * 12:]
    step = bits_per_pixel // 8
    order = "little" if byte_order == 0 else "big"
    shift = lambda mask: (mask & -mask).bit_length() - 1
    shifts = [(mask, shift(mask)) for mask in (red_mask, green_mask, blue_mask)]
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        line = pixels[y * bytes_per_line:y * bytes_per_line + width * step]
        for x in range(0, len(line), step):
            value = int.from_bytes(line[x:x + step], order)
            rows.extend(((value & mask) >> offset) & 0xFF for mask, offset in shifts)

    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(rows), 6)) + chunk(b"IEND", b""))


def diagnose(directory, timeout: float) -> dict:
    """Read-only: what the desktop shows, as files in `directory`. Never acts."""
    if not isinstance(directory, str) or not os.path.isabs(directory) or not os.path.isdir(directory):
        raise DriverFailure("invalid_directory")
    started = time.monotonic()
    written = []
    try:
        dump = subprocess.run(["xwd", "-root", "-silent"], check=True, capture_output=True,
                              timeout=max(1.0, min(timeout / 2, 15)))
        with open(os.path.join(directory, "screen.png"), "wb") as file:
            file.write(xwd_to_png(dump.stdout))
        written.append("screen.png")
    except Exception as error:
        with open(os.path.join(directory, "screen.error"), "w") as file:
            file.write(f"{type(error).__name__}\n")
    try:
        with open(os.path.join(directory, "accessibility.txt"), "w") as file:
            file.write(accessibility_text(Desktop()))
        written.append("accessibility.txt")
    except Exception as error:
        with open(os.path.join(directory, "accessibility.error"), "w") as file:
            file.write(f"{error if isinstance(error, DriverFailure) else type(error).__name__}\n")
    return {"status": "diagnosed", "action_count": 0,
            "duration_ms": (time.monotonic() - started) * 1000, "files": written}


SHORTCUT_SUFFIX = re.compile(r" [0-9]$")

# Primary actions of Cowork's built-in tool confirmation cards (always shown with Cancel).
CARD_ACTIONS = {"Create", "Update", "Schedule", "Run", "Delete"}


class Driver:
    def __init__(self, desktop, timeout_ms: int, max_actions: int) -> None:
        self.desktop = desktop
        self.started = time.monotonic()
        self.deadline = self.started + timeout_ms / 1000
        self.max_actions = max_actions
        self.actions = 0
        desktop.scan_deadline = self.deadline - min(0.5, timeout_ms / 10_000)

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

    def reset(self) -> dict:
        # After a failed case: leave its view with one empty new-task deep link,
        # then wait read-only for an empty Cowork start surface. Never types or
        # sends. An empty composer disables Start task; one still enabled holds
        # a draft the link didn't clear, which the next case's link would not
        # replace either (a long prompt's draft did, on Linux).
        self.action(lambda: self.desktop.open_prompt("", self.remaining()))
        draft = False
        while True:
            try:
                left = self.remaining()
            except DriverFailure:
                if draft:
                    raise DriverFailure("draft_not_cleared") from None
                raise
            starts = self.desktop.controls({"Start task"}, {"button"}, require_enabled=False,
                                           require_showing=False)
            if len(starts) == 1:
                if not self.desktop.controls({"Start task"}, {"button"}, require_showing=False):
                    return self.receipt("ready")
                draft = True
            elif not starts:
                # Not in Cowork mode only if the composer's mode switch says so:
                # one Cowork radio, unselected. The sidebar's Cowork button is
                # always on screen, the old task view included, and the link
                # returns before the app has navigated, so it proves nothing.
                radios = self.desktop.controls({"Cowork"}, {"radio button"}, require_enabled=False)
                if len(radios) == 1 and not self.desktop.selected(radios[0]):
                    # The next submit selects it.
                    return self.receipt("ready")
            time.sleep(min(0.1, left))

    def select_cowork(self) -> None:
        requested = set()
        while True:
            self.remaining()
            # The empty Cowork composer disables Start task until text is inserted.
            # Its presence proves the mode, not permission to submit; below the
            # window (a long draft) still counts.
            starts = self.desktop.controls({"Start task"}, {"button"}, require_enabled=False,
                                           require_showing=False)
            if len(starts) > 1:
                raise DriverFailure("submission_control_ambiguous")
            if starts:
                return
            radios = self.desktop.controls({"Cowork"}, {"radio button"})
            if len(radios) > 1:
                raise DriverFailure("cowork_control_ambiguous")
            if radios:
                if self.desktop.selected(radios[0]):
                    return
                if "radio" not in requested:
                    requested.add("radio")
                    self.action(lambda: self.desktop.activate(radios[0]))
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
        revealed = False
        while True:
            self.remaining()
            starts = self.desktop.controls({"Start task"}, {"button"})
            if len(starts) > 1:
                raise DriverFailure("submission_control_ambiguous")
            if starts:
                # Exactly one submit attempt. No key fallback or action retry.
                self.action(lambda: self.desktop.activate(starts[0]))
                return self.receipt("submitted")
            # A long prompt grows the composer until Start task is below the
            # window: scroll the one there is into view, once.
            hidden = self.desktop.controls({"Start task"}, {"button"}, require_showing=False)
            if len(hidden) == 1 and not revealed:
                revealed = True
                self.action(lambda: self.desktop.reveal(hidden[0]))
                continue
            time.sleep(min(0.1, self.remaining()))

    def hitl(self, approve_writes: bool) -> dict:
        names = {"Allow once", "Allow"}
        if approve_writes:
            names |= {"Always allow", "Allow always", "Full access", "Allow full access"}
        try:
            controls = self.desktop.controls(names, {"button"})
            if not controls:
                # Cowork confirms built-in tools with an inline card whose primary
                # action names the write (artifacts: Create/Update; scheduled tasks:
                # Schedule/Update/Run/Delete) beside Cancel, not an Allow prompt.
                # 3p desktops offer no Skip all approvals mode, so approve the card
                # itself. Only the write policy may do this; read-only refuses below.
                if self.desktop.controls({"Cancel"}, {"button"}):
                    controls = self.desktop.controls(CARD_ACTIONS, {"button"})
        except DriverFailure as failure:
            # A scan that couldn't finish, before any action: no prompt seen
            # this pass. The caller scans again; it doesn't end HITL.
            if str(failure) not in SCAN_INCOMPLETE:
                raise
            return {**self.receipt("hitl_checked"), "scan": "incomplete"}
        if not controls:
            return self.receipt("hitl_checked")
        # Do not choose among unrelated prompts or continue arbitrary onboarding.
        once = [node for node in controls if self.desktop.label(node) == "Allow once"]
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
    parser.add_argument("--mode", choices=["probe", "reset", "submit", "hitl", "diagnose"], required=True)
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
        if args.mode == "diagnose":
            print(json.dumps(diagnose(payload.get("dir"), args.timeout_ms / 1000)))
            return 0
        driver = Driver(Desktop(), args.timeout_ms, args.max_actions)
        if args.mode == "submit":
            result = driver.submit(payload.get("prompt"))
        elif args.mode == "hitl":
            result = driver.hitl(payload.get("approveWriteTools") is True)
        elif args.mode == "reset":
            result = driver.reset()
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
