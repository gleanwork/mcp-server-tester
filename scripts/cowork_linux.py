#!/usr/bin/env python3
"""Bounded third-party (managed/gateway) Linux Cowork driver.

The compatibility cowork-linux-runtime export intentionally stays third-party.
Account-backed Cowork uses its separate first-party entrypoint.
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


# An incomplete scan cannot establish that any control is safe to act on.
SCAN_INCOMPLETE = {"accessibility_tree_budget", "accessibility_scan_timeout"}
# Controls never live inside a table, whose cells can exhaust the scan budget.
SKIPPED_ROLES = {"table", "tree table"}
# Claude Desktop truncates longer new-task links; paste those prompts instead.
DEEP_LINK_PROMPT_CHARS = 14_336
PASTE_CHECK_CHARS = 200
PASTE_TIMEOUT_SECONDS = 30
CONTROL_MASK = 1 << 2
COMPOSER = "Write your prompt to Claude"
SHORTCUT_SUFFIX = re.compile(r" [0-9]$")
TEXT_ROLES = {"static", "text", "label", "paragraph", "heading"}
QUESTION_PAGE = re.compile(r"(\d+) of (\d+)", re.IGNORECASE)
OPTION_ROLES = {"radio button", "check box", "checkbox", "toggle button", "button"}
NOT_OPTION = re.compile(
    r"(?:Skip|Next|Back|Previous|Continue|Submit|Send|Cancel|Dismiss|Create|Allow|Accept|Connect|"
    r"Approve|Stop|Show|Copy|Edit|Retry|More options|Read aloud|Restart conversation|Add |"
    r"Press and hold|Progress|Working folder|Context|Start task|Deny)(?:\b|,)", re.IGNORECASE)
ADVANCE = re.compile(r"(?:Submit|Send|Next|Continue)(?: answers?)?", re.IGNORECASE)
CARD_ACTIONS = {"Create", "Update", "Schedule", "Run", "Delete"}


class Desktop:
    def __init__(self) -> None:
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
        self.api = Atspi
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

    def controls(self, names, roles: set[str], *, require_enabled: bool = True,
                 require_showing: bool = True, raw: bool = False):
        """Visible controls matching names and roles; raw also matches the whole name."""
        test = names if callable(names) else names.__contains__
        wanted = (lambda node: test(self.label(node)) or (raw and test(node.get_name() or "")))
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
                if (role in roles and wanted(node)
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
        return SHORTCUT_SUFFIX.sub("", node.get_name() or "")

    def reveal(self, node) -> None:
        """Scroll a control into view without pressing it."""
        if not node.scroll_to(self.api.ScrollType.ANYWHERE):
            raise DriverFailure("reveal_failed")

    def selected(self, node) -> bool:
        states = node.get_state_set()
        return states.contains(self.api.StateType.CHECKED) or states.contains(self.api.StateType.SELECTED)

    def texts(self, pattern: re.Pattern) -> list[str]:
        return [(node.get_name() or "").strip() for node in self.controls(
            lambda name: bool(pattern.fullmatch(name.strip())), TEXT_ROLES, require_enabled=False,
            raw=True)]

    def activate(self, node) -> None:
        if not node.is_action() or not node.do_action(0):
            # Even a failed acknowledgement may have had an effect.
            raise DriverFailure("action_acknowledgement_uncertain")

    def composer_text(self, entry) -> str:
        """The composer's text nodes in reading order, one per line."""
        def children(node):
            return [node.get_child_at_index(index) for index in range(node.get_child_count())]

        lines, pending = [], children(entry)[::-1]
        while pending:
            node = pending.pop()
            if node.get_role_name() in ("static", "text") and node.get_name():
                lines.append(node.get_name())
            pending.extend(children(node)[::-1])
        return "\n".join(lines)

    def paste_prompt(self, prompt: str, timeout: float) -> None:
        # Synthesized typing drops long strings. Paste once into an empty entry.
        entries = self.controls({COMPOSER}, {"entry"})
        if len(entries) != 1:
            raise DriverFailure("composer_missing_or_ambiguous")
        entry = entries[0]
        if self.composer_text(entry).strip():
            raise DriverFailure("composer_not_empty")
        try:
            clipboard = subprocess.Popen(
                ["xclip", "-selection", "clipboard", "-quiet"], stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            raise DriverFailure("clipboard_unavailable") from None
        try:
            clipboard.stdin.write(prompt.encode("utf-8"))
            clipboard.stdin.close()
            time.sleep(0.5)
            if clipboard.poll() is not None:
                raise DriverFailure("clipboard_unavailable")
            if not self.api.Component.grab_focus(entry):
                raise DriverFailure("composer_not_focused")
            self.api.generate_keyboard_event(CONTROL_MASK, None, self.api.KeySynthType.LOCKMODIFIERS)
            try:
                self.api.generate_keyboard_event(0x76, None, self.api.KeySynthType.SYM)
            finally:
                self.api.generate_keyboard_event(CONTROL_MASK, None, self.api.KeySynthType.UNLOCKMODIFIERS)
            # Rendering need not retain all whitespace or the beginning of a long
            # prompt. Native-session binding checks the complete unchanged prompt.
            tail = " ".join(prompt.split())[-PASTE_CHECK_CHARS:]
            deadline = time.monotonic() + timeout
            while not " ".join(self.composer_text(entry).split()).endswith(tail):
                if time.monotonic() > deadline:
                    raise DriverFailure("prompt_not_pasted")
                time.sleep(0.2)
        finally:
            clipboard.kill()

    def open_prompt(self, prompt: str, timeout: float) -> None:
        configured_opener = os.environ.get("MST_COWORK_URL_OPENER")
        if configured_opener is not None and not os.path.isabs(configured_opener):
            raise DriverFailure("invalid_url_opener")
        subprocess.run(
            [configured_opener or "xdg-open", "claude://claude.ai/new?q=" + quote(prompt, safe="")],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=min(timeout, 15),
        )


def accessibility_text(desktop, budget: int = 5000) -> str:
    """Every showing, named node: role, name, and whether it is enabled."""
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
    """Read-only desktop capture. Never acts on the app."""
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


def normalized(text: str) -> str:
    return " ".join(text.split())


def first_option_owner(labels: list[str], name: str) -> bool:
    """Match the first option's label/description unless a longer label claims it."""
    first = labels[0]
    starts = lambda label: name == label or name.startswith(label + " ")
    return starts(first) and not any(len(label) > len(first) and starts(label) for label in labels)


def question_page(texts: list[str], count: int) -> int | None:
    marks = {(int(m.group(1)), int(m.group(2))) for m in map(QUESTION_PAGE.fullmatch, texts) if m}
    if not marks:
        return 0 if count == 1 else None
    if len(marks) != 1:
        return None
    page, total = marks.pop()
    return page - 1 if total == count and 1 <= page <= total else None


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
        # A visible Start task proves the managed surface even while disabled.
        # A selected Cowork radio alone also exists on hosted first-party UI.
        starts = self.desktop.controls({"Start task"}, {"button"}, require_enabled=False)
        if len(starts) == 1:
            return self.receipt("ready")
        # Legacy desktops may start outside Cowork; submit selects that mode
        # and then requires Start task before inserting any prompt.
        radios = self.desktop.controls({"Cowork"}, {"radio button"})
        if not starts and len(radios) == 1 and not self.desktop.selected(radios[0]):
            return self.receipt("ready")
        if not starts and not radios:
            tabs = self.desktop.controls({"Cowork"}, {"button"})
            if len(tabs) == 1:
                return self.receipt("ready")
        raise DriverFailure("cowork_not_ready")

    def stop_running_task(self) -> bool:
        # Stop a failed case's task before leaving it. Never sends.
        stops = self.desktop.controls({"Stop response"}, {"button"})
        if not stops:
            return False
        if len(stops) != 1:
            raise DriverFailure("stop_control_ambiguous")
        self.action(lambda: self.desktop.activate(stops[0]))
        while self.desktop.controls({"Stop response"}, {"button"}):
            try:
                left = self.remaining()
            except DriverFailure:
                raise DriverFailure("task_not_stopped") from None
            time.sleep(min(0.1, left))
        return True

    def reset(self) -> dict:
        # Stop, then open one empty new-task link and wait read-only. An enabled
        # Start task still holds a draft the link failed to clear.
        stopped = self.stop_running_task()
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
                    return {**self.receipt("ready"), **({"stopped": True} if stopped else {})}
                draft = True
            elif not starts:
                # The sidebar button proves nothing. An unselected mode radio
                # permits the next submit to select Cowork, then verify Start task.
                radios = self.desktop.controls({"Cowork"}, {"radio button"}, require_enabled=False)
                if len(radios) == 1 and not self.desktop.selected(radios[0]):
                    return {**self.receipt("ready"), **({"stopped": True} if stopped else {})}
            time.sleep(min(0.1, left))

    def select_cowork(self) -> None:
        requested = set()
        while True:
            self.remaining()
            # Only the third-party Start task proves mode. A disabled or
            # offscreen one counts, but a hosted selected Cowork radio does not.
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
                if not self.desktop.selected(radios[0]) and "radio" not in requested:
                    requested.add("radio")
                    self.action(lambda: self.desktop.activate(radios[0]))
            else:
                tabs = self.desktop.controls({"Cowork"}, {"button"})
                if len(tabs) > 1:
                    raise DriverFailure("cowork_control_ambiguous")
                if tabs and "tab" not in requested:
                    requested.add("tab")
                    self.action(lambda: self.desktop.activate(tabs[0]))
                elif not tabs and "link" not in requested:
                    # Desktop's November 2026 UI has no Cowork control: its
                    # mode switch says Claude / Code, and the sidebar has no
                    # Cowork button. The previous case's task view (its
                    # composer has no Start task) leaves only the empty
                    # new-task link, as reset uses, to reach Cowork's composer.
                    requested.add("link")
                    self.action(lambda: self.desktop.open_prompt("", self.remaining()))
            time.sleep(min(0.1, self.remaining()))

    def wait_for_empty_composer(self) -> None:
        while True:
            left = self.remaining()
            starts = self.desktop.controls({"Start task"}, {"button"}, require_enabled=False,
                                           require_showing=False)
            if len(starts) == 1 and not self.desktop.controls({"Start task"}, {"button"},
                                                              require_showing=False):
                return
            time.sleep(min(0.1, left))

    def submit(self, prompt: str, target_model: str | None = None) -> dict:
        if not isinstance(prompt, str) or not prompt.strip():
            raise DriverFailure("invalid_prompt")
        # Managed model selection belongs to settings, never an account picker.
        if target_model is not None:
            raise DriverFailure("managed_model_requires_settings")
        self.select_cowork()
        if len(prompt) <= DEEP_LINK_PROMPT_CHARS:
            self.action(lambda: self.desktop.open_prompt(prompt, self.remaining()))
        else:
            self.action(lambda: self.desktop.open_prompt("", self.remaining()))
            self.wait_for_empty_composer()
            self.action(lambda: self.desktop.paste_prompt(
                prompt, min(self.remaining(), PASTE_TIMEOUT_SECONDS)))
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
            hidden = self.desktop.controls({"Start task"}, {"button"}, require_showing=False)
            if len(hidden) == 1 and not revealed:
                revealed = True
                self.action(lambda: self.desktop.reveal(hidden[0]))
                continue
            time.sleep(min(0.1, self.remaining()))

    def answer(self, questions) -> dict:
        """Take one unambiguous first-option or advance action on a question form."""
        if (not isinstance(questions, list) or not questions or not all(
                isinstance(q, dict) and isinstance(q.get("labels"), list) and q["labels"]
                and all(isinstance(label, str) and label.strip() for label in q["labels"])
                for q in questions)):
            raise DriverFailure("invalid_questions")
        try:
            page = question_page(self.desktop.texts(QUESTION_PAGE), len(questions))
            if page is None:
                return {**self.receipt("hitl_checked"), "question": "not_found"}
            labels = [normalized(label) for label in questions[page]["labels"]]
            exact = self.desktop.controls(
                lambda name: normalized(name) == labels[0], OPTION_ROLES, raw=True)
            options = exact or self.desktop.controls(
                lambda name: first_option_owner(labels, normalized(name)) and not NOT_OPTION.match(name),
                OPTION_ROLES, raw=True)
            if len(options) != 1:
                return {**self.receipt("hitl_checked"), "question": "not_found"}
            target, answered = options[0], "option"
            if self.desktop.selected(target):
                advance = self.desktop.controls(lambda name: bool(ADVANCE.fullmatch(name.strip())), {"button"})
                if len(advance) != 1:
                    return {**self.receipt("hitl_checked"), "question": "not_found"}
                target, answered = advance[0], "advance"
        except DriverFailure as failure:
            if str(failure) not in SCAN_INCOMPLETE:
                raise
            return {**self.receipt("hitl_checked"), "scan": "incomplete"}
        self.action(lambda: self.desktop.activate(target))
        return {**self.receipt("hitl_checked"), "answered": answered}

    def hitl(self, approve_writes: bool) -> dict:
        names = {"Allow once", "Allow"}
        if approve_writes:
            names |= {"Always allow", "Allow always", "Full access", "Allow full access"}
        try:
            # A headless run has no user folder to grant. Denial grants nothing.
            folder = self.desktop.controls({"Choose folder"}, {"button"})
            if folder:
                denies = self.desktop.controls({"Deny"}, {"button"})
                if len(folder) != 1 or len(denies) != 1:
                    raise DriverFailure("folder_request_ambiguous")
                self.action(lambda: self.desktop.activate(denies[0]))
                return {**self.receipt("hitl_checked"), "denied": "folder_request"}
            controls = self.desktop.controls(names, {"button"})
            if not controls:
                # Managed Cowork's built-in writes use named cards beside Cancel.
                if self.desktop.controls({"Cancel"}, {"button"}):
                    controls = self.desktop.controls(CARD_ACTIONS, {"button"})
        except DriverFailure as failure:
            if str(failure) not in SCAN_INCOMPLETE:
                raise
            return {**self.receipt("hitl_checked"), "scan": "incomplete"}
        if not controls:
            return self.receipt("hitl_checked")
        once = [node for node in controls if self.desktop.label(node) == "Allow once"]
        selected = once if len(once) == 1 else controls
        if len(selected) != 1:
            raise DriverFailure("approval_control_ambiguous")
        if not approve_writes:
            raise DriverFailure("approval_requires_explicit_write_policy")
        self.action(lambda: self.desktop.activate(selected[0]))
        return self.receipt("hitl_checked")


def main() -> int:
    """JSON stdin and allowlisted receipts for the managed third-party runtime."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["probe", "reset", "submit", "hitl", "answer", "diagnose"],
                        required=True)
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
        # Reject account-backed requests before constructing Desktop or taking
        # a diagnostic screenshot. Metadata is a guard, never a mode selector.
        if payload.get("firstParty") is True or any(os.environ.get(key) for key in (
                "MST_COWORK_ACCOUNT_OWNER", "MST_COWORK_ACCOUNT_MARKER", "MST_COWORK_ACCOUNT_PROFILE")):
            raise DriverFailure("wrong_driver_mode")
        if args.mode == "diagnose":
            print(json.dumps(diagnose(payload.get("dir"), args.timeout_ms / 1000)))
            return 0
        driver = Driver(Desktop(), args.timeout_ms, args.max_actions)
        if args.mode == "submit":
            result = driver.submit(payload.get("prompt"), payload.get("targetModel"))
        elif args.mode == "hitl":
            result = driver.hitl(payload.get("approveWriteTools") is True)
        elif args.mode == "answer":
            result = driver.answer(payload.get("questions"))
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
