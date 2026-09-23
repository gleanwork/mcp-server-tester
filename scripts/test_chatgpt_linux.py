"""Offline AT-SPI state-machine contracts. No live desktop, credentials, or queries."""
import io
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from chatgpt_linux import Driver, DriverFailure, Desktop, composer, fresh_chat, main


def node(name, role='button', **values):
    return {'name': name, 'role': role, 'visible': True, 'enabled': True,
            'editable': False, 'selected': False, 'ancestors': (0,), **values}


def ready(surface='ChatGPT Work', text=''):
    return [node('Switch mode, current mode: ' + surface),
            node('Send', enabled=bool(text), ancestors=(0, 2)),
            node('New chat', ancestors=(0,)), node('New chat', ancestors=(0, 2)),
            node('composer', 'text', editable=True, text=text, ancestors=(0, 2))]


class FakeGLibContext:
    def __init__(self, events=(), busy=False):
        self.events = list(events)
        self.busy = busy
        self.iterations = 0

    def pending(self):
        return self.busy or bool(self.events)

    def iteration(self, may_block):
        if may_block:
            raise AssertionError('event pumping must not block')
        self.iterations += 1
        if self.events:
            self.events.pop(0)()
        return True


class FakeDesktop:
    def __init__(self, nodes=None):
        self.nodes = ready() if nodes is None else nodes
        self.actions = []
        self.stall = None
        self.uncertain_send = False

    def snapshot(self):
        return self.nodes

    def text(self, control):
        return control.get('text', '')

    def activate(self, control, allowed):
        name = control['name']
        self.actions.append((name, allowed))
        if name == self.stall:
            return
        if name == 'Engineering':
            control['selected'] = True
        elif name == 'Continue':
            self.nodes = [node('Skip'), node('Leave a note on my Desktop'),
                          node('Turn this spreadsheet into a chart')]
        elif name == 'Skip':
            self.nodes = [node('Go to ChatGPT'), node('Keep setting up')]
        elif name == 'Go to ChatGPT':
            self.nodes = ready('Codex')
        elif name.startswith('Switch mode'):
            self.nodes += [node('ChatGPT Work Create, learn, and explore', 'menu item'),
                           node('Codex Build, debug, and ship', 'menu item')]
        elif name.startswith('ChatGPT Work Create'):
            self.nodes = ready()
        elif name.startswith('Codex Build'):
            self.nodes = ready('Codex')
        elif name == 'New chat':
            surface = 'Codex' if self.nodes[0]['name'].endswith('Codex') else 'ChatGPT Work'
            self.nodes = ready(surface)
        elif name == 'Send' and self.uncertain_send:
            raise DriverFailure('action_acknowledgement_uncertain')

    def fill(self, control, prompt):
        self.actions.append(('fill', prompt))
        control['text'] = prompt
        self.nodes[1]['enabled'] = True


class DriverTest(unittest.TestCase):
    def driver(self, desktop):
        return Driver(desktop, 60_000, 24)

    def test_onboarding_and_explicit_surface_without_prompt(self):
        desktop = FakeDesktop([node('Engineering', 'radio button'), node('Continue')])
        result = self.driver(desktop).prepare('chatgpt-work')
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['surface'], 'chatgpt-work')
        self.assertEqual(set(result), {'status', 'surface', 'action_count', 'duration_ms'})
        self.assertEqual([a[0] for a in desktop.actions], [
            'Engineering', 'Continue', 'Skip', 'Go to ChatGPT',
            'Switch mode, current mode: Codex', 'ChatGPT Work Create, learn, and explore'])

    @patch('chatgpt_linux.time.sleep')
    def test_waits_for_continue_after_engineering_selection(self, _sleep):
        class DelayedContinueDesktop(FakeDesktop):
            selected_snapshots = 0

            def snapshot(self):
                if self.nodes[0]['name'] == 'Engineering' and self.nodes[0]['selected']:
                    self.selected_snapshots += 1
                    if self.selected_snapshots == 4:
                        self.nodes[1]['enabled'] = True
                return self.nodes

        for selected in (False, True):
            with self.subTest(selected=selected):
                desktop = DelayedContinueDesktop([
                    node('Engineering', 'radio button', selected=selected),
                    node('Continue', enabled=False)])
                result = self.driver(desktop).prepare('chatgpt-work')
                self.assertEqual(result['status'], 'ready')
                self.assertEqual(sum(a[0] == 'Engineering' for a in desktop.actions),
                                 0 if selected else 1)
                self.assertEqual(sum(a[0] == 'Continue' for a in desktop.actions), 1)
                self.assertEqual(desktop.selected_snapshots, 4)

    @patch('chatgpt_linux.time.sleep')
    def test_disabled_continue_never_clicked_or_engineering_retried(self, _sleep):
        desktop = FakeDesktop([node('Engineering', 'radio button'),
                               node('Continue', enabled=False)])
        driver = self.driver(desktop)
        with self.assertRaisesRegex(DriverFailure, 'state_transition_unobserved'):
            driver.prepare('chatgpt-work')
        self.assertEqual(driver.receipt('failed')['phase'], 'continue-ready')
        self.assertEqual([a[0] for a in desktop.actions], ['Engineering'])
        self.assertEqual(_sleep.call_count, 100)

    def test_codex_explicit_selection(self):
        desktop = FakeDesktop()
        self.driver(desktop).prepare('codex')
        self.assertEqual(desktop.actions[-1][0], 'Codex Build, debug, and ship')
        self.assertTrue(desktop.nodes[0]['name'].endswith('Codex'))

    def test_no_action_when_surface_already_selected(self):
        desktop = FakeDesktop()
        self.driver(desktop).prepare('chatgpt-work')
        self.assertEqual(desktop.actions, [])

    @patch('chatgpt_linux.time.sleep')
    def test_stalled_continue_resnapshots_but_never_clicks_again(self, _sleep):
        desktop = FakeDesktop([node('Engineering', 'toggle button', selected=True), node('Continue')])
        desktop.stall = 'Continue'
        with self.assertRaisesRegex(DriverFailure, 'state_transition_unobserved'):
            self.driver(desktop).prepare('chatgpt-work')
        self.assertEqual([a[0] for a in desktop.actions], ['Continue'])
        self.assertEqual(_sleep.call_count, 100)

    def test_exact_prompt_fresh_chat_once_send_once(self):
        desktop = FakeDesktop(ready(text='prior draft'))
        prompt = '  Find snake_case — π\n\nDo not trim.  \n'
        result = self.driver(desktop).submit(prompt, 'chatgpt-work')
        self.assertEqual(result['status'], 'submitted')
        self.assertEqual(set(result), {'status', 'surface', 'action_count', 'duration_ms'})
        self.assertEqual([a[0] for a in desktop.actions], ['New chat', 'fill', 'Send'])
        self.assertEqual(desktop.actions[1][1], prompt)

    def test_surface_changed_blocks_before_fresh_chat_or_fill(self):
        desktop = FakeDesktop(ready('Codex'))
        with self.assertRaisesRegex(DriverFailure, 'surface_mismatch'):
            self.driver(desktop).submit('test', 'chatgpt-work')
        self.assertEqual(desktop.actions, [])

    def test_uncertain_send_has_no_fallback(self):
        desktop = FakeDesktop()
        desktop.uncertain_send = True
        with self.assertRaisesRegex(DriverFailure, 'acknowledgement_uncertain'):
            self.driver(desktop).submit('test', 'chatgpt-work')
        self.assertEqual([a[0] for a in desktop.actions], ['New chat', 'fill', 'Send'])

    def test_static_text_is_not_a_composer(self):
        with self.assertRaisesRegex(DriverFailure, 'composer_missing_or_ambiguous'):
            composer([node('generic static text', 'text')])

    def test_duplicate_editors_fail_closed(self):
        nodes = ready() + [node('other', 'text', editable=True)]
        with self.assertRaisesRegex(DriverFailure, 'composer_missing_or_ambiguous'):
            self.driver(FakeDesktop(nodes)).submit('test', 'chatgpt-work')

    def test_new_chat_uses_nearest_composer_container(self):
        nodes = ready()
        self.assertIs(fresh_chat(nodes, composer(nodes)), nodes[3])
        nodes[2]['ancestors'] = (0, 2)
        with self.assertRaisesRegex(DriverFailure, 'new_chat_missing_or_ambiguous'):
            fresh_chat(nodes, composer(nodes))

    def test_budget_stops_before_send(self):
        desktop = FakeDesktop()
        with self.assertRaisesRegex(DriverFailure, 'action_budget_exhausted'):
            Driver(desktop, 60_000, 2).submit('test', 'chatgpt-work')
        self.assertEqual([a[0] for a in desktop.actions], ['New chat', 'fill'])

    @patch('chatgpt_linux.time.sleep')
    def test_fill_mismatch_never_sends(self, _sleep):
        desktop = FakeDesktop()
        desktop.fill = lambda control, prompt: None
        with self.assertRaisesRegex(DriverFailure, 'state_transition_unobserved'):
            self.driver(desktop).submit('test', 'chatgpt-work')
        self.assertEqual([a[0] for a in desktop.actions], ['New chat'])

    def test_snapshot_requires_editable_state_and_interface_not_role_text(self):
        state_type = SimpleNamespace(SHOWING=1, VISIBLE=2, ENABLED=3, SENSITIVE=4,
                                     EDITABLE=5, CHECKED=6, SELECTED=7)
        class Node:
            def __init__(self, name, role, states, editable=None, children=()):
                self.name, self.role, self.states = name, role, states
                self.editable, self.children = editable, children
            def get_name(self): return self.name
            def get_role_name(self): return self.role
            def get_state_set(self): return SimpleNamespace(contains=lambda state: state in self.states)
            def get_editable_text_iface(self): return self.editable
            def get_child_count(self): return len(self.children)
            def get_child_at_index(self, index): return self.children[index]
        static = Node('static', 'text', {1, 2, 3, 4}, object())
        no_interface = Node('not editable', 'text', {1, 2, 3, 4, 5})
        editor = Node('composer', 'text', {1, 2, 3, 4, 5}, object())
        app = Node('ChatGPT', 'application', {1, 2, 3, 4}, children=[static, no_interface, editor])
        root = Node('desktop', 'desktop', set(), children=[app])
        desktop = object.__new__(Desktop)
        desktop.api = SimpleNamespace(StateType=state_type, get_desktop=lambda index: root)
        desktop.context = FakeGLibContext()
        nodes = desktop.snapshot()
        self.assertIs(composer(nodes)['node'], editor)
        self.assertFalse(next(n for n in nodes if n['name'] == 'static')['editable'])
        self.assertFalse(next(n for n in nodes if n['name'] == 'not editable')['editable'])

    @patch('chatgpt_linux.time.sleep')
    def test_initial_wait_allows_300_polls(self, sleep):
        desktop = FakeDesktop([])
        driver = self.driver(desktop)
        with self.assertRaisesRegex(DriverFailure, 'state_transition_unobserved'):
            driver.prepare('chatgpt-work')
        self.assertEqual(sleep.call_count, 300)
        self.assertEqual(driver.receipt('failed')['phase'], 'waiting-for-initial-ui')
        self.assertEqual(desktop.actions, [])

    @patch('chatgpt_linux.time.sleep')
    def test_cold_app_can_appear_after_100_polls(self, sleep):
        desktop = FakeDesktop([])
        def tick(_seconds):
            if sleep.call_count == 150:
                desktop.nodes = ready()
        sleep.side_effect = tick
        self.assertEqual(self.driver(desktop).prepare('chatgpt-work')['status'], 'ready')
        self.assertEqual(sleep.call_count, 150)
        self.assertEqual(desktop.actions, [])

    def test_initial_wait_still_obeys_overall_deadline(self):
        now = [0.0]
        def tick(seconds):
            now[0] += seconds
        with patch('chatgpt_linux.time.monotonic', side_effect=lambda: now[0]), \
                patch('chatgpt_linux.time.sleep', side_effect=tick) as sleep:
            driver = Driver(FakeDesktop([]), 250, 24)
            with self.assertRaisesRegex(DriverFailure, 'deadline_exceeded'):
                driver.prepare('chatgpt-work')
            self.assertEqual(sleep.call_count, 3)
            self.assertEqual(driver.actions, 0)

    def test_cold_app_wait_rejects_snapshot_after_30_seconds(self):
        now = [0.0]
        desktop = FakeDesktop()
        def slow_snapshot():
            now[0] = 30.0
            return ready()
        desktop.snapshot = slow_snapshot
        with patch('chatgpt_linux.time.monotonic', side_effect=lambda: now[0]):
            driver = self.driver(desktop)
            with self.assertRaisesRegex(DriverFailure, 'state_transition_unobserved'):
                driver.prepare('chatgpt-work')
        self.assertEqual(desktop.actions, [])

    @patch('chatgpt_linux.time.sleep')
    def test_failed_receipts_identify_only_fixed_phases(self, _sleep):
        cases = [
            ([node('Engineering', 'radio button'), node('Continue')], 'Engineering', 'profession-selected'),
            ([node('Engineering', 'radio button', selected=True), node('Continue')], 'Continue', 'intro-dismiss'),
            (ready('Codex'), 'Switch mode, current mode: Codex', 'surface'),
            (ready()[:-1], None, 'composer'),
        ]
        for nodes, stall, phase in cases:
            with self.subTest(phase=phase):
                desktop = FakeDesktop(nodes)
                desktop.stall = stall
                driver = self.driver(desktop)
                with self.assertRaises(DriverFailure):
                    driver.prepare('chatgpt-work')
                self.assertEqual(driver.receipt('failed')['phase'], phase)
                self.assertNotIn('phase', driver.receipt('ready', 'chatgpt-work'))

    def test_main_hides_raw_exception_with_safe_phase(self):
        desktop = FakeDesktop()
        def fail():
            raise RuntimeError('private UI text or query')
        desktop.snapshot = fail
        with patch('chatgpt_linux.Desktop', return_value=desktop), \
                patch('sys.argv', ['driver', '--mode', 'prepare', '--timeout-ms', '60000']), \
                patch('sys.stdin', io.StringIO('{"surface":"chatgpt-work"}')), \
                patch('sys.stdout', new_callable=io.StringIO) as output:
            self.assertEqual(main(), 1)
        receipt = json.loads(output.getvalue())
        self.assertEqual(receipt['error'], 'desktop_driver_failed')
        self.assertEqual(receipt['phase'], 'waiting-for-initial-ui')
        self.assertNotIn('private', output.getvalue())

    def test_desktop_uses_default_glib_context(self):
        context = FakeGLibContext()
        api = SimpleNamespace()
        glib = SimpleNamespace(MainContext=SimpleNamespace(default=lambda: context))
        with patch.dict('sys.modules', {
            'gi': SimpleNamespace(require_version=lambda *_: None),
            'gi.repository': SimpleNamespace(Atspi=api, GLib=glib),
        }):
            desktop = Desktop()
        self.assertIs(desktop.context, context)
        self.assertIs(desktop.api, api)

    def test_snapshot_pumps_cached_selected_and_enabled_updates(self):
        states = {1, 2}
        state_type = SimpleNamespace(SHOWING=1, VISIBLE=2, ENABLED=3, SENSITIVE=4,
                                     EDITABLE=5, CHECKED=6, SELECTED=7)
        cached = SimpleNamespace(
            get_name=lambda: 'ChatGPT', get_role_name=lambda: 'radio button',
            get_state_set=lambda: SimpleNamespace(contains=lambda state: state in states),
            get_child_count=lambda: 0)
        root = SimpleNamespace(get_child_count=lambda: 1, get_child_at_index=lambda _: cached)
        desktop = object.__new__(Desktop)
        desktop.api = SimpleNamespace(StateType=state_type, get_desktop=lambda _: root)
        desktop.context = FakeGLibContext()
        before = desktop.snapshot()[0]
        self.assertFalse(before['selected'])
        self.assertFalse(before['enabled'])
        desktop.context.events = [lambda: states.add(6), lambda: states.update({3, 4})]
        # Cache changes occur only in iteration(False), not in pending().
        self.assertTrue(desktop.context.pending())
        self.assertEqual(states, {1, 2})
        after = desktop.snapshot()[0]
        self.assertTrue(after['selected'])
        self.assertTrue(after['enabled'])
        self.assertEqual(desktop.context.iterations, 2)

    def test_busy_event_context_fails_closed_before_tree_read(self):
        desktop = object.__new__(Desktop)
        desktop.context = FakeGLibContext(busy=True)
        # No API is installed: reaching the tree would fail this test.
        with self.assertRaisesRegex(DriverFailure, 'accessibility_event_budget'):
            desktop.snapshot()
        self.assertEqual(desktop.context.iterations, 256)

    def test_event_context_can_quiesce_at_exact_budget(self):
        desktop = object.__new__(Desktop)
        desktop.context = FakeGLibContext([lambda: None] * 256)
        desktop.api = SimpleNamespace(get_desktop=lambda _: SimpleNamespace(get_child_count=lambda: 0))
        self.assertEqual(desktop.snapshot(), [])
        self.assertEqual(desktop.context.iterations, 256)

    def test_action_name_must_be_observed_and_unique(self):
        class Action:
            def get_n_actions(self): return 1
            def get_action_name(self, _index): return 'delete'
            def do_action(self, _index): raise AssertionError('must not act')
        class Node:
            def get_action_iface(self): return Action()
        desktop = object.__new__(Desktop)
        with self.assertRaisesRegex(DriverFailure, 'action_missing_or_ambiguous'):
            desktop.activate({'node': Node()}, {'click'})


if __name__ == '__main__':
    unittest.main()
