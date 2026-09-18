import importlib.util
from pathlib import Path
import os
import subprocess
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("cowork_linux", Path(__file__).with_name("cowork_linux.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Node:
    def __init__(self, name):
        self.name = name

    def get_name(self):
        return self.name


class Desktop:
    def __init__(self):
        self.starts = [Node("Start task")]
        self.radios = [Node("Cowork")]
        self.approvals = []
        self.actions = []
        self.prompt = None
        self.fail = False

    def controls(self, names, roles, *, require_enabled=True):
        return [node for node in self.starts + self.radios + self.approvals if node.name in names]

    def selected(self, node):
        return True

    def activate(self, node):
        self.actions.append(node.name)
        if self.fail:
            raise module.DriverFailure("action_acknowledgement_uncertain")

    def open_prompt(self, prompt, timeout):
        self.prompt = prompt


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
            def controls(self, names, roles, *, require_enabled=True):
                controls = super().controls(names, roles, require_enabled=require_enabled)
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
            def controls(self, names, roles, *, require_enabled=True):
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

    def test_hitl_respects_explicit_approval_policy(self):
        desktop = Desktop()
        desktop.approvals = [Node("Allow once")]
        with self.assertRaisesRegex(module.DriverFailure, "write_policy"):
            module.Driver(desktop, 1000, 4).hitl(False)
        self.assertEqual(desktop.actions, [])
        self.assertEqual(module.Driver(desktop, 1000, 4).hitl(True)["status"], "hitl_checked")
        self.assertEqual(desktop.actions, ["Allow once"])

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


if __name__ == "__main__":
    unittest.main()
