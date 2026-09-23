"""Offline AT-SPI state-machine contracts. No live desktop, credentials, or queries."""
import io
import json
import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from chatgpt_linux import (Driver, DriverFailure, Desktop, composer, fresh_chat, main,
                           error_code, ERROR_CODES, XCLIP, XDOTOOL)


def node(name, role='button', **values):
    return {'name': name, 'role': role, 'showing': True, 'visible': True,
            'enabled': True, 'sensitive': True, 'editableState': False,
            'editableInterface': False, 'textInterface': False,
            'editable': False, 'selected': False, 'ancestors': (0,), **values}


def ready(surface='ChatGPT Work', text=''):
    return [node('Switch mode, current mode: ' + surface),
            node('Send', enabled=bool(text), ancestors=(0, 2)),
            node('New chat', ancestors=(0,)), node('New chat', ancestors=(0, 2)),
            node('composer', 'text', editable=True, editableState=True,
                 editableInterface=True, text=text, ancestors=(0, 2))]


class FakeGLibError(Exception):
    pass


class PublicNode:
    """Public Accessible interface; bound text methods deliberately collide."""
    def __init__(self, name, role='button', editable=False, setter=False, children=()):
        self.name, self.role, self.children = name, role, list(children)
        self.states = {'SHOWING', 'VISIBLE', 'ENABLED', 'SENSITIVE'}
        self.interfaces = []
        self.value = ''
        if editable:
            self.states.add('EDITABLE')
            self.interfaces.append('Text')
        if setter:
            self.interfaces.append('EditableText')

    def get_name(self): return self.name
    def get_role_name(self): return self.role
    def get_state_set(self): return SimpleNamespace(contains=lambda state: state in self.states)
    def get_child_count(self): return len(self.children)
    def get_child_at_index(self, index): return self.children[index]
    def get_interfaces(self): return self.interfaces
    def get_text_iface(self): return self if 'Text' in self.interfaces else None
    def get_editable_text_iface(self): return self if 'EditableText' in self.interfaces else None
    def get_text(self, *_): raise TypeError('private bound collision')
    def set_text_contents(self, *_): raise TypeError('private setter collision')
    def grab_focus(self): raise TypeError('private focus collision')


def public_desktop(setter=False):
    editor = PublicNode('private composer', 'text', editable=True, setter=setter)
    app = PublicNode('ChatGPT', 'application', children=[
        PublicNode('Switch mode, current mode: ChatGPT Work'),
        PublicNode('New chat'), PublicNode('Send'), editor])
    root = PublicNode('desktop', 'desktop', children=[app])
    desktop = object.__new__(Desktop)
    desktop.deadline = float('inf')
    desktop.clipboard = None
    desktop.glib_error = FakeGLibError
    desktop.context = FakeGLibContext()
    calls = []
    def set_text(node, prompt):
        calls.append(('setter', prompt))
        node.value = prompt
        return True
    def focus(node):
        calls.append(('focus',))
        node.states.add('FOCUSED')
        return True
    def activate(control, allowed):
        calls.append((control['name'],))
        if control['name'] == 'New chat':
            editor.value = ''
    desktop.activate = activate
    desktop.require_helpers = lambda: None
    desktop.api = SimpleNamespace(
        get_desktop=lambda _: root,
        StateType=SimpleNamespace(**{key: key for key in (
            'SHOWING', 'VISIBLE', 'ENABLED', 'SENSITIVE', 'EDITABLE', 'CHECKED', 'SELECTED', 'FOCUSED')}),
        Text=SimpleNamespace(get_text=lambda node, start, end: node.value),
        EditableText=SimpleNamespace(set_text_contents=set_text),
        Component=SimpleNamespace(grab_focus=focus))
    return desktop, editor, app, calls


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
        self.releases = 0

    def require_helpers(self): pass

    def release_clipboard(self):
        self.releases += 1

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

    def test_nested_editable_paragraph_is_part_of_one_composer(self):
        nodes = ready()
        nodes.append(node('nested paragraph', 'paragraph', editable=True,
                          ancestors=(0, 2, 4)))
        self.assertIs(composer(nodes), nodes[4])
        result = self.driver(FakeDesktop(nodes)).prepare('chatgpt-work')
        self.assertEqual(result['status'], 'ready')

    def test_independent_editable_field_remains_ambiguous(self):
        nodes = ready()
        nodes.append(node('separate field', 'entry', editable=True, ancestors=(0,)))
        with self.assertRaisesRegex(DriverFailure, 'composer_missing_or_ambiguous'):
            composer(nodes)

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

    def test_snapshot_requires_editable_state_and_text_not_editable_text(self):
        state_type = SimpleNamespace(SHOWING=1, VISIBLE=2, ENABLED=3, SENSITIVE=4,
                                     EDITABLE=5, CHECKED=6, SELECTED=7)
        class Node:
            def __init__(self, name, role, states, editable=None, children=()):
                self.name, self.role, self.states = name, role, states
                self.editable, self.children = editable, children
                self.interface_reads = 0
            def get_name(self): return self.name
            def get_role_name(self): return self.role
            def get_state_set(self): return SimpleNamespace(contains=lambda state: state in self.states)
            def get_interfaces(self):
                self.interface_reads += 1
                return ['Text', 'EditableText'] if self.editable else []
            def get_text_iface(self): return self
            def get_editable_text_iface(self): return self.editable
            def get_child_count(self): return len(self.children)
            def get_child_at_index(self, index): return self.children[index]
        static = Node('static', 'text', {1, 2, 3, 4}, object())
        no_interface = Node('not editable', 'text', {1, 2, 3, 4, 5})
        editor = Node('composer', 'text', {1, 2, 3, 4, 5}, object())
        unexpected = Node('private document', 'document web', {1, 2, 3, 4, 5}, object())
        hidden = Node('private hidden', 'entry', {2, 3, 4, 5}, object())
        insensitive = Node('private disabled', 'entry', {1, 2, 3, 5}, object())
        children = [static, no_interface, editor, unexpected, hidden, insensitive]
        app = Node('ChatGPT', 'application', {1, 2, 3, 4}, children=children)
        root = Node('desktop', 'desktop', set(), children=[app])
        desktop = object.__new__(Desktop)
        desktop.api = SimpleNamespace(StateType=state_type, get_desktop=lambda index: root)
        desktop.context = FakeGLibContext()
        nodes = desktop.snapshot()
        self.assertIs(composer(nodes)['node'], editor)
        self.assertFalse(next(n for n in nodes if n['name'] == 'static')['editable'])
        self.assertFalse(next(n for n in nodes if n['name'] == 'not editable')['editable'])
        for item in [app, static, unexpected]:
            self.assertEqual(item.interface_reads, 0)
        for item in [no_interface, editor, hidden, insensitive]:
            self.assertEqual(item.interface_reads, 1)
        by_role = next(n for n in nodes if n['role'] == 'document web')
        self.assertTrue(by_role['editableState'])
        self.assertFalse(by_role['editableInterface'])
        self.assertFalse(by_role['editable'])
        hidden_node = next(n for n in nodes if n['node'] is hidden)
        self.assertFalse(hidden_node['showing'])
        self.assertTrue(hidden_node['visible'])
        insensitive_node = next(n for n in nodes if n['node'] is insensitive)
        self.assertTrue(insensitive_node['enabled'])
        self.assertFalse(insensitive_node['sensitive'])
        self.assertFalse(self.driver(FakeDesktop()).ready(
            ready()[:-1] + [by_role, hidden_node, insensitive_node], 'chatgpt-work'))

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

    @patch('chatgpt_linux.time.sleep')
    def test_composer_failure_candidates_are_bounded_structural_only(self, _sleep):
        candidates = [
            node('private name', 'document web', editableState=True,
                 text='private prompt', url='https://private.example', config='private key'),
            node('private interface', 'section', editableInterface=True),
            node('private hidden', 'entry', showing=False, visible=True,
                 enabled=True, sensitive=False),
            node('private static', 'text'),
        ] + [node('private overflow', 'text area') for _ in range(20)]
        desktop = FakeDesktop(ready()[:-1] + [node('not a candidate', 'section')] + candidates)
        driver = self.driver(desktop)
        with self.assertRaisesRegex(DriverFailure, 'state_transition_unobserved'):
            driver.prepare('chatgpt-work')
        receipt = driver.receipt('failed')
        records = receipt['composerCandidates']
        self.assertEqual(len(records), 16)
        keys = {'role', 'showing', 'visible', 'enabled', 'sensitive',
                'editableState', 'editableInterface', 'textInterface'}
        for actual, expected in zip(records, candidates):
            self.assertEqual(set(actual), keys)
            self.assertEqual(actual, {key: expected[key] for key in keys})
        self.assertNotIn('private', json.dumps(receipt))
        self.assertEqual(desktop.actions, [])
        for status in ('ready', 'submitted'):
            self.assertNotIn('composerCandidates', driver.receipt(status, 'chatgpt-work'))
        driver.phase = 'surface'
        self.assertNotIn('composerCandidates', driver.receipt('failed'))
        desktop.nodes = []
        driver.snapshot()
        driver.phase = 'composer'
        self.assertEqual(driver.receipt('failed')['composerCandidates'], [])

    def test_each_availability_flag_is_required_for_composer(self):
        for flag in ('showing', 'visible', 'enabled', 'sensitive'):
            with self.subTest(flag=flag):
                nodes = ready()
                nodes[-1][flag] = False
                with self.assertRaisesRegex(DriverFailure, 'composer_missing_or_ambiguous'):
                    composer(nodes)
                self.assertFalse(self.driver(FakeDesktop()).ready(nodes, 'chatgpt-work'))

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
        glib = SimpleNamespace(MainContext=SimpleNamespace(default=lambda: context), Error=FakeGLibError)
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
            get_editable_text_iface=lambda: None,
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


class ChromiumInputTest(unittest.TestCase):
    def test_unbound_setter_and_readback_preserve_unicode_and_terminal_lf(self):
        desktop, editor, _, calls = public_desktop(setter=True)
        prompt = '  π 😀\n\nprivate\n'
        result = Driver(desktop, 60000, 24).submit(prompt, 'chatgpt-work')
        self.assertEqual(result['status'], 'submitted')
        self.assertEqual(editor.value, prompt)
        self.assertEqual(calls, [('New chat',), ('setter', prompt), ('Send',)])

    def test_chromium_text_without_editable_text_uses_one_native_paste(self):
        desktop, editor, _, calls = public_desktop()
        prompt = 'π 😀\nsecond line\n'
        def own(value): calls.append(('clipboard', value))
        def helper(argv):
            self.assertEqual(argv, [XDOTOOL, 'key', 'ctrl+v'])
            calls.append(('paste',))
            editor.value = prompt
        desktop.own_clipboard = own
        desktop.helper = helper
        desktop.release_clipboard = lambda: calls.append(('release',))
        result = Driver(desktop, 60000, 24).submit(prompt, 'chatgpt-work')
        self.assertEqual(result['status'], 'submitted')
        self.assertEqual(calls, [('New chat',), ('clipboard', prompt), ('focus',),
                                 ('paste',), ('release',), ('Send',)])

    def test_no_text_interface_or_password_role_never_authorizes(self):
        for kind in ('no-text', 'password'):
            desktop, editor, _, _ = public_desktop()
            if kind == 'no-text':
                editor.interfaces = ['EditableText']
            else:
                editor.role = 'password text'
            with self.assertRaisesRegex(DriverFailure, 'composer_missing_or_ambiguous'):
                composer(desktop.snapshot())

    def test_focus_failure_or_unverified_focus_never_pastes_or_sends(self):
        for acknowledge in (False, True):
            desktop, _, _, calls = public_desktop()
            desktop.own_clipboard = lambda _: None
            desktop.api.Component.grab_focus = lambda _: acknowledge
            desktop.helper = Mock(side_effect=AssertionError('must not paste'))
            with self.assertRaisesRegex(DriverFailure, 'focus_failed'):
                Driver(desktop, 60000, 24).submit('private', 'chatgpt-work')
            self.assertEqual(calls, [('New chat',)])
            desktop.helper.assert_not_called()

    def test_popup_editor_after_focus_blocks_paste(self):
        desktop, editor, app, calls = public_desktop()
        desktop.own_clipboard = lambda _: None
        def focus(_):
            editor.states.add('FOCUSED')
            app.children.append(PublicNode('popup', 'entry', editable=True))
            return True
        desktop.api.Component.grab_focus = focus
        desktop.helper = Mock(side_effect=AssertionError('must not paste'))
        with self.assertRaisesRegex(DriverFailure, 'composer_missing_or_ambiguous'):
            Driver(desktop, 60000, 24).submit('private', 'chatgpt-work')
        self.assertEqual(calls, [('New chat',)])

    @patch('chatgpt_linux.time.sleep')
    def test_nonempty_new_chat_never_fills(self, _sleep):
        desktop = FakeDesktop(ready(text='draft'))
        desktop.stall = 'New chat'
        with self.assertRaisesRegex(DriverFailure, 'state_transition_unobserved'):
            Driver(desktop, 60000, 24).submit('private', 'chatgpt-work')
        self.assertEqual([a[0] for a in desktop.actions], ['New chat'])

    def test_nonempty_at_fill_and_after_focus_never_pastes(self):
        for after_focus in (False, True):
            desktop, editor, _, calls = public_desktop()
            control = composer(desktop.snapshot())
            desktop.own_clipboard = lambda _: None
            if after_focus:
                def focus(_):
                    editor.states.add('FOCUSED')
                    editor.value = 'draft'
                    return True
                desktop.api.Component.grab_focus = focus
            else:
                editor.value = 'draft'
            with self.assertRaisesRegex(DriverFailure, 'composer_not_empty'):
                desktop.fill(control, 'private')
            self.assertEqual(calls, [])

    @patch('chatgpt_linux.time.sleep')
    def test_trimmed_native_paste_never_sends_and_releases(self, _sleep):
        desktop, editor, _, calls = public_desktop()
        desktop.own_clipboard = lambda _: None
        desktop.helper = lambda _: setattr(editor, 'value', 'π')
        desktop.release_clipboard = lambda: calls.append(('release',))
        with self.assertRaisesRegex(DriverFailure, 'state_transition_unobserved'):
            Driver(desktop, 60000, 24).submit('π\n', 'chatgpt-work')
        self.assertEqual(calls, [('New chat',), ('focus',), ('release',)])

    def test_clipboard_utf8_only_stdin_foreground_owned_process(self):
        desktop, _, _, _ = public_desktop()
        prompt = '  π 😀\nprivate\n'
        process = Mock()
        process.stdin = Mock(closed=False)
        process.stdin.fileno.return_value = 23
        process.poll.return_value = None
        selector = Mock()
        selector.select.return_value = [(None, None)]
        desktop.helper = Mock(return_value=prompt.encode('utf-8'))
        with patch('chatgpt_linux.subprocess.Popen', return_value=process) as popen, \
                patch('chatgpt_linux.os.set_blocking') as blocking, \
                patch('chatgpt_linux.os.write', side_effect=lambda fd, data: len(data)) as write, \
                patch('chatgpt_linux.selectors.DefaultSelector') as selector_type:
            selector_type.return_value.__enter__.return_value = selector
            desktop.own_clipboard(prompt)
        popen.assert_called_once_with(
            [XCLIP, '-selection', 'clipboard', '-in', '-quiet'],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        blocking.assert_called_once_with(23, False)
        write.assert_called_once_with(23, prompt.encode('utf-8'))
        process.stdin.close.assert_called_once()
        desktop.helper.assert_called_once_with([XCLIP, '-selection', 'clipboard', '-out'],
                                               allow_unavailable=True)
        desktop.release_clipboard()
        process.terminate.assert_called_once()
        process.wait.assert_called_once_with(timeout=0.5)
        self.assertIsNone(desktop.clipboard)

    def test_clipboard_write_timeout_releases_owned_process_no_paste(self):
        desktop, _, _, _ = public_desktop()
        control = composer(desktop.snapshot())
        process = Mock()
        process.poll.return_value = None
        process.stdin.fileno.return_value = 23
        selector = Mock()
        selector.select.return_value = []
        with patch('chatgpt_linux.subprocess.Popen', return_value=process), \
                patch('chatgpt_linux.os.set_blocking'), \
                patch('chatgpt_linux.selectors.DefaultSelector') as selector_type:
            selector_type.return_value.__enter__.return_value = selector
            with self.assertRaisesRegex(DriverFailure, 'helper_timeout'):
                desktop.fill(control, 'private')
        process.terminate.assert_called_once()
        self.assertIsNone(desktop.clipboard)

    def test_helper_timeout_and_failure_are_static_no_retry(self):
        desktop, _, _, _ = public_desktop()
        for error, code in [(subprocess.TimeoutExpired('private', 2), 'helper_timeout'),
                            (subprocess.CalledProcessError(1, 'private'), 'helper_failed'),
                            (OSError('private'), 'helper_failed')]:
            with patch('chatgpt_linux.subprocess.run', side_effect=error) as run:
                with self.assertRaisesRegex(DriverFailure, code):
                    desktop.helper([XDOTOOL, 'key', 'ctrl+v'])
                self.assertEqual(run.call_count, 1)
                self.assertLessEqual(run.call_args.kwargs['timeout'], 2)
                self.assertEqual(run.call_args.kwargs['stderr'], subprocess.DEVNULL)

    def test_read_only_clipboard_probe_can_observe_no_selection_yet(self):
        desktop, _, _, _ = public_desktop()
        with patch('chatgpt_linux.subprocess.run',
                   side_effect=subprocess.CalledProcessError(1, 'private')) as run:
            self.assertIsNone(desktop.helper([XCLIP, '-selection', 'clipboard', '-out'],
                                            allow_unavailable=True))
            self.assertEqual(run.call_count, 1)

    def test_missing_helpers_block_before_any_actions(self):
        desktop, _, _, calls = public_desktop()
        desktop.require_helpers = lambda: Desktop.require_helpers(desktop)
        with patch('chatgpt_linux.os.path.isfile', return_value=False):
            for mode in ('prepare', 'submit'):
                with self.assertRaisesRegex(DriverFailure, '^helper_missing$'):
                    driver = Driver(desktop, 60000, 24)
                    if mode == 'prepare':
                        driver.prepare('chatgpt-work')
                    else:
                        driver.submit('private', 'chatgpt-work')
        self.assertEqual(calls, [])

    def test_transient_glib_snapshot_retries_fresh_tree_at_most_three_times(self):
        desktop, _, _, calls = public_desktop()
        real_snapshot = desktop._snapshot
        with patch.object(desktop, '_snapshot', side_effect=[FakeGLibError('private'), real_snapshot()]) as read:
            self.assertEqual(len(desktop.snapshot()), 5)
            self.assertEqual(read.call_count, 2)
        with patch.object(desktop, '_snapshot', side_effect=FakeGLibError('private')) as read:
            with self.assertRaises(FakeGLibError):
                desktop.snapshot()
            self.assertEqual(read.call_count, 3)
        self.assertEqual(calls, [])

    def test_glib_action_is_never_retried_or_switched_to_paste(self):
        desktop, _, _, calls = public_desktop(setter=True)
        desktop.api.EditableText.set_text_contents = Mock(side_effect=FakeGLibError('private'))
        with self.assertRaises(FakeGLibError):
            Driver(desktop, 60000, 24).submit('private', 'chatgpt-work')
        self.assertEqual(calls, [('New chat',)])
        desktop.api.EditableText.set_text_contents.assert_called_once()

    def test_exception_codes_are_static_including_untrusted_driver_failure(self):
        with patch('chatgpt_linux.GLIB_ERROR', FakeGLibError):
            for error, code in [(AttributeError('private'), 'desktop_attribute_error'),
                                (TypeError('private'), 'desktop_type_error'),
                                (FakeGLibError('private'), 'desktop_glib_error'),
                                (DriverFailure('private'), 'desktop_driver_failed'),
                                (RuntimeError('private'), 'desktop_driver_failed')]:
                self.assertEqual(error_code(error), code)
                self.assertIn(code, ERROR_CODES)


if __name__ == '__main__':
    unittest.main()
