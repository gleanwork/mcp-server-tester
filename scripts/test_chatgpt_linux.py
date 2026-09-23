"""Offline native draft/AT-SPI contracts. No live app, credentials, or queries."""
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from chatgpt_linux import (Driver, DriverFailure, Desktop, composer, main,
                           error_code, ERROR_CODES, INPUT_LIMIT, XDOTOOL)


def node(name, role='button', **values):
    return {'name': name, 'role': role, 'showing': True, 'visible': True,
            'enabled': True, 'sensitive': True, 'editableState': False,
            'editableInterface': False, 'textInterface': False,
            'editable': False, 'selected': False, 'ancestors': (0,), **values}


def ready(surface='ChatGPT Work', text=''):
    return [node('Switch mode, current mode: ' + surface),
            node('Send', enabled=bool(text)),
            node('composer', 'text', editable=True, editableState=True,
                 textInterface=True, text=text)]


class FakeGLibError(Exception):
    pass


class FakeGLibContext:
    def __init__(self, events=(), busy=False):
        self.events, self.busy, self.iterations = list(events), busy, 0

    def pending(self): return self.busy or bool(self.events)

    def iteration(self, may_block):
        assert not may_block
        self.iterations += 1
        if self.events:
            self.events.pop(0)()


class PublicNode:
    """Public Accessible interface; bound text methods deliberately collide."""
    def __init__(self, name, role='button', editable=False, children=()):
        self.name, self.role, self.children = name, role, list(children)
        self.states = {'SHOWING', 'VISIBLE', 'ENABLED', 'SENSITIVE'}
        self.interfaces, self.value = [], ''
        if editable:
            self.states.add('EDITABLE')
            self.interfaces.append('Text')

    def get_name(self): return self.name
    def get_role_name(self): return self.role
    def get_state_set(self): return SimpleNamespace(contains=lambda state: state in self.states)
    def get_child_count(self): return len(self.children)
    def get_child_at_index(self, index): return self.children[index]
    def get_interfaces(self): return self.interfaces
    def get_text_iface(self): return self if 'Text' in self.interfaces else None
    def get_editable_text_iface(self): return self if 'EditableText' in self.interfaces else None
    def get_text(self, *_): raise TypeError('private bound collision')


def public_desktop():
    editor = PublicNode('private composer', 'text', editable=True)
    app = PublicNode('ChatGPT', 'application', children=[
        PublicNode('Switch mode, current mode: ChatGPT Work'), PublicNode('Send'), editor])
    root = PublicNode('desktop', 'desktop', children=[app])
    desktop = object.__new__(Desktop)
    desktop.deadline, desktop.glib_error = float('inf'), FakeGLibError
    desktop.context = FakeGLibContext()
    desktop.api = SimpleNamespace(
        get_desktop=lambda _: root,
        StateType=SimpleNamespace(**{key: key for key in (
            'SHOWING', 'VISIBLE', 'ENABLED', 'SENSITIVE', 'EDITABLE', 'CHECKED', 'SELECTED')}),
        Text=SimpleNamespace(get_text=lambda node, start, end: node.value,
                             get_character_count=lambda node: len(node.value)))
    return desktop, editor, app


class FakeDesktop:
    def __init__(self, nodes=None):
        self.nodes = ready() if nodes is None else nodes
        self.actions, self.stall = [], None
        self.open_surface = None
        self.preserve_draft = True
        self.uncertain_send = False
        self.stale_checked = False

    def require_helpers(self): pass
    def snapshot(self): return self.nodes
    def text(self, control, limit=None): return control.get('text', '')

    def surface(self):
        return 'Codex' if self.nodes[0]['name'].endswith('Codex') else 'ChatGPT Work'

    def open_prompt(self, prompt):
        self.actions.append(('open', prompt))
        if self.stall != 'open':
            self.nodes = ready(self.open_surface or self.surface(), prompt)

    def select_profession(self, nodes, choice):
        self.actions.append(('Engineering',))
        if not self.stale_checked:
            choice['selected'] = True

    def activate(self, control, allowed):
        name = control['name']
        self.actions.append((name, allowed))
        if name == self.stall:
            return
        if name == 'Continue':
            self.nodes = [node('Skip'), node('Leave a note on my Desktop'),
                          node('Turn this spreadsheet into a chart')]
        elif name == 'Skip':
            self.nodes = [node('Go to ChatGPT'), node('Keep setting up')]
        elif name == 'Go to ChatGPT':
            self.nodes = ready('Codex')
        elif name.startswith('Switch mode'):
            self.nodes += [node('ChatGPT Work Create, learn, and explore', 'menu item'),
                           node('Codex Build, debug, and ship', 'menu item')]
        elif name.startswith(('ChatGPT Work Create', 'Codex Build')):
            text = self.text(composer(self.nodes)) if self.preserve_draft else ''
            self.nodes = ready('Codex' if name.startswith('Codex') else 'ChatGPT Work', text)
        elif name == 'Send' and self.uncertain_send:
            raise DriverFailure('action_acknowledgement_uncertain')


class DriverTest(unittest.TestCase):
    def driver(self, desktop, actions=24): return Driver(desktop, 60_000, actions)
    def actions(self, desktop): return [action[0] for action in desktop.actions]

    def test_failure_draft_state_exact_measurements_and_privacy(self):
        for text in ('', '\ufffc', '\ufffc\ufffc\n\r\nπ😀', 'private prompt'):
            desktop = FakeDesktop(ready(text=text))
            desktop.nodes[2].update(name='private UI name', url='https://private.example',
                                    config='private config', prompt='private prompt')
            driver = self.driver(desktop)
            driver.phase, driver.step = 'composer', 'draft-surface'
            driver.snapshot()
            desktop.snapshot = Mock(side_effect=AssertionError('no fresh snapshot'))
            desktop.text = Mock(wraps=desktop.text)
            receipt = driver.receipt('failed')
            self.assertEqual(receipt['draftState'], {
                'observedSurface': 'chatgpt-work', 'composerRootCount': 1,
                'sendControlCount': 1, 'textReadable': True, 'textLength': len(text),
                'textSha256': hashlib.sha256(text.encode('utf-8')).hexdigest(),
                'embeddedObjectCount': text.count('\ufffc'), 'newlineCount': text.count('\n')})
            self.assertEqual(receipt['step'], 'draft-surface')
            self.assertNotIn('private', json.dumps(receipt))
            desktop.text.assert_called_once_with(desktop.nodes[2], limit=INPUT_LIMIT)
            self.assertEqual(desktop.actions, [])

    def test_failure_draft_state_deduplicates_entry_and_paragraph(self):
        desktop = FakeDesktop(ready())
        desktop.nodes[2].update(role='entry')
        desktop.nodes.append(node('private paragraph', 'paragraph', editable=True,
                                  ancestors=(0, 2), text='must not read'))
        driver = self.driver(desktop)
        driver.snapshot()
        desktop.text = Mock(wraps=desktop.text)
        self.assertEqual(driver.receipt('failed')['draftState']['composerRootCount'], 1)
        desktop.text.assert_called_once_with(desktop.nodes[2], limit=INPUT_LIMIT)

    def test_ambiguous_missing_hidden_disabled_editors_never_read(self):
        for editors in ([], [node('a', 'entry', editable=True), node('b', 'paragraph', editable=True)],
                        [node('a', 'entry', editable=True, visible=False)],
                        [node('a', 'entry', editable=True, showing=False)],
                        [node('a', 'entry', editable=True, enabled=False)],
                        [node('a', 'entry', editable=True, sensitive=False)]):
            desktop = FakeDesktop(ready()[:2] + editors)
            driver = self.driver(desktop)
            driver.snapshot()
            desktop.text = Mock(side_effect=AssertionError('must not read'))
            state = driver.receipt('failed')['draftState']
            self.assertFalse(state['textReadable'])
            self.assertEqual(set(state), {'observedSurface', 'composerRootCount',
                                         'sendControlCount', 'textReadable'})
            desktop.text.assert_not_called()

    def test_draft_state_uses_only_known_visible_surface_labels(self):
        for switches, expected in [([], 'unknown'),
                ([node('private surface')], 'unknown'),
                ([node('Switch mode, current mode: Codex')], 'codex'),
                ([node('Switch mode, current mode: ChatGPT Work')], 'chatgpt-work'),
                ([node('Switch mode, current mode: Codex', visible=False)], 'unknown'),
                ([node('Switch mode, current mode: Codex')] * 2, 'ambiguous'),
                ([node('Switch mode, current mode: Codex'),
                  node('Switch mode, current mode: ChatGPT Work')], 'ambiguous')]:
            desktop = FakeDesktop(switches)
            driver = self.driver(desktop)
            driver.snapshot()
            self.assertEqual(driver.receipt('failed')['draftState']['observedSurface'], expected)

    def test_draft_state_read_failures_and_oversized_text_omit_measurements(self):
        for text in (None, 1, 'a' * (INPUT_LIMIT + 1), '😀' * (INPUT_LIMIT // 4 + 1), '\ud800'):
            desktop = FakeDesktop(ready(text=text))
            driver = self.driver(desktop)
            driver.snapshot()
            state = driver.receipt('failed')['draftState']
            self.assertFalse(state['textReadable'])
            self.assertNotIn('textLength', state)
            self.assertNotIn('textSha256', state)
        desktop.text = Mock(side_effect=RuntimeError('private UI error'))
        self.assertNotIn('private', json.dumps(driver.receipt('failed')))
        self.assertFalse(driver.receipt('failed')['draftState']['textReadable'])

    def test_draft_diagnostics_use_bounded_unbound_text_read(self):
        desktop, editor, _app = public_desktop()
        editor.value = '\ufffc'
        driver = self.driver(desktop)
        driver.snapshot()
        desktop.api.Text.get_text = Mock(wraps=desktop.api.Text.get_text)
        state = driver.receipt('failed')['draftState']
        self.assertEqual(state['embeddedObjectCount'], 1)
        self.assertEqual(state['textLength'], 1)
        desktop.api.Text.get_text.assert_called_once_with(editor, 0, 1)
        desktop.api.Text.get_text.reset_mock()
        editor.value = 'a' * (INPUT_LIMIT + 1)
        self.assertFalse(driver.receipt('failed')['draftState']['textReadable'])
        desktop.api.Text.get_text.assert_not_called()

    def test_draft_diagnostics_success_and_no_snapshot_do_not_read(self):
        desktop = FakeDesktop()
        driver = self.driver(desktop)
        self.assertNotIn('draftState', driver.receipt('failed'))
        driver.snapshot()
        desktop.text = Mock(side_effect=AssertionError('no diagnostic read on success'))
        for status in ('ready', 'submitted'):
            self.assertNotIn('draftState', driver.receipt(status, 'chatgpt-work'))
        desktop.text.assert_not_called()

    @patch('chatgpt_linux.time.sleep')
    def test_stalled_draft_reports_last_surface_and_placeholder_without_normalizing(self, _sleep):
        desktop = FakeDesktop()
        def open_empty(prompt):
            desktop.actions.append(('open', prompt))
            desktop.nodes = ready('Codex', '\ufffc')
        desktop.open_prompt = open_empty
        driver = self.driver(desktop)
        with self.assertRaisesRegex(DriverFailure, 'state_transition_unobserved'):
            driver.prepare('chatgpt-work')
        receipt = driver.receipt('failed')
        self.assertEqual(receipt['step'], 'draft-surface')
        self.assertEqual(receipt['draftState']['observedSurface'], 'codex')
        self.assertEqual(receipt['draftState']['embeddedObjectCount'], 1)
        self.assertEqual(desktop.actions, [('open', '')])

    def test_setup_onboarding_surface_then_one_empty_open_no_send(self):
        desktop = FakeDesktop([node('Engineering', 'radio button'), node('Continue')])
        desktop.stale_checked = True
        result = self.driver(desktop).prepare('chatgpt-work')
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(set(result), {'status', 'surface', 'action_count', 'duration_ms'})
        self.assertEqual(self.actions(desktop), ['Engineering', 'Continue', 'Skip', 'Go to ChatGPT',
                         'Switch mode, current mode: Codex', 'ChatGPT Work Create, learn, and explore', 'open'])
        self.assertEqual(desktop.actions[-1], ('open', ''))
        self.assertEqual(result['action_count'], 7)

    def test_setup_already_selected_still_opens_empty_chat_once(self):
        for surface, label in [('chatgpt-work', 'ChatGPT Work'), ('codex', 'Codex')]:
            desktop = FakeDesktop(ready(label, 'prior draft'))
            result = self.driver(desktop).prepare(surface)
            self.assertEqual(result['action_count'], 1)
            self.assertEqual(desktop.actions, [('open', '')])

    @patch('chatgpt_linux.time.sleep')
    def test_continue_enablement_not_checked_bit_is_required(self, sleep):
        for selected in (False, True):
            desktop = FakeDesktop([node('Engineering', 'radio button', selected=selected),
                                   node('Continue', enabled=False)])
            desktop.stale_checked = True
            sleep.reset_mock()
            def settle(_):
                if sleep.call_count == 3:
                    desktop.nodes[1]['enabled'] = True
            sleep.side_effect = settle
            self.driver(desktop).prepare('chatgpt-work')
            self.assertEqual(self.actions(desktop).count('Engineering'), 0 if selected else 1)
            self.assertEqual(self.actions(desktop).count('Continue'), 1)
            self.assertEqual(sleep.call_count, 3)

    @patch('chatgpt_linux.time.sleep')
    def test_disabled_continue_never_clicked_or_selection_retried(self, sleep):
        desktop = FakeDesktop([node('Engineering', 'radio button'), node('Continue', enabled=False)])
        driver = self.driver(desktop)
        with self.assertRaisesRegex(DriverFailure, 'state_transition_unobserved'):
            driver.prepare('chatgpt-work')
        self.assertEqual(driver.receipt('failed')['phase'], 'continue-ready')
        self.assertEqual(self.actions(desktop), ['Engineering'])
        self.assertEqual(sleep.call_count, 100)

    @patch('chatgpt_linux.time.sleep')
    def test_unknown_onboarding_and_ambiguous_profession_do_not_act(self, _sleep):
        for nodes, error in [([node('Skip')], 'state_transition_unobserved'),
                             ([node('Engineering', 'radio button')] * 2, 'profession_ambiguous')]:
            desktop = FakeDesktop(nodes)
            with self.assertRaisesRegex(DriverFailure, error):
                self.driver(desktop).prepare('chatgpt-work')
            self.assertEqual(desktop.actions, [])

    def test_exact_unicode_whitespace_one_open_one_send(self):
        for surface, label in [('chatgpt-work', 'ChatGPT Work'), ('codex', 'Codex')]:
            desktop = FakeDesktop(ready(label, 'prior draft'))
            prompt = '  Find snake_case — π 😀\n\nDo not trim.  \n'
            result = self.driver(desktop).submit(prompt, surface)
            self.assertEqual(result['status'], 'submitted')
            self.assertEqual(result['action_count'], 2)
            self.assertEqual(set(result), {'status', 'surface', 'action_count', 'duration_ms'})
            self.assertEqual(desktop.actions[0], ('open', prompt))
            self.assertEqual(self.actions(desktop), ['open', 'Send'])

    def test_surface_mismatch_before_open_blocks(self):
        desktop = FakeDesktop(ready('Codex'))
        with self.assertRaisesRegex(DriverFailure, 'surface_mismatch'):
            self.driver(desktop).submit('private', 'chatgpt-work')
        self.assertEqual(desktop.actions, [])

    @patch('chatgpt_linux.time.sleep')
    def test_deep_link_mode_switch_once_requires_preserved_exact_draft(self, _sleep):
        for preserve in (True, False):
            for surface, start, opened in [('chatgpt-work', 'ChatGPT Work', 'Codex'),
                                            ('codex', 'Codex', 'ChatGPT Work')]:
                desktop = FakeDesktop(ready(start))
                desktop.open_surface, desktop.preserve_draft = opened, preserve
                driver = self.driver(desktop)
                prompt = '  π 😀\n\nDo not trim.  \n'
                if preserve:
                    self.assertEqual(driver.submit(prompt, surface)['action_count'], 4)
                else:
                    with self.assertRaisesRegex(DriverFailure, 'state_transition_unobserved'):
                        driver.submit(prompt, surface)
                self.assertEqual(desktop.actions[0], ('open', prompt))
                self.assertEqual(self.actions(desktop).count('open'), 1)
                self.assertEqual(sum(name.startswith('Switch mode') for name in self.actions(desktop)), 1)
                self.assertEqual(self.actions(desktop).count('Send'), 1 if preserve else 0)

    @patch('chatgpt_linux.time.sleep')
    def test_waits_for_draft_before_correcting_delayed_mode_change(self, sleep):
        desktop = FakeDesktop()
        desktop.stall = 'open'
        prompt = '  π 😀\nExact.  \n'
        def settle(_):
            self.assertEqual(desktop.actions, [('open', prompt)])
            desktop.nodes = ready('Codex', prompt)
        sleep.side_effect = settle
        result = self.driver(desktop).submit(prompt, 'chatgpt-work')
        self.assertEqual(result['action_count'], 4)
        self.assertEqual(self.actions(desktop), ['open', 'Switch mode, current mode: Codex',
                                                'ChatGPT Work Create, learn, and explore', 'Send'])
        sleep.assert_called_once()

    @patch('chatgpt_linux.time.sleep')
    def test_stalled_mode_correction_is_not_repeated(self, sleep):
        desktop = FakeDesktop()
        desktop.open_surface = 'Codex'
        desktop.stall = 'ChatGPT Work Create, learn, and explore'
        with self.assertRaisesRegex(DriverFailure, 'state_transition_unobserved'):
            self.driver(desktop).submit('private', 'chatgpt-work')
        self.assertEqual(self.actions(desktop), ['open', 'Switch mode, current mode: Codex',
                                                'ChatGPT Work Create, learn, and explore'])
        self.assertEqual(sleep.call_count, 100)

    def test_missing_helper_blocks_setup_and_submit_with_zero_actions(self):
        for mode in ('prepare', 'submit'):
            desktop = FakeDesktop()
            desktop.require_helpers = Mock(side_effect=DriverFailure('helper_missing'))
            driver = self.driver(desktop)
            with self.assertRaisesRegex(DriverFailure, 'helper_missing'):
                driver.prepare('chatgpt-work') if mode == 'prepare' else driver.submit('private', 'chatgpt-work')
            self.assertEqual(driver.actions, 0)
            self.assertEqual(desktop.actions, [])

    def test_setup_corrects_surface_once_without_reopening_empty_chat(self):
        desktop = FakeDesktop(ready(text='prior draft'))
        desktop.open_surface = 'Codex'
        self.assertEqual(self.driver(desktop).prepare('chatgpt-work')['status'], 'ready')
        self.assertEqual(self.actions(desktop), [
            'open', 'Switch mode, current mode: Codex', 'ChatGPT Work Create, learn, and explore'])

    @patch('chatgpt_linux.time.sleep')
    def test_setup_does_not_reopen_nonempty_composer(self, _sleep):
        desktop = FakeDesktop(ready(text='prior draft'))
        desktop.stall = 'open'
        with self.assertRaisesRegex(DriverFailure, 'state_transition_unobserved'):
            self.driver(desktop).prepare('chatgpt-work')
        self.assertEqual(desktop.actions, [('open', '')])

    @patch('chatgpt_linux.time.sleep')
    def test_exact_echo_and_unique_send_required_before_send_no_replay(self, sleep):
        for kind in ('wrong-text', 'composer', 'send', 'send-disabled'):
            for settles in (False, True):
                with self.subTest(kind=kind, settles=settles):
                    desktop = FakeDesktop()
                    original = desktop.open_prompt
                    prompt = '  π 😀\n\nExact.  \n'
                    def open_prompt(value):
                        original(value)
                        if kind == 'wrong-text':
                            composer(desktop.nodes)['text'] = value.strip()
                        elif kind == 'send-disabled':
                            desktop.nodes[1]['enabled'] = False
                        else:
                            desktop.nodes.append(node('extra', 'text', editable=True)
                                                 if kind == 'composer' else node('Send'))
                    desktop.open_prompt = open_prompt
                    sleep.reset_mock()
                    def settle(_):
                        self.assertNotIn('Send', self.actions(desktop))
                        desktop.nodes = ready(text=prompt)
                    sleep.side_effect = settle if settles else None
                    driver = self.driver(desktop)
                    if settles:
                        self.assertEqual(driver.submit(prompt, 'chatgpt-work')['status'], 'submitted')
                        self.assertEqual(self.actions(desktop), ['open', 'Send'])
                        sleep.assert_called_once()
                    else:
                        with self.assertRaises(DriverFailure):
                            driver.submit(prompt, 'chatgpt-work')
                        self.assertEqual(self.actions(desktop), ['open'])
                        self.assertEqual(sleep.call_count, 100)

    def test_uncertain_send_is_not_retried(self):
        desktop = FakeDesktop()
        desktop.uncertain_send = True
        with self.assertRaisesRegex(DriverFailure, 'acknowledgement_uncertain'):
            self.driver(desktop).submit('private', 'chatgpt-work')
        self.assertEqual(self.actions(desktop), ['open', 'Send'])

    def test_helper_failure_does_not_send_or_reopen(self):
        for mode in ('prepare', 'submit'):
            for code in ('helper_failed', 'helper_timeout'):
                desktop = FakeDesktop()
                desktop.open_prompt = Mock(side_effect=DriverFailure(code))
                driver = self.driver(desktop)
                with self.assertRaisesRegex(DriverFailure, code):
                    driver.prepare('chatgpt-work') if mode == 'prepare' else driver.submit('private', 'chatgpt-work')
                desktop.open_prompt.assert_called_once_with('' if mode == 'prepare' else 'private')
                self.assertEqual(driver.actions, 1)
                self.assertEqual(desktop.actions, [])
                self.assertEqual(driver.receipt('failed')['step'], 'draft-open')

    def test_action_budget_blocks_before_send(self):
        desktop = FakeDesktop()
        with self.assertRaisesRegex(DriverFailure, 'action_budget_exhausted'):
            self.driver(desktop, actions=1).submit('private', 'chatgpt-work')
        self.assertEqual(desktop.actions, [('open', 'private')])

    def test_invalid_prompt_and_surface_do_not_act(self):
        for prompt in (None, '', ' \n', 123):
            desktop = FakeDesktop()
            with self.assertRaisesRegex(DriverFailure, 'invalid_prompt'):
                self.driver(desktop).submit(prompt, 'chatgpt-work')
            self.assertEqual(desktop.actions, [])
        with self.assertRaisesRegex(DriverFailure, 'invalid_surface'):
            self.driver(FakeDesktop()).submit('private', 'unknown')

    @patch('chatgpt_linux.time.sleep')
    def test_initial_wait_is_bounded_and_does_not_open_query(self, sleep):
        desktop = FakeDesktop([])
        with self.assertRaisesRegex(DriverFailure, 'state_transition_unobserved'):
            self.driver(desktop).prepare('chatgpt-work')
        self.assertEqual(sleep.call_count, 300)
        self.assertEqual(desktop.actions, [])

    def test_overall_deadline_and_ambiguity_are_preserved(self):
        for kind in ('composer', 'send'):
            now = [0.0]
            desktop = FakeDesktop()
            desktop.nodes.append(node('extra', 'text', editable=True) if kind == 'composer' else node('Send'))
            with patch('chatgpt_linux.time.monotonic', side_effect=lambda: now[0]), \
                    patch('chatgpt_linux.time.sleep', side_effect=lambda seconds: now.__setitem__(0, now[0] + seconds)):
                driver = Driver(desktop, 250, 24)
                with self.assertRaisesRegex(DriverFailure, '^' + kind + '_missing_or_ambiguous$'):
                    driver.wait(lambda ns: driver.ready(ns, 'chatgpt-work'))
                self.assertEqual(driver.actions, 0)

    @patch('chatgpt_linux.time.sleep')
    def test_snapshot_failure_not_retried_by_wait(self, sleep):
        desktop = FakeDesktop()
        desktop.snapshot = Mock(side_effect=DriverFailure('composer_missing_or_ambiguous'))
        with self.assertRaisesRegex(DriverFailure, 'composer_missing_or_ambiguous'):
            self.driver(desktop).wait(lambda _: True)
        sleep.assert_not_called()

    def test_composer_ancestry_and_all_availability_flags(self):
        nodes = ready()
        nodes.append(node('paragraph', 'paragraph', editable=True, ancestors=(0, 2)))
        self.assertIs(composer(nodes), nodes[2])
        for flag in ('showing', 'visible', 'enabled', 'sensitive', 'editable'):
            nodes = ready()
            nodes[-1][flag] = False
            with self.assertRaisesRegex(DriverFailure, 'composer_missing_or_ambiguous'):
                composer(nodes)
        with self.assertRaisesRegex(DriverFailure, 'composer_missing_or_ambiguous'):
            composer(ready() + [node('separate', 'entry', editable=True)])

    @patch('chatgpt_linux.time.sleep')
    def test_failure_diagnostics_are_bounded_structural_only(self, _sleep):
        desktop = FakeDesktop(ready()[:-1] + [node('private', 'text', text='private query')] * 20)
        driver = self.driver(desktop)
        with self.assertRaises(DriverFailure):
            driver.prepare('chatgpt-work')
        receipt = driver.receipt('failed')
        self.assertEqual(len(receipt['composerCandidates']), 16)
        self.assertEqual(set(receipt['composerCandidates'][0]), {
            'role', 'showing', 'visible', 'enabled', 'sensitive',
            'editableState', 'editableInterface', 'textInterface'})
        self.assertNotIn('private', json.dumps(receipt))
        self.assertNotIn('composerCandidates', driver.receipt('ready', 'chatgpt-work'))

    def test_main_hides_exceptions_and_enforces_byte_limit(self):
        for payload, error in [(b'{"surface":"chatgpt-work"}', 'desktop_driver_failed'),
                                ('😀'.encode() * (INPUT_LIMIT // 4 + 1), 'input_too_large')]:
            desktop = FakeDesktop()
            desktop.snapshot = Mock(side_effect=RuntimeError('private query or stderr'))
            with patch('chatgpt_linux.Desktop', return_value=desktop), \
                    patch('sys.argv', ['driver', '--mode', 'prepare', '--timeout-ms', '60000']), \
                    patch('sys.stdin', SimpleNamespace(buffer=io.BytesIO(payload))), \
                    patch('sys.stdout', new_callable=io.StringIO) as output:
                self.assertEqual(main(), 1)
            self.assertEqual(json.loads(output.getvalue())['error'], error)
            self.assertNotIn('private', output.getvalue())


class OpenerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'opener'
        self.desktop = object.__new__(Desktop)
        self.desktop.deadline = time.monotonic() + 30

    def helper(self, body):
        self.path.write_text('#!' + sys.executable + '\n' + body)
        self.path.chmod(0o700)
        self.desktop.opener = str(self.path)

    def test_exact_stdin_no_prompt_argv_filtered_env_boolean_receipt(self):
        prompt = '  π 😀\n\nprivate "quoted" \\draft\t  \n'
        record = Path(self.temp.name) / 'record.json'
        self.helper('import json, os, sys\n'
                    'payload = json.load(sys.stdin)\n'
                    f'with open({str(record)!r}, "w") as output:\n'
                    ' json.dump({"payload":payload,"argv":sys.argv,"env":dict(os.environ)}, output)\n'
                    'print("{\\"opened\\":true}")\n')
        with patch.dict(os.environ, {'MST_CHATGPT_URL_OPENER': str(self.path), 'HOME': self.temp.name,
                                     'CODEX_HOME': self.temp.name + '/.codex',
                                     'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/test/bus',
                                     'ANTHROPIC_API_KEY': 'private-key', 'MCP_TOKEN': 'private-token'}):
            self.desktop.require_helpers()
            self.desktop.open_prompt(prompt)
        value = json.loads(record.read_text())
        self.assertEqual(value['payload'], {'prompt': prompt})
        self.assertEqual(value['argv'], [str(self.path)])
        self.assertEqual(value['env']['HOME'], self.temp.name)
        self.assertEqual(value['env']['CODEX_HOME'], self.temp.name + '/.codex')
        self.assertEqual(value['env']['DBUS_SESSION_BUS_ADDRESS'], 'unix:path=/test/bus')
        self.assertNotIn('ANTHROPIC_API_KEY', value['env'])
        self.assertNotIn('MCP_TOKEN', value['env'])
        self.assertNotIn('MST_CHATGPT_URL_OPENER', value['env'])

    def test_empty_prompt_is_exact_empty_json_not_a_query(self):
        self.helper('import json, sys\n'
                    'assert json.load(sys.stdin) == {"prompt":""}\n'
                    'assert len(sys.argv) == 1\n'
                    'print("{\\"opened\\":true}")\n')
        self.desktop.open_prompt('')

    def test_invalid_or_oversized_receipts_fail_without_raw_output(self):
        for output in ('', 'private-query', '{"opened":false}', '{"opened":1}',
                       '{"opened":true,"url":"private-query"}',
                       '{"opened":true,"opened":true}', '[["opened",true]]',
                       '{"opened":true}\n{}', 'x' * 1025):
            with self.subTest(output=output[:40]):
                self.helper('import sys\nsys.stdin.read()\n'
                            'print("private-stderr", file=sys.stderr)\n'
                            f'print({output!r})\n')
                with self.assertRaisesRegex(DriverFailure, '^helper_failed$'):
                    self.desktop.open_prompt('private')

    def test_nonzero_exit_rejects_even_valid_receipt(self):
        self.helper('import sys\nsys.stdin.read()\nprint("{\\"opened\\":true}")\nsys.exit(1)\n')
        with self.assertRaisesRegex(DriverFailure, '^helper_failed$'):
            self.desktop.open_prompt('private')

    def test_oversized_utf8_input_never_spawns(self):
        with patch('chatgpt_linux.subprocess.Popen') as popen:
            with self.assertRaisesRegex(DriverFailure, 'input_too_large'):
                self.desktop.open_prompt('😀' * (INPUT_LIMIT // 4))
            popen.assert_not_called()

    def test_missing_relative_directory_nonexecutable_helpers_block(self):
        self.path.write_text('not executable')
        for path in ('', 'relative', '/missing/mst-opener', self.temp.name, str(self.path)):
            with patch.dict(os.environ, {'MST_CHATGPT_URL_OPENER': path}):
                with self.assertRaisesRegex(DriverFailure, 'helper_missing'):
                    self.desktop.require_helpers()

    def test_timeout_is_capped_and_process_killed_without_retry(self):
        self.helper('import sys, time\nsys.stdin.read()\ntime.sleep(20)\n')
        self.desktop.deadline = time.monotonic() + 0.08
        real_popen = subprocess.Popen
        processes = []
        def spawn(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            processes.append(process)
            return process
        started = time.monotonic()
        with patch('chatgpt_linux.subprocess.Popen', side_effect=spawn) as popen:
            with self.assertRaisesRegex(DriverFailure, '^helper_timeout$'):
                self.desktop.open_prompt('private')
        self.assertLess(time.monotonic() - started, 2)
        popen.assert_called_once()
        self.assertIsNotNone(processes[0].poll())
        with patch.object(self.desktop, 'remaining', return_value=0.01) as remaining:
            with self.assertRaisesRegex(DriverFailure, '^helper_timeout$'):
                self.desktop.open_prompt('private')
            remaining.assert_called_once_with(15)

    def test_spawn_error_is_static_and_not_retried(self):
        self.desktop.opener = '/missing/helper'
        with patch('chatgpt_linux.subprocess.Popen', side_effect=OSError('private path')) as popen:
            with self.assertRaisesRegex(DriverFailure, '^helper_failed$'):
                self.desktop.open_prompt('private')
            popen.assert_called_once()

    def test_large_output_while_input_pending_is_bounded(self):
        self.helper('import sys\nsys.stdout.write("x" * 1000000)\nsys.stdout.flush()\nsys.stdin.read()\n')
        with self.assertRaisesRegex(DriverFailure, '^helper_failed$'):
            self.desktop.open_prompt('a' * 200_000)


class GeometryTest(unittest.TestCase):
    def setup_geometry(self):
        desktop = object.__new__(Desktop)
        desktop.deadline = time.monotonic() + 20
        rect = SimpleNamespace(x=20, y=40, width=100, height=40)
        frame = SimpleNamespace(x=300, y=200, width=800, height=600)
        component = SimpleNamespace(get_interfaces=lambda: ['Component'])
        nodes = [node('frame', 'frame', node=component, ancestors=()),
                 node('Engineering', 'radio button', node=component)]
        desktop.api = SimpleNamespace(
            CoordType=SimpleNamespace(WINDOW='window', SCREEN='screen'),
            Component=SimpleNamespace(get_extents=Mock(side_effect=[rect, frame]), contains=Mock(return_value=True)))
        return desktop, nodes, rect, frame

    @patch('chatgpt_linux.os.path.isfile', return_value=True)
    @patch('chatgpt_linux.os.access', return_value=True)
    @patch('chatgpt_linux.subprocess.run')
    def test_primary_click_uses_live_window_plus_screen_geometry_no_sync(self, run, *_):
        desktop, nodes, _, _ = self.setup_geometry()
        desktop.select_profession(nodes, nodes[1])
        self.assertEqual(run.call_args.args[0], [XDOTOOL, 'mousemove', '370', '260', 'click', '1'])
        self.assertFalse(run.call_args.kwargs['shell'])
        self.assertEqual(run.call_args.kwargs['stdout'], subprocess.DEVNULL)
        desktop.api.Component.contains.assert_called_once_with(nodes[1]['node'], 370, 260, 'screen')
        run.assert_called_once()

    @patch('chatgpt_linux.os.path.isfile', return_value=True)
    @patch('chatgpt_linux.os.access', return_value=True)
    @patch('chatgpt_linux.subprocess.run')
    def test_invalid_geometry_and_failed_hit_test_never_click(self, run, *_):
        for field, value in [('x', -1), ('width', 0), ('height', 1.5), ('y', 900), ('width', True)]:
            desktop, nodes, rect, _ = self.setup_geometry()
            setattr(rect, field, value)
            with self.assertRaisesRegex(DriverFailure, 'profession_geometry_invalid'):
                desktop.select_profession(nodes, nodes[1])
        desktop, nodes, _, _ = self.setup_geometry()
        desktop.api.Component.contains.return_value = False
        with self.assertRaisesRegex(DriverFailure, 'profession_geometry_invalid'):
            desktop.select_profession(nodes, nodes[1])
        run.assert_not_called()

    @patch('chatgpt_linux.os.path.isfile', return_value=True)
    @patch('chatgpt_linux.os.access', return_value=True)
    @patch('chatgpt_linux.subprocess.run')
    def test_missing_hit_test_is_optional_but_frame_and_component_are_required(self, run, *_):
        desktop, nodes, _, _ = self.setup_geometry()
        del desktop.api.Component.contains
        desktop.select_profession(nodes, nodes[1])
        run.assert_called_once()
        run.reset_mock()
        for kind in ('missing-frame', 'two-frames', 'no-component'):
            desktop, nodes, _, _ = self.setup_geometry()
            choice = nodes[1]
            if kind == 'missing-frame':
                choice['ancestors'] = ()
            elif kind == 'two-frames':
                nodes.append(nodes[0].copy())
                choice['ancestors'] = (0, 2)
            else:
                choice['node'] = SimpleNamespace(get_interfaces=lambda: [])
            with self.assertRaisesRegex(DriverFailure, 'profession_geometry_invalid'):
                desktop.select_profession(nodes, choice)
        run.assert_not_called()

    @patch('chatgpt_linux.os.path.isfile', return_value=True)
    @patch('chatgpt_linux.os.access', return_value=True)
    def test_mouse_failure_never_falls_back_to_check_or_retries(self, *_):
        for error, code in [(subprocess.TimeoutExpired('private', 2), 'helper_timeout'),
                            (subprocess.CalledProcessError(1, 'private'), 'helper_failed')]:
            desktop, nodes, _, _ = self.setup_geometry()
            with patch('chatgpt_linux.subprocess.run', side_effect=error) as run:
                with self.assertRaisesRegex(DriverFailure, code):
                    desktop.select_profession(nodes, nodes[1])
                run.assert_called_once()


class AccessibilityTest(unittest.TestCase):
    def test_public_text_without_editable_text_uses_unbound_readback(self):
        desktop, editor, _ = public_desktop()
        editor.value = '  π 😀\n\nExact.  \n'
        current = composer(desktop.snapshot())
        self.assertTrue(current['textInterface'])
        self.assertFalse(current['editableInterface'])
        self.assertEqual(desktop.text(current), editor.value)

    def test_static_password_hidden_disabled_or_missing_text_never_authorize(self):
        for kind in ('static', 'password', 'hidden', 'disabled', 'no-text', 'wrong-role'):
            desktop, editor, _ = public_desktop()
            if kind == 'static': editor.states.remove('EDITABLE')
            if kind == 'password': editor.role = 'password text'
            if kind == 'wrong-role': editor.role = 'document web'
            if kind == 'hidden': editor.states.remove('SHOWING')
            if kind == 'disabled': editor.states.remove('SENSITIVE')
            if kind == 'no-text': editor.interfaces = ['EditableText']
            with self.assertRaisesRegex(DriverFailure, 'composer_missing_or_ambiguous'):
                composer(desktop.snapshot())

    def test_snapshot_flushes_cached_selected_and_enabled_updates(self):
        desktop, editor, _ = public_desktop()
        editor.states.remove('ENABLED')
        before = next(n for n in desktop.snapshot() if n['node'] is editor)
        self.assertFalse(before['enabled'])
        desktop.context.events = [lambda: editor.states.update({'ENABLED', 'CHECKED'})]
        after = next(n for n in desktop.snapshot() if n['node'] is editor)
        self.assertTrue(after['enabled'])
        self.assertTrue(after['selected'])
        self.assertEqual(desktop.context.iterations, 1)

    def test_event_queue_budget(self):
        desktop, _, _ = public_desktop()
        desktop.context = FakeGLibContext(busy=True)
        with self.assertRaisesRegex(DriverFailure, 'accessibility_event_budget'):
            desktop.snapshot()
        self.assertEqual(desktop.context.iterations, 256)
        desktop.context = FakeGLibContext([lambda: None] * 256)
        self.assertTrue(desktop.snapshot())

    def test_transient_glib_snapshot_retries_only_reads_at_most_three_times(self):
        desktop, _, _ = public_desktop()
        with patch.object(desktop, '_snapshot', side_effect=[FakeGLibError('private'), []]) as snapshot:
            self.assertEqual(desktop.snapshot(), [])
            self.assertEqual(snapshot.call_count, 2)
        with patch.object(desktop, '_snapshot', side_effect=FakeGLibError('private')) as snapshot:
            with self.assertRaises(FakeGLibError): desktop.snapshot()
            self.assertEqual(snapshot.call_count, 3)

    def test_action_name_must_be_observed_unique_and_not_retried(self):
        desktop, _, _ = public_desktop()
        for names in (['delete'], ['click', 'press']):
            action = SimpleNamespace(get_n_actions=lambda: len(names),
                                     get_action_name=lambda i: names[i], do_action=Mock())
            with self.assertRaisesRegex(DriverFailure, 'action_missing_or_ambiguous'):
                desktop.activate({'node': SimpleNamespace(get_action_iface=lambda: action)}, {'click', 'press'})
            action.do_action.assert_not_called()
        action = SimpleNamespace(get_n_actions=lambda: 1, get_action_name=lambda _: 'click',
                                 do_action=Mock(side_effect=FakeGLibError('private')))
        with self.assertRaises(FakeGLibError):
            desktop.activate({'node': SimpleNamespace(get_action_iface=lambda: action)}, {'click'})
        action.do_action.assert_called_once()

    def test_exception_codes_are_static(self):
        with patch('chatgpt_linux.GLIB_ERROR', FakeGLibError):
            for error, code in [(AttributeError('private'), 'desktop_attribute_error'),
                                (TypeError('private'), 'desktop_type_error'),
                                (FakeGLibError('private'), 'desktop_glib_error'),
                                (DriverFailure('private'), 'desktop_driver_failed')]:
                self.assertEqual(error_code(error), code)
                self.assertIn(code, ERROR_CODES)


if __name__ == '__main__':
    unittest.main()
