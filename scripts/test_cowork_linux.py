import importlib.util
from pathlib import Path
import os
import subprocess
import time
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("cowork_linux", Path(__file__).with_name("cowork_linux.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Node:
    def __init__(self, name, role="button"):
        self.name = name
        self.role = role

    def get_name(self):
        return self.name


class Desktop:
    def __init__(self):
        self.starts = [Node("Start task")]
        # The composer's mode switch.
        self.radios = [Node("Cowork", "radio button")]
        self.radio_selected = True
        # The sidebar's Cowork button: on screen in every view.
        self.tabs = [Node("Cowork")]
        self.approvals = []
        # The running task's Stop response, and how many checks it survives a click.
        self.stops = []
        self.stop_lingers = 0
        self.actions = []
        self.prompt = None
        self.fail = False
        # Below the window until revealed (a composer grown by a long prompt).
        self.hidden = set()
        # The composer keeps its draft when an empty new-task link opens.
        self.keeps_draft = False

    def controls(self, names, roles, *, require_enabled=True, require_showing=True):
        if "Stop response" in self.actions and self.stops:
            if self.stop_lingers <= 0:
                self.stops = []
            self.stop_lingers -= 1
        return [node for node in self.starts + self.radios + self.tabs + self.approvals + self.stops
                if node.name in names and node.role in roles
                # The empty composer disables Start task.
                and not (node.name == "Start task" and require_enabled and not self.prompt)
                and not (require_showing and node.name in self.hidden)]

    def reveal(self, node):
        self.actions.append(f"reveal {node.name}")
        self.hidden.discard(node.name)

    def selected(self, node):
        return self.radio_selected

    def label(self, node):
        return module.Desktop.label(node)

    def activate(self, node):
        self.actions.append(node.name)
        if self.fail:
            raise module.DriverFailure("action_acknowledgement_uncertain")

    def open_prompt(self, prompt, timeout):
        if not (self.keeps_draft and self.prompt and not prompt):
            self.prompt = prompt


class AtspiStates:
    def __init__(self, states):
        self.states = states

    def contains(self, state):
        return state in self.states


class AtspiNode:
    """An accessible node, as gi.repository.Atspi returns it."""

    def __init__(self, name, role="button", states=("VISIBLE", "SHOWING", "ENABLED", "SENSITIVE"),
                 children=(), scrolls=True):
        self.name, self.role, self.states = name, role, set(states)
        self.children = list(children)
        self.scrolls = scrolls
        self.scrolled = []

    def get_name(self):
        return self.name

    def get_role_name(self):
        return self.role

    def get_state_set(self):
        return AtspiStates(self.states)

    def get_child_count(self):
        return len(self.children)

    def get_child_at_index(self, index):
        return self.children[index]

    def scroll_to(self, kind):
        self.scrolled.append(kind)
        return self.scrolls


class FakeAtspi:
    class StateType:
        VISIBLE, SHOWING, ENABLED, SENSITIVE, CHECKED, SELECTED = (
            "VISIBLE", "SHOWING", "ENABLED", "SENSITIVE", "CHECKED", "SELECTED")

    class ScrollType:
        ANYWHERE = "ANYWHERE"

    def __init__(self, *app_children):
        self.root = AtspiNode("", "desktop frame", children=[AtspiNode("Claude", "application",
                                                                         children=app_children)])

    def get_desktop(self, index):
        return self.root


def real_desktop(api):
    """The driver's own Desktop on a fake Atspi API: its filters and actions, unreplaced."""
    desktop = object.__new__(module.Desktop)
    desktop.api = api
    return desktop


class AtspiDesktopTests(unittest.TestCase):
    def test_a_control_below_the_window_is_found_only_when_asked_for(self):
        # VISIBLE but not SHOWING: laid out, but scrolled out of the window.
        below = AtspiNode("Start task", states=("VISIBLE", "ENABLED", "SENSITIVE"))
        desktop = real_desktop(FakeAtspi(below))
        self.assertEqual(desktop.controls({"Start task"}, {"button"}), [])
        self.assertEqual(desktop.controls({"Start task"}, {"button"}, require_showing=False), [below])
        # An invisible one is never found.
        below.states.discard("VISIBLE")
        self.assertEqual(desktop.controls({"Start task"}, {"button"}, require_showing=False), [])

    def test_a_large_table_neither_hides_a_prompt_nor_exhausts_the_scan(self):
        # A presented spreadsheet: 3,000 cells, more than the 5,000-node budget
        # once each cell's text counts. The scan skips the table.
        cells = [AtspiNode("x", "table cell", children=[AtspiNode("x", "label")]) for _ in range(3000)]
        allow = AtspiNode("Allow once")
        desktop = real_desktop(FakeAtspi(AtspiNode("", "table", children=cells), allow))
        self.assertEqual(desktop.controls({"Allow once"}, {"button"}), [allow])

    def test_a_scan_past_its_deadline_gives_up_rather_than_be_killed(self):
        desktop = real_desktop(FakeAtspi(*[AtspiNode("x", "label") for _ in range(200)]))
        desktop.scan_deadline = time.monotonic() - 1
        with self.assertRaisesRegex(module.DriverFailure, "accessibility_scan_timeout"):
            desktop.controls({"Allow"}, {"button"})

    def test_hitl_whose_scan_cannot_finish_sees_no_prompt_this_pass(self):
        for code in ("accessibility_tree_budget", "accessibility_scan_timeout"):
            class Unscannable(Desktop):
                def controls(self, names, roles, *, require_enabled=True, require_showing=True):
                    raise module.DriverFailure(code)
            desktop = Unscannable()
            result = module.Driver(desktop, 1000, 4).hitl(True)
            self.assertEqual((result["status"], result["scan"], result["action_count"]),
                             ("hitl_checked", "incomplete", 0))
            self.assertEqual(desktop.actions, [])
        # Any other failure still ends the call.
        class Missing(Desktop):
            def controls(self, names, roles, *, require_enabled=True, require_showing=True):
                raise module.DriverFailure("desktop_missing_or_ambiguous")
        with self.assertRaisesRegex(module.DriverFailure, "desktop_missing"):
            module.Driver(Missing(), 1000, 4).hitl(True)

    def test_reveal_scrolls_anywhere_and_fails_when_it_cannot(self):
        node = AtspiNode("Start task")
        desktop = real_desktop(FakeAtspi(node))
        desktop.reveal(node)
        self.assertEqual(node.scrolled, ["ANYWHERE"])
        node.scrolls = False
        with self.assertRaisesRegex(module.DriverFailure, "reveal_failed"):
            desktop.reveal(node)


class LinuxDriverTests(unittest.TestCase):
    def test_url_opener_is_a_prepared_environment_boundary(self):
        prompt = "  Find 中文 & \"quoted\" text\nwith a new line  "
        desktop = object.__new__(module.Desktop)
        for env, expected in (({}, "xdg-open"), ({"MST_COWORK_URL_OPENER": "/prepared/open-url"}, "/prepared/open-url")):
            with self.subTest(env=env), patch.dict(os.environ, env, clear=True), patch.object(module.subprocess, "run") as run:
                desktop.open_prompt(prompt, 30)
                argv = run.call_args.args[0]
                self.assertEqual(argv[0], expected)
                self.assertEqual(len(argv), 2)
                self.assertEqual(parse_qs(urlsplit(argv[1]).query)["q"], [prompt])
                self.assertEqual(run.call_args.kwargs, {
                    "check": True, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "timeout": 15,
                })

    def test_invalid_url_opener_fails_before_launch(self):
        desktop = object.__new__(module.Desktop)
        for opener in ("", "relative-program", "program --flag"):
            with self.subTest(opener=opener), patch.dict(os.environ, {"MST_COWORK_URL_OPENER": opener}), patch.object(module.subprocess, "run") as run:
                with self.assertRaisesRegex(module.DriverFailure, "invalid_url_opener"):
                    desktop.open_prompt("query", 1)
                run.assert_not_called()

    def test_uncertain_url_opener_failure_is_not_retried(self):
        desktop = object.__new__(module.Desktop)
        for error in (subprocess.TimeoutExpired("opener", 1), subprocess.CalledProcessError(1, "opener")):
            with self.subTest(error=type(error)), patch.dict(os.environ, {}, clear=True), patch.object(module.subprocess, "run", side_effect=error) as run:
                with self.assertRaises(type(error)):
                    desktop.open_prompt("query", 1)
                run.assert_called_once()
                self.assertEqual(run.call_args.kwargs["timeout"], 1)

    def test_exact_unicode_multiline_prompt_and_one_submit(self):
        desktop = Desktop()
        driver = module.Driver(desktop, 1000, 4)
        prompt = "  Find 中文 & \"quoted\" text\nwith a new line  "
        receipt = driver.submit(prompt)
        self.assertEqual(desktop.prompt, prompt)
        self.assertEqual(desktop.actions, ["Start task"])
        self.assertEqual(receipt["status"], "submitted")
        self.assertEqual(receipt["action_count"], 2)

    def test_disabled_start_button_proves_mode_before_prefill(self):
        class EmptyComposer(Desktop):
            def controls(self, names, roles, *, require_enabled=True, require_showing=True):
                controls = super().controls(names, roles, require_enabled=require_enabled, require_showing=require_showing)
                return [node for node in controls if node.name != 'Start task' or not require_enabled or self.prompt is not None]

            def selected(self, node):
                return False
        desktop = EmptyComposer()
        result = module.Driver(desktop, 1000, 4).submit('unchanged')
        self.assertEqual(result['status'], 'submitted')
        self.assertEqual(desktop.prompt, 'unchanged')
        self.assertEqual(desktop.actions, ['Start task'])

    def test_disabled_submit_is_never_activated(self):
        class DisabledSubmit(Desktop):
            def controls(self, names, roles, *, require_enabled=True, require_showing=True):
                return [] if require_enabled else self.starts
        desktop = DisabledSubmit()
        with self.assertRaisesRegex(module.DriverFailure, 'deadline'):
            module.Driver(desktop, 5, 4).submit('unchanged')
        self.assertEqual(desktop.actions, [])
        self.assertEqual(desktop.prompt, 'unchanged')

    def test_probe_has_no_desktop_effects(self):
        desktop = Desktop()
        self.assertEqual(module.Driver(desktop, 1000, 4).probe()["status"], "ready")
        self.assertEqual(desktop.actions, [])
        self.assertIsNone(desktop.prompt)

    def test_reset_opens_one_empty_task_and_never_sends(self):
        desktop = Desktop()
        self.assertEqual(module.Driver(desktop, 1000, 4).reset()["status"], "ready")
        self.assertEqual(desktop.prompt, "")
        self.assertEqual(desktop.actions, [])
        # A surface that never returns fails at the deadline without more actions.
        desktop = Desktop()
        desktop.starts = desktop.radios = []
        with self.assertRaisesRegex(module.DriverFailure, "deadline_exceeded"):
            module.Driver(desktop, 200, 4).reset()
        self.assertEqual((desktop.prompt, desktop.actions), ("", []))

    def test_reset_stops_a_task_that_still_runs_before_leaving_it(self):
        desktop = Desktop()
        desktop.stops, desktop.stop_lingers = [Node("Stop response")], 3
        receipt = module.Driver(desktop, 1000, 4).reset()
        self.assertEqual((receipt["status"], receipt["stopped"], receipt["action_count"]),
                         ("ready", True, 2))
        # Stopped, then the empty link: never a send.
        self.assertEqual((desktop.actions, desktop.prompt), (["Stop response"], ""))
        # A finished task has nothing to stop.
        self.assertNotIn("stopped", module.Driver(Desktop(), 1000, 4).reset())

    def test_reset_fails_when_the_task_does_not_stop_and_never_guesses_a_stop(self):
        desktop = Desktop()
        desktop.stops, desktop.stop_lingers = [Node("Stop response")], 10_000
        with self.assertRaisesRegex(module.DriverFailure, "task_not_stopped"):
            module.Driver(desktop, 300, 4).reset()
        # The old task still running: the link isn't opened.
        self.assertIsNone(desktop.prompt)
        desktop = Desktop()
        desktop.stops = [Node("Stop response"), Node("Stop response")]
        with self.assertRaisesRegex(module.DriverFailure, "stop_control_ambiguous"):
            module.Driver(desktop, 1000, 4).reset()
        self.assertEqual(desktop.actions, [])

    def test_reset_never_takes_the_old_task_view_for_ready(self):
        # A failed case's view: no Start task, no mode switch, only the
        # sidebar's Cowork button, which the link leaves on screen.
        desktop = Desktop()
        desktop.starts = desktop.radios = []
        with self.assertRaisesRegex(module.DriverFailure, "deadline_exceeded"):
            module.Driver(desktop, 200, 4).reset()
        self.assertEqual(desktop.actions, [])
        # Cowork selected but its composer not up yet: not ready either.
        desktop = Desktop()
        desktop.starts = []
        with self.assertRaisesRegex(module.DriverFailure, "deadline_exceeded"):
            module.Driver(desktop, 200, 4).reset()
        # Outside Cowork mode (its radio unselected), the next submit selects it.
        desktop = Desktop()
        desktop.starts, desktop.radio_selected = [], False
        receipt = module.Driver(desktop, 1000, 4).reset()
        self.assertEqual((receipt["status"], receipt["action_count"]), ("ready", 1))
        self.assertEqual(desktop.actions, [])

    def test_a_start_task_below_the_window_proves_cowork_mode(self):
        # A long draft pushed Start task below the window, and no mode switch
        # is on screen: Cowork is already selected, so nothing is pressed (the
        # sidebar's Cowork button could navigate away).
        desktop = Desktop()
        desktop.prompt = "a long draft"
        desktop.hidden.add("Start task")
        desktop.radios = []
        module.Driver(desktop, 1000, 4).select_cowork()
        self.assertEqual(desktop.actions, [])

    def test_long_prompt_scrolls_start_task_into_view_once_then_submits(self):
        class LongPrompt(Desktop):
            def open_prompt(self, prompt, timeout):
                super().open_prompt(prompt, timeout)
                self.hidden.add("Start task")
        desktop = LongPrompt()
        receipt = module.Driver(desktop, 1000, 4).submit("is my email OK?\n\n" + "line\n" * 25)
        self.assertEqual(desktop.actions, ["reveal Start task", "Start task"])
        self.assertEqual((receipt["status"], receipt["action_count"]), ("submitted", 3))
        # One that stays below the window is revealed once, never pressed.
        class StaysHidden(LongPrompt):
            def reveal(self, node):
                self.actions.append(f"reveal {node.name}")
        desktop = StaysHidden()
        with self.assertRaisesRegex(module.DriverFailure, "deadline_exceeded"):
            module.Driver(desktop, 200, 4).submit("long")
        self.assertEqual(desktop.actions, ["reveal Start task"])

    def test_reset_fails_on_a_draft_the_empty_link_left(self):
        desktop = Desktop()
        desktop.prompt, desktop.keeps_draft = "is my email OK?", True
        desktop.hidden.add("Start task")
        with self.assertRaisesRegex(module.DriverFailure, "draft_not_cleared"):
            module.Driver(desktop, 200, 4).reset()
        # One link, then read-only: never reveals, types or sends.
        self.assertEqual(desktop.actions, [])
        # An empty composer below the window is ready.
        desktop = Desktop()
        desktop.prompt = "earlier"
        desktop.hidden.add("Start task")
        self.assertEqual(module.Driver(desktop, 1000, 4).reset()["status"], "ready")
        self.assertEqual(desktop.actions, [])

    def test_uncertain_submit_never_retries(self):
        desktop = Desktop()
        desktop.fail = True
        with self.assertRaisesRegex(module.DriverFailure, "uncertain"):
            module.Driver(desktop, 1000, 4).submit("unchanged")
        self.assertEqual(desktop.actions, ["Start task"])

    def test_ambiguous_submit_refuses_to_act(self):
        desktop = Desktop()
        desktop.starts.append(Node("Start task"))
        with self.assertRaisesRegex(module.DriverFailure, "ambiguous"):
            module.Driver(desktop, 1000, 4).submit("unchanged")
        self.assertEqual(desktop.actions, [])

    def test_hard_budget_prevents_submission(self):
        desktop = Desktop()
        with self.assertRaisesRegex(module.DriverFailure, "budget"):
            module.Driver(desktop, 1000, 1).submit("unchanged")
        self.assertEqual(desktop.actions, [])

    def test_empty_prompt_does_not_touch_desktop(self):
        desktop = Desktop()
        with self.assertRaisesRegex(module.DriverFailure, "invalid_prompt"):
            module.Driver(desktop, 1000, 4).submit(" \n")
        self.assertIsNone(desktop.prompt)
        self.assertEqual(desktop.actions, [])

    def test_hard_deadline_prevents_all_actions(self):
        desktop = Desktop()
        with patch.object(module.time, "monotonic", side_effect=[0, 2]):
            with self.assertRaisesRegex(module.DriverFailure, "deadline"):
                module.Driver(desktop, 1000, 4).submit("unchanged")
        self.assertIsNone(desktop.prompt)

    def test_hitl_never_submits_or_continues_onboarding(self):
        desktop = Desktop()
        desktop.approvals = [Node("Continue"), Node("Get started")]
        result = module.Driver(desktop, 1000, 4).hitl(True)
        self.assertEqual(result["action_count"], 0)
        self.assertEqual(desktop.actions, [])
        self.assertIsNone(desktop.prompt)

    def test_hitl_denies_a_folder_request_under_either_policy(self):
        for approve_writes in (False, True):
            desktop = Desktop()
            desktop.approvals = [Node("Deny"), Node("Choose folder")]
            result = module.Driver(desktop, 1000, 4).hitl(approve_writes)
            self.assertEqual((result["denied"], result["action_count"]), ("folder_request", 1))
            # Deny, never Choose folder.
            self.assertEqual(desktop.actions, ["Deny"])
        # A Deny without its folder card is another prompt's: not this one.
        desktop = Desktop()
        desktop.approvals = [Node("Deny")]
        self.assertNotIn("denied", module.Driver(desktop, 1000, 4).hitl(True))
        self.assertEqual(desktop.actions, [])
        # Two cards, or two Deny buttons: which is the folder's is unknown.
        desktop = Desktop()
        desktop.approvals = [Node("Deny"), Node("Deny"), Node("Choose folder")]
        with self.assertRaisesRegex(module.DriverFailure, "folder_request_ambiguous"):
            module.Driver(desktop, 1000, 4).hitl(True)
        self.assertEqual(desktop.actions, [])

    def test_hitl_respects_explicit_approval_policy(self):
        desktop = Desktop()
        desktop.approvals = [Node("Allow once")]
        with self.assertRaisesRegex(module.DriverFailure, "write_policy"):
            module.Driver(desktop, 1000, 4).hitl(False)
        self.assertEqual(desktop.actions, [])
        self.assertEqual(module.Driver(desktop, 1000, 4).hitl(True)["status"], "hitl_checked")
        self.assertEqual(desktop.actions, ["Allow once"])

    def test_hitl_creates_a_confirmed_artifact_only_under_the_write_policy(self):
        desktop = Desktop()
        desktop.approvals = [Node("Cancel"), Node("Create")]
        with self.assertRaisesRegex(module.DriverFailure, "write_policy"):
            module.Driver(desktop, 1000, 4).hitl(False)
        self.assertEqual(desktop.actions, [])
        self.assertEqual(module.Driver(desktop, 1000, 4).hitl(True)["status"], "hitl_checked")
        self.assertEqual(desktop.actions, ["Create"])

    def test_hitl_approves_every_built_in_confirmation_card_under_the_write_policy(self):
        for action in ("Create", "Update", "Schedule", "Run", "Delete"):
            with self.subTest(action=action):
                desktop = Desktop()
                desktop.approvals = [Node("Cancel"), Node(action)]
                with self.assertRaisesRegex(module.DriverFailure, "write_policy"):
                    module.Driver(desktop, 1000, 4).hitl(False)
                self.assertEqual(desktop.actions, [])
                module.Driver(desktop, 1000, 4).hitl(True)
                self.assertEqual(desktop.actions, [action])

    def test_hitl_ambiguous_confirmation_card_fails_closed(self):
        desktop = Desktop()
        desktop.approvals = [Node("Cancel"), Node("Create"), Node("Run")]
        with self.assertRaisesRegex(module.DriverFailure, "ambiguous"):
            module.Driver(desktop, 1000, 4).hitl(True)
        self.assertEqual(desktop.actions, [])

    def test_hitl_ignores_a_create_button_without_its_confirmation_card(self):
        desktop = Desktop()
        desktop.approvals = [Node("Create")]
        self.assertEqual(module.Driver(desktop, 1000, 4).hitl(True)["action_count"], 0)
        self.assertEqual(desktop.actions, [])

    def test_hitl_ambiguous_approvals_fail_closed(self):
        desktop = Desktop()
        desktop.approvals = [Node("Allow"), Node("Allow")]
        with self.assertRaisesRegex(module.DriverFailure, "ambiguous"):
            module.Driver(desktop, 1000, 4).hitl(True)
        self.assertEqual(desktop.actions, [])

    def test_deep_link_is_encoded_without_shell(self):
        with patch.object(module.subprocess, "run") as run:
            desktop = object.__new__(module.Desktop)
            desktop.open_prompt("a\nb & \"c\"", 1)
        arguments = run.call_args.args[0]
        self.assertEqual(arguments[-1], "claude://claude.ai/new?q=a%0Ab%20%26%20%22c%22")
        self.assertNotIn("shell", run.call_args.kwargs)
        self.assertEqual(run.call_args.kwargs['timeout'], 1)
        with patch.object(module.subprocess, 'run') as run:
            desktop.open_prompt('unchanged', 900)
        self.assertEqual(run.call_args.kwargs['timeout'], 15)



def xwd(width, height, pixels, *, byte_order=0, bits=32):
    """A minimal TrueColor ZPixmap X window dump, as `xwd -root` writes it."""
    step = bits // 8
    bytes_per_line = width * step
    header = module.struct.pack(">25I", 100 + 4, 7, 2, 24, width, height, 0, byte_order, 32, 0, 32, bits,
                                bytes_per_line, 4, 0xFF0000, 0x00FF00, 0x0000FF, 8, 256, 0,
                                width, height, 0, 0, 0)
    order = "little" if byte_order == 0 else "big"
    body = b"".join(value.to_bytes(step, order) for value in pixels)
    return header + b"root" + body


def png_pixels(png):
    """The RGB rows of an 8-bit, colour-type-2, unfiltered PNG."""
    assert png.startswith(b"\x89PNG\r\n\x1a\n")
    position, data, width = 8, b"", None
    while position < len(png):
        length = module.struct.unpack(">I", png[position:position + 4])[0]
        kind = png[position + 4:position + 8]
        body = png[position + 8:position + 8 + length]
        if kind == b"IHDR":
            width = module.struct.unpack(">I", body[:4])[0]
        if kind == b"IDAT":
            data += body
        position += 12 + length
    raw = module.zlib.decompress(data)
    stride = 1 + width * 3
    return [list(raw[row + 1:row + stride]) for row in range(0, len(raw), stride)]


class LinuxDiagnoseTests(unittest.TestCase):
    def test_screen_dump_becomes_a_png_with_the_same_pixels(self):
        for byte_order in (0, 1):
            png = module.xwd_to_png(xwd(2, 2, [0xFF0000, 0x00FF00, 0x0000FF, 0x102030], byte_order=byte_order))
            self.assertEqual(png_pixels(png), [[255, 0, 0, 0, 255, 0], [0, 0, 255, 16, 32, 48]])

    def test_screen_dump_in_an_unsupported_format_is_refused(self):
        dump = bytearray(xwd(1, 1, [0]))
        dump[8:12] = (1).to_bytes(4, "big")  # XYPixmap
        with self.assertRaises(ValueError):
            module.xwd_to_png(bytes(dump))

    def test_diagnose_writes_the_screen_and_what_the_desktop_shows_and_never_acts(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            dump = subprocess.CompletedProcess([], 0, stdout=xwd(1, 1, [0xFFFFFF]))
            with patch.object(module.subprocess, "run", return_value=dump) as run, \
                    patch.object(module, "Desktop", side_effect=RuntimeError("no bus")):
                receipt = module.diagnose(directory, 10)
            self.assertEqual(run.call_args.args[0], ["xwd", "-root", "-silent"])
            self.assertEqual((receipt["status"], receipt["action_count"], receipt["files"]), ("diagnosed", 0, ["screen.png"]))
            self.assertEqual(png_pixels(open(os.path.join(directory, "screen.png"), "rb").read()), [[255, 255, 255]])
            # Without an accessibility bus it says why, without the error's text.
            self.assertEqual(open(os.path.join(directory, "accessibility.error")).read(), "RuntimeError\n")

    def test_diagnose_needs_an_existing_absolute_directory(self):
        for directory in (None, "relative", "/nonexistent/mst-diagnose"):
            with self.assertRaises(module.DriverFailure):
                module.diagnose(directory, 10)


if __name__ == "__main__":
    unittest.main()
