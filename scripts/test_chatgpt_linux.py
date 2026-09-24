"""Offline native draft/AT-SPI contracts. No live app, credentials, or queries."""
import hashlib
import io
import json
import re
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, call, patch
from chatgpt_linux import (DRAFT_POLLS, Driver, DriverFailure, Desktop, composer, main,
                           error_code, ERROR_CODES, INPUT_LIMIT, SESSION_KEYS, XDOTOOL)

WORK, CODEX = 'ChatGPT Work', 'Codex'
SWITCH_CODEX = 'Switch mode, current mode: Codex'
WORK_ITEM = 'ChatGPT Work Create, learn, and explore'
PROMPT = '  π 😀e\u0301\n\nExact.  \n'
RECEIPT_KEYS = {'status', 'surface', 'action_count', 'duration_ms'}
FAILED_KEYS = {'status', 'action_count', 'duration_ms', 'phase', 'step', 'draftState', 'error'}
UNREADABLE = {'observedSurface', 'composerRootCount', 'sendControlCount', 'textReadable'}


def sha(text): return hashlib.sha256(text.encode('utf-8')).hexdigest()


def readable_state(text, surface='chatgpt-work'):
    return {'observedSurface': surface, 'composerRootCount': 1, 'sendControlCount': 1,
            'textReadable': True, 'textLength': len(text), 'textSha256': sha(text),
            'embeddedObjectCount': text.count('\ufffc'), 'newlineCount': text.count('\n')}


def node(name, role='button', **values):
    return {'name': name, 'role': role, 'showing': True, 'visible': True,
            'enabled': True, 'sensitive': True, 'editableState': False,
            'editableInterface': False, 'textInterface': False,
            'editable': False, 'selected': False, 'ancestors': (0,), **values}


def editor(name='extra', role='text', **values):
    return node(name, role, editable=True, **values)


def ready(surface=WORK, text=''):
    return [node('Switch mode, current mode: ' + surface), node('Send', enabled=bool(text)),
            node('composer', 'text', editable=True, editableState=True,
                 textInterface=True, text=text)]


def run_main(desktop, mode, payload, *extra):
    """Run the CLI with stdin bytes; return (exit code, raw stdout)."""
    with patch('chatgpt_linux.Desktop', return_value=desktop), \
            patch('sys.argv', ['driver', '--mode', mode, '--timeout-ms', '60000', *extra]), \
            patch('sys.stdin', SimpleNamespace(buffer=io.BytesIO(payload))), \
            patch('sys.stdout', new_callable=io.StringIO) as output:
        code = main()
    return code, output.getvalue()


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
    def __init__(self, name, role='button', editable=False, children=(), value=''):
        self.name, self.role, self.children, self.value = name, role, list(children), value
        self.states = {'SHOWING', 'VISIBLE', 'ENABLED', 'SENSITIVE'}
        self.interfaces, self.links = [], {}
        if editable:
            self.states.add('EDITABLE')
            self.interfaces.append('Text')

    def get_name(self): return self.name
    def get_role_name(self): return self.role
    def get_state_set(self): return SimpleNamespace(contains=lambda state: state in self.states)
    def get_child_count(self): return len(self.children)
    def get_child_at_index(self, index): return self.children[index]
    def get_interfaces(self): return self.interfaces
    def get_text_iface(self):
        return self if any(i in self.interfaces for i in ('Text', 'org.a11y.atspi.Text')) else None
    def get_editable_text_iface(self):
        return self if any(i in self.interfaces for i in ('EditableText', 'org.a11y.atspi.EditableText')) else None
    def get_text(self, *_): raise TypeError('private bound collision')


def public_desktop():
    editor_node = PublicNode('private composer', 'text', editable=True)
    app = PublicNode('ChatGPT', 'application', children=[
        PublicNode('Switch mode, current mode: ChatGPT Work'), PublicNode('Send'), editor_node])
    root = PublicNode('desktop', 'desktop', children=[app])
    desktop = object.__new__(Desktop)
    desktop.deadline, desktop.glib_error = float('inf'), FakeGLibError
    desktop.context = FakeGLibContext()
    desktop.api = SimpleNamespace(
        get_desktop=lambda _: root,
        StateType=SimpleNamespace(**{key: key for key in (
            'SHOWING', 'VISIBLE', 'ENABLED', 'SENSITIVE', 'EDITABLE', 'CHECKED', 'SELECTED')}),
        Text=SimpleNamespace(get_text=lambda n, start, end: n.value[start:end],
                             get_character_count=lambda n: len(n.value)),
        Hypertext=SimpleNamespace(
            get_link_index=Mock(side_effect=lambda n, offset: offset if offset in n.links else -1),
            get_link=Mock(side_effect=lambda n, index: n.links[index])),
        Hyperlink=SimpleNamespace(
            get_n_anchors=Mock(side_effect=lambda link: len(link.anchors)),
            get_object=Mock(side_effect=lambda link, index: link.anchors[index])))
    return desktop, editor_node, app


class FakeDesktop:
    def __init__(self, nodes=None):
        self.nodes = ready() if nodes is None else nodes
        self.actions, self.stall, self.open_surface = [], None, None
        self.preserve_draft, self.uncertain_send, self.stale_checked = True, False, False

    def require_helpers(self): pass
    def snapshot(self): return self.nodes
    def text(self, control, limit=None): return control.get('text', '')
    def surface(self): return CODEX if self.nodes[0]['name'].endswith(CODEX) else WORK

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
            self.nodes = ready(CODEX)
        elif name.startswith('Switch mode'):
            self.nodes += [node(WORK_ITEM, 'menu item'),
                           node('Codex Build, debug, and ship', 'menu item')]
        elif name.startswith((WORK_ITEM, 'Codex Build')):
            text = self.text(composer(self.nodes)) if self.preserve_draft else ''
            self.nodes = ready(CODEX if name.startswith(CODEX) else WORK, text)
        elif name == 'Send' and self.uncertain_send:
            raise DriverFailure('action_acknowledgement_uncertain')


def hook_open(desktop, after):
    """Wrap FakeDesktop.open_prompt with a post-open mutation `after(value)`."""
    original = desktop.open_prompt
    def open_prompt(value):
        original(value)
        after(value)
    desktop.open_prompt = open_prompt


class MainCliTest(unittest.TestCase):
    """stdin JSON in, exactly one JSON receipt line out; failures use fixed fields only."""

    @patch('chatgpt_linux.time.sleep')
    def test_success_prints_one_receipt_line_and_passes_open_fd(self, _sleep):
        for mode, payload, status in [('prepare', b'{"surface":"codex"}', 'ready'),
                                      ('submit', b'{"surface":"chatgpt-work","prompt":"private"}',
                                       'submitted')]:
            with self.subTest(mode=mode):
                desktop = FakeDesktop(ready(CODEX if mode == 'prepare' else WORK))
                code, output = run_main(desktop, mode, payload, '--open-fd', '7')
                self.assertEqual(code, 0)
                self.assertEqual(output.count('\n'), 1)
                receipt = json.loads(output)
                self.assertEqual(set(receipt), RECEIPT_KEYS)
                self.assertEqual(receipt['status'], status)
                self.assertEqual(desktop.open_fd, 7)
                self.assertNotIn('private', output)

    @patch('chatgpt_linux.time.sleep')
    def test_failure_receipts_carry_only_fixed_fields_never_prompt_or_ui_text(self, _sleep):
        private_ui = [node('Loading'), node('sk-private'), node('private content', 'paragraph')]
        glib = FakeDesktop()
        glib.glib_error = FakeGLibError  # Desktop owns the GLib type; no module global.
        cases = [('prepare', FakeDesktop(list(private_ui)), None, b'{"surface":"codex"}',
                  'state_transition_unobserved'),
                 ('submit', FakeDesktop(list(private_ui)), None,
                  b'{"surface":"codex","prompt":"private prompt"}', 'surface_mismatch'),
                 ('prepare', FakeDesktop(), RuntimeError('private query or stderr'),
                  b'{"surface":"chatgpt-work"}', 'desktop_driver_failed'),
                 ('prepare', FakeDesktop(), None, '😀'.encode() * (INPUT_LIMIT // 4 + 1),
                  'input_too_large'),
                 ('prepare', glib, FakeGLibError('private'), b'{"surface":"codex"}',
                  'desktop_glib_error')]
        for mode, desktop, snapshot_error, payload, error in cases:
            with self.subTest(error=error):
                if snapshot_error:
                    desktop.snapshot = Mock(side_effect=snapshot_error)
                code, output = run_main(desktop, mode, payload)
                receipt = json.loads(output)
                self.assertEqual(code, 1)
                self.assertEqual(receipt['error'], error)
                self.assertIn(error, ERROR_CODES)
                self.assertLessEqual(set(receipt), FAILED_KEYS)
                for leaked in ('private', 'Loading', 'sk-'):
                    self.assertNotIn(leaked, output)
                self.assertEqual(desktop.actions, [])


class DraftStateTest(unittest.TestCase):
    """Failure-only draftState from the last snapshot: readable and unreadable shapes."""

    def failed_state(self, desktop, read=None):
        driver = Driver(desktop, 60_000, 24)
        driver.snapshot()
        if read is not None:
            desktop.text = read
        return driver, driver.receipt('failed').get('draftState')

    def test_readable_shape_is_exact_measurements_without_private_values(self):
        for text in ('', '\ufffc', '\ufffc\ufffc\n\r\nπ😀', 'private prompt'):
            with self.subTest(text=text):
                desktop = FakeDesktop(ready(text=text))
                desktop.nodes[2].update(name='private UI name', url='https://private.example',
                                        config='private config', prompt='private prompt')
                # Chromium entry plus nested editable paragraph is one root.
                desktop.nodes[2]['role'] = 'entry'
                desktop.nodes.append(editor('private paragraph', 'paragraph', ancestors=(0, 2),
                                            text='must not read'))
                driver = Driver(desktop, 60_000, 24)
                driver.phase, driver.step = 'composer', 'draft-surface'
                driver.snapshot()
                desktop.snapshot = Mock(side_effect=AssertionError('no fresh snapshot'))
                desktop.text = Mock(wraps=desktop.text)
                receipt = driver.receipt('failed')
                self.assertEqual(receipt['draftState'], readable_state(text))
                self.assertEqual((receipt['phase'], receipt['step']), ('composer', 'draft-surface'))
                self.assertNotIn('private', json.dumps(receipt))
                desktop.text.assert_called_once_with(desktop.nodes[2], limit=INPUT_LIMIT)
                self.assertEqual(desktop.actions, [])

    def test_unreadable_shape_for_unsafe_editors_failed_or_oversized_reads(self):
        never = Mock(side_effect=AssertionError('must not read'))
        for editors in ([], [editor('a', 'entry'), editor('b', 'paragraph')],
                        [editor('a', 'entry', visible=False)], [editor('a', 'entry', showing=False)],
                        [editor('a', 'entry', enabled=False)], [editor('a', 'entry', sensitive=False)]):
            with self.subTest(editors=len(editors)):
                _, state = self.failed_state(FakeDesktop(ready()[:2] + editors), never)
                self.assertEqual(set(state), UNREADABLE)
                self.assertFalse(state['textReadable'])
        for text in (None, 1, 'a' * (INPUT_LIMIT + 1), '😀' * (INPUT_LIMIT // 4 + 1), '\ud800'):
            with self.subTest(text=str(text)[:8]):
                _, state = self.failed_state(FakeDesktop(ready(text=text)))
                self.assertEqual(set(state), UNREADABLE)
        driver, state = self.failed_state(FakeDesktop(), Mock(side_effect=RuntimeError('private UI')))
        self.assertEqual(set(state), UNREADABLE)
        self.assertNotIn('private', json.dumps(driver.receipt('failed')))
        never.assert_not_called()

    def test_only_failed_receipts_after_a_snapshot_have_draft_state(self):
        desktop = FakeDesktop()
        driver = Driver(desktop, 60_000, 24)
        self.assertNotIn('draftState', driver.receipt('failed'))
        driver.snapshot()
        desktop.text = Mock(side_effect=AssertionError('no diagnostic read on success'))
        for status in ('ready', 'submitted'):
            self.assertNotIn('draftState', driver.receipt(status, 'chatgpt-work'))

    def test_observed_surface_uses_only_known_visible_labels(self):
        codex, work = node(SWITCH_CODEX), node('Switch mode, current mode: ChatGPT Work')
        for switches, expected in [([], 'unknown'), ([node('private surface')], 'unknown'),
                                   ([codex], 'codex'), ([work], 'chatgpt-work'),
                                   ([node(SWITCH_CODEX, visible=False)], 'unknown'),
                                   ([codex, codex], 'ambiguous'), ([codex, work], 'ambiguous')]:
            with self.subTest(expected=expected, count=len(switches)):
                _, state = self.failed_state(FakeDesktop(switches))
                self.assertEqual(state['observedSurface'], expected)

    def test_public_atspi_diagnostic_read_is_bounded_and_unbound(self):
        desktop, editor_node, _ = public_desktop()
        editor_node.value = '\ufffc'
        desktop.api.Text.get_text = Mock(wraps=desktop.api.Text.get_text)
        _, state = self.failed_state(desktop)
        self.assertEqual(state, readable_state('\ufffc'))
        desktop.api.Text.get_text.assert_called_once_with(editor_node, 0, 1)
        desktop.api.Text.get_text.reset_mock()
        editor_node.value = 'a' * (INPUT_LIMIT + 1)
        _, state = self.failed_state(desktop)
        self.assertEqual(set(state), UNREADABLE)
        desktop.api.Text.get_text.assert_not_called()


class DriverTest(unittest.TestCase):
    def driver(self, desktop, actions=24): return Driver(desktop, 60_000, actions)
    def actions(self, desktop): return [action[0] for action in desktop.actions]

    def run_mode(self, driver, mode, prompt='private'):
        return driver.prepare('chatgpt-work') if mode == 'prepare' else driver.submit(prompt, 'chatgpt-work')

    # --- setup (prepare) ---

    @patch('chatgpt_linux.time.sleep')
    def test_setup_opens_one_empty_chat_without_readback_or_send(self, _sleep):
        # Target surface -> expected action count after opening into ChatGPT Work.
        for surface, label, count in [('chatgpt-work', WORK, 1), ('codex', CODEX, 3)]:
            with self.subTest(surface=surface):
                desktop = FakeDesktop(ready(label, 'prior draft'))
                def open_empty(prompt, desktop=desktop):
                    desktop.actions.append(('open', prompt))
                    desktop.nodes = ready(WORK, 'Ask anything here\n')
                    desktop.nodes[1]['enabled'] = False
                desktop.open_prompt = open_empty
                desktop.text = Mock(side_effect=AssertionError('setup has no prompt to read back'))
                desktop.preserve_draft = False
                receipt = self.driver(desktop).prepare(surface)
                self.assertEqual(receipt, {**receipt, 'status': 'ready', 'surface': surface,
                                           'action_count': count})
                self.assertEqual(set(receipt), RECEIPT_KEYS)
                self.assertEqual(desktop.actions[0], ('open', ''))
                self.assertEqual(self.actions(desktop).count('open'), 1)
                self.assertNotIn('Send', self.actions(desktop))

    def test_setup_ready_means_controls_not_verified_emptiness(self):
        desktop = FakeDesktop(ready(text='prior draft'))
        desktop.stall = 'open'
        desktop.text = Mock(side_effect=AssertionError('no setup emptiness predicate'))
        receipt = self.driver(desktop).prepare('chatgpt-work')
        self.assertEqual(receipt['status'], 'ready')
        self.assertEqual(desktop.actions, [('open', '')])
        self.assertEqual(composer(desktop.nodes)['text'], 'prior draft')

    @patch('chatgpt_linux.time.sleep')
    def test_setup_still_requires_surface_unique_composer_and_send_after_open(self, _sleep):
        mutations = {'surface': lambda ns: ns[0].update(name='unknown mode'),
                     'composer-missing': lambda ns: ns.pop(),
                     'composer-ambiguous': lambda ns: ns.append(editor('other', 'entry')),
                     'send-missing': lambda ns: ns.pop(1),
                     'send-ambiguous': lambda ns: ns.append(node('Send'))}
        for kind, mutate in mutations.items():
            with self.subTest(kind=kind):
                desktop = FakeDesktop()
                hook_open(desktop, lambda _v, d=desktop, m=mutate: m(d.nodes))
                with self.assertRaises(DriverFailure):
                    self.driver(desktop).prepare('chatgpt-work')
                self.assertEqual(desktop.actions, [('open', '')])

    # --- onboarding / intro ---

    def test_onboarding_skips_known_intro_then_one_empty_open(self):
        desktop = FakeDesktop([node('Engineering', 'radio button'), node('Continue')])
        desktop.stale_checked = True
        result = self.driver(desktop).prepare('chatgpt-work')
        self.assertEqual(set(result), RECEIPT_KEYS)
        self.assertEqual(self.actions(desktop), ['Engineering', 'Continue', 'Skip', 'Go to ChatGPT',
                                                 SWITCH_CODEX, WORK_ITEM, 'open'])
        self.assertEqual(desktop.actions[-1], ('open', ''))
        self.assertEqual(result['action_count'], 7)

    @patch('chatgpt_linux.time.sleep')
    def test_unknown_or_partial_intro_screens_are_never_skipped(self, _sleep):
        for nodes, error in [([node('Skip')], 'state_transition_unobserved'),
                             # Skip plus only one of the two known intro markers.
                             ([node('Skip'), node('Leave a note on my Desktop')],
                              'mode_missing_or_ambiguous'),
                             ([node('Engineering', 'radio button')] * 2, 'profession_ambiguous')]:
            with self.subTest(error=error):
                desktop = FakeDesktop(nodes)
                with self.assertRaisesRegex(DriverFailure, error):
                    self.driver(desktop).prepare('chatgpt-work')
                self.assertEqual(desktop.actions, [])

    @patch('chatgpt_linux.time.sleep')
    def test_continue_waits_for_enablement_and_is_never_retried(self, sleep):
        for selected in (False, True):
            with self.subTest(selected=selected):
                desktop = FakeDesktop([node('Engineering', 'radio button', selected=selected),
                                       node('Continue', enabled=False)])
                desktop.stale_checked = True
                sleep.reset_mock()
                sleep.side_effect = lambda _, d=desktop: (
                    d.nodes[1].update(enabled=True) if sleep.call_count == 3 else None)
                self.driver(desktop).prepare('chatgpt-work')
                self.assertEqual(self.actions(desktop).count('Engineering'), 0 if selected else 1)
                self.assertEqual(self.actions(desktop).count('Continue'), 1)
                self.assertEqual(sleep.call_count, 3)
        sleep.side_effect, desktop = None, FakeDesktop(
            [node('Engineering', 'radio button'), node('Continue', enabled=False)])
        sleep.reset_mock()
        driver = self.driver(desktop)
        with self.assertRaisesRegex(DriverFailure, 'state_transition_unobserved'):
            driver.prepare('chatgpt-work')
        self.assertEqual(driver.receipt('failed')['phase'], 'continue-ready')
        self.assertEqual(self.actions(desktop), ['Engineering'])
        self.assertEqual(sleep.call_count, 100)

    # --- submit: exact echo, one Send ---

    def test_exact_or_one_terminal_lf_echo_sends_once_with_unmodified_prompt(self):
        for prompt in ('Find docs', PROMPT, 'π\n\n'):
            for suffix in ('', '\n'):
                for corrected in (False, True):
                    with self.subTest(prompt=prompt, suffix=suffix, corrected=corrected):
                        desktop = FakeDesktop(ready(text='prior draft'))
                        hook_open(desktop, lambda v, d=desktop, s=suffix: composer(d.nodes).update(text=v + s))
                        desktop.open_surface = CODEX if corrected else None
                        receipt = self.driver(desktop).submit(prompt, 'chatgpt-work')
                        self.assertEqual(set(receipt), RECEIPT_KEYS)
                        self.assertEqual(receipt['status'], 'submitted')
                        self.assertEqual(receipt['action_count'], 4 if corrected else 2)
                        self.assertEqual(desktop.actions[0], ('open', prompt))
                        # One open, one Send, nothing else (no Enter/keyboard fallback).
                        self.assertEqual(self.actions(desktop), ['open', SWITCH_CODEX, WORK_ITEM, 'Send']
                                         if corrected else ['open', 'Send'])
                        self.assertEqual(composer(desktop.nodes)['text'], prompt + suffix)

    @patch('chatgpt_linux.time.sleep')
    def test_draft_mismatch_blocks_send_before_and_after_mode_correction(self, _sleep):
        mismatches = [PROMPT + '\n\n', 'prefix' + PROMPT, PROMPT + 'suffix', PROMPT.strip(),
                      PROMPT.lstrip(), PROMPT.rstrip(), PROMPT[:-1], PROMPT + '\r\n',
                      PROMPT.replace('\n', ''), '']
        for text in mismatches:
            for after_correction in (False, True):
                with self.subTest(text=text, after_correction=after_correction):
                    desktop = FakeDesktop()
                    desktop.open_surface = CODEX
                    hook_open(desktop, lambda v, d=desktop, t=text, a=after_correction:
                              composer(d.nodes).update(text=v + '\n' if a else t))
                    original_activate = desktop.activate
                    def activate(control, allowed, d=desktop, t=text):
                        original_activate(control, allowed)
                        if control['name'] == WORK_ITEM:
                            composer(d.nodes)['text'] = t
                    desktop.activate = activate
                    driver = self.driver(desktop)
                    with self.assertRaisesRegex(DriverFailure, 'state_transition_unobserved'):
                        driver.submit(PROMPT, 'chatgpt-work')
                    self.assertEqual(self.actions(desktop), ['open', SWITCH_CODEX, WORK_ITEM]
                                     if after_correction else ['open'])
                    self.assertEqual(driver.step, 'draft-readback' if after_correction else 'draft-surface')

    @patch('chatgpt_linux.time.sleep')
    def test_exact_echo_and_unique_enabled_send_required_before_send(self, sleep):
        mutations = {'wrong-text': lambda d, v: composer(d.nodes).update(text=v.strip()),
                     'composer': lambda d, v: d.nodes.append(editor()),
                     'send': lambda d, v: d.nodes.append(node('Send')),
                     'send-disabled': lambda d, v: d.nodes[1].update(enabled=False)}
        for kind, mutate in mutations.items():
            for settles in (False, True):
                with self.subTest(kind=kind, settles=settles):
                    desktop = FakeDesktop()
                    hook_open(desktop, lambda v, d=desktop, m=mutate: m(d, v))
                    sleep.reset_mock()
                    def settle(_, d=desktop):
                        self.assertNotIn('Send', self.actions(d))
                        d.nodes = ready(text=PROMPT)
                    sleep.side_effect = settle if settles else None
                    driver = self.driver(desktop)
                    if settles:
                        self.assertEqual(driver.submit(PROMPT, 'chatgpt-work')['status'], 'submitted')
                        self.assertEqual(self.actions(desktop), ['open', 'Send'])
                    else:
                        with self.assertRaises(DriverFailure):
                            driver.submit(PROMPT, 'chatgpt-work')
                        self.assertEqual(self.actions(desktop), ['open'])
                        # A draft that never appears waits the 30 s draft window; a
                        # draft whose Send stays disabled fails the shorter readback.
                        self.assertEqual(sleep.call_count, 100 if kind == 'send-disabled' else DRAFT_POLLS)

    @patch('chatgpt_linux.time.sleep')
    def test_slow_draft_within_30s_is_awaited_without_reopening(self, sleep):
        self.assertEqual(DRAFT_POLLS, 300)  # 300 x 0.1 s read-only polls.
        desktop = FakeDesktop()
        desktop.stall = 'open'
        polls = iter(range(10_000))
        def settle(_):
            if next(polls) == 150:  # about 15 s
                desktop.nodes = ready(WORK, 'private prompt')
        sleep.side_effect = settle
        self.assertEqual(self.driver(desktop).submit('private prompt', 'chatgpt-work')['status'], 'submitted')
        self.assertEqual(self.actions(desktop), ['open', 'Send'])

    def test_uncertain_send_is_not_retried(self):
        desktop = FakeDesktop()
        desktop.uncertain_send = True
        driver = self.driver(desktop)
        with self.assertRaisesRegex(DriverFailure, 'acknowledgement_uncertain'):
            driver.submit('private', 'chatgpt-work')
        self.assertEqual(self.actions(desktop), ['open', 'Send'])
        self.assertEqual(driver.receipt('failed')['step'], 'send')

    # --- surface selection ---

    @patch('chatgpt_linux.time.sleep')
    def test_deep_link_mode_switch_once_requires_preserved_exact_draft(self, _sleep):
        for preserve in (True, False):
            for surface, start, opened in [('chatgpt-work', WORK, CODEX), ('codex', CODEX, WORK)]:
                with self.subTest(preserve=preserve, surface=surface):
                    desktop = FakeDesktop(ready(start))
                    desktop.open_surface, desktop.preserve_draft = opened, preserve
                    driver = self.driver(desktop)
                    if preserve:
                        receipt = driver.submit(PROMPT, surface)
                        self.assertEqual((receipt['surface'], receipt['action_count']), (surface, 4))
                    else:
                        with self.assertRaisesRegex(DriverFailure, 'state_transition_unobserved'):
                            driver.submit(PROMPT, surface)
                    self.assertEqual(desktop.actions[0], ('open', PROMPT))
                    self.assertEqual(self.actions(desktop).count('open'), 1)
                    self.assertEqual(sum(a.startswith('Switch mode') for a in self.actions(desktop)), 1)
                    self.assertEqual(self.actions(desktop).count('Send'), 1 if preserve else 0)

    @patch('chatgpt_linux.time.sleep')
    def test_waits_for_draft_before_correcting_delayed_mode_change(self, sleep):
        desktop = FakeDesktop()
        desktop.stall = 'open'
        def settle(_):
            self.assertEqual(desktop.actions, [('open', PROMPT)])
            desktop.nodes = ready(CODEX, PROMPT)
        sleep.side_effect = settle
        self.assertEqual(self.driver(desktop).submit(PROMPT, 'chatgpt-work')['action_count'], 4)
        self.assertEqual(self.actions(desktop), ['open', SWITCH_CODEX, WORK_ITEM, 'Send'])
        sleep.assert_called_once()

    @patch('chatgpt_linux.time.sleep')
    def test_stalled_mode_correction_is_not_repeated(self, sleep):
        desktop = FakeDesktop()
        desktop.open_surface, desktop.stall = CODEX, WORK_ITEM
        with self.assertRaisesRegex(DriverFailure, 'state_transition_unobserved'):
            self.driver(desktop).submit('private', 'chatgpt-work')
        self.assertEqual(self.actions(desktop), ['open', SWITCH_CODEX, WORK_ITEM])
        self.assertEqual(sleep.call_count, 100)

    def test_invalid_input_surface_mismatch_or_missing_helper_block_before_any_action(self):
        missing = FakeDesktop()
        missing.require_helpers = Mock(side_effect=DriverFailure('helper_missing'))
        cases = [('submit', FakeDesktop(ready(CODEX)), 'private', 'chatgpt-work', 'surface_mismatch'),
                 ('submit', FakeDesktop(), 'private', 'unknown', 'invalid_surface'),
                 ('prepare', FakeDesktop(), None, 'unknown', 'invalid_surface'),
                 ('prepare', missing, None, 'chatgpt-work', 'helper_missing'),
                 ('submit', missing, 'private', 'chatgpt-work', 'helper_missing')]
        cases += [('submit', FakeDesktop(), bad, 'chatgpt-work', 'invalid_prompt')
                  for bad in (None, '', ' \n', 123)]
        for mode, desktop, prompt, surface, error in cases:
            with self.subTest(mode=mode, error=error, prompt=prompt):
                driver = self.driver(desktop)
                with self.assertRaisesRegex(DriverFailure, '^' + error + '$'):
                    driver.prepare(surface) if mode == 'prepare' else driver.submit(prompt, surface)
                self.assertEqual(driver.actions, 0)
                self.assertEqual(desktop.actions, [])

    def test_hand_off_failure_does_not_send_or_reopen(self):
        for mode in ('prepare', 'submit'):
            for code in ('helper_failed', 'helper_timeout'):
                with self.subTest(mode=mode, code=code):
                    desktop = FakeDesktop()
                    desktop.open_prompt = Mock(side_effect=DriverFailure(code))
                    driver = self.driver(desktop)
                    with self.assertRaisesRegex(DriverFailure, code):
                        self.run_mode(driver, mode)
                    desktop.open_prompt.assert_called_once_with('' if mode == 'prepare' else 'private')
                    self.assertEqual((driver.actions, desktop.actions), (1, []))
                    self.assertEqual(driver.receipt('failed')['step'], 'draft-open')

    # --- budgets, deadline, waits ---

    def test_action_budget_and_deadline_block_before_send(self):
        desktop = FakeDesktop()
        with self.assertRaisesRegex(DriverFailure, 'action_budget_exhausted'):
            self.driver(desktop, actions=1).submit('private', 'chatgpt-work')
        self.assertEqual(desktop.actions, [('open', 'private')])
        for mode in ('prepare', 'submit'):
            with self.subTest(mode=mode):
                desktop = FakeDesktop()
                driver = self.driver(desktop)
                driver.deadline = 0
                with self.assertRaisesRegex(DriverFailure, '^deadline_exceeded$'):
                    self.run_mode(driver, mode)
                self.assertEqual(desktop.actions, [])

    def test_overall_deadline_preserves_transient_ambiguity(self):
        for kind in ('composer', 'send'):
            with self.subTest(kind=kind):
                now = [0.0]
                desktop = FakeDesktop()
                desktop.nodes.append(editor() if kind == 'composer' else node('Send'))
                with patch('chatgpt_linux.time.monotonic', side_effect=lambda: now[0]), \
                        patch('chatgpt_linux.time.sleep', side_effect=lambda s: now.__setitem__(0, now[0] + s)):
                    driver = Driver(desktop, 250, 24)
                    with self.assertRaisesRegex(DriverFailure, '^' + kind + '_missing_or_ambiguous$'):
                        driver.wait(lambda ns: driver.ready(ns, 'chatgpt-work'))
                    self.assertEqual(driver.actions, 0)

    @patch('chatgpt_linux.time.sleep')
    def test_initial_wait_is_bounded_and_snapshot_failures_are_not_retried(self, sleep):
        desktop = FakeDesktop([])
        with self.assertRaisesRegex(DriverFailure, 'state_transition_unobserved'):
            self.driver(desktop).prepare('chatgpt-work')
        self.assertEqual(sleep.call_count, 300)
        self.assertEqual(desktop.actions, [])
        sleep.reset_mock()
        desktop.snapshot = Mock(side_effect=DriverFailure('composer_missing_or_ambiguous'))
        with self.assertRaisesRegex(DriverFailure, 'composer_missing_or_ambiguous'):
            self.driver(desktop).wait(lambda _: True)
        sleep.assert_not_called()

    def test_composer_requires_unique_available_editable_root(self):
        nodes = ready() + [editor('paragraph', 'paragraph', ancestors=(0, 2))]
        self.assertIs(composer(nodes), nodes[2])
        for flag in ('showing', 'visible', 'enabled', 'sensitive', 'editable', None):
            with self.subTest(flag=flag):
                nodes = ready() if flag else ready() + [editor('separate', 'entry')]
                if flag:
                    nodes[-1][flag] = False
                with self.assertRaisesRegex(DriverFailure, 'composer_missing_or_ambiguous'):
                    composer(nodes)


class OpenerTest(unittest.TestCase):
    """The MST parent owns the deep-link hand-off; Python sends one sha-bound request."""

    def setUp(self):
        self.driver_end, self.parent_end = socket.socketpair()
        self.addCleanup(self.driver_end.close)
        self.addCleanup(self.parent_end.close)
        self.desktop = object.__new__(Desktop)
        self.desktop.deadline = time.monotonic() + 30
        self.desktop.open_fd = self.driver_end.fileno()
        self.requests = []

    def parent(self, reply):
        def serve():
            data = b''
            while b'\n' not in data:
                chunk = self.parent_end.recv(4096)
                if not chunk:
                    return
                data += chunk
            self.requests.append(data)
            if reply is not None:
                try:
                    self.parent_end.sendall(reply)
                except OSError:
                    pass  # The driver may close after rejecting an oversized reply.
        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 1)

    def test_requests_once_with_only_the_utf8_sha256_of_the_expected_draft(self):
        for prompt in ('  π 😀\n\nprivate "quoted" \\draft\t  \n', ''):
            with self.subTest(prompt=prompt):
                self.setUp()
                self.parent(b'{"opened": true}\n')
                self.desktop.require_helpers()
                self.desktop.open_prompt(prompt)
                self.assertEqual(self.requests, [json.dumps({'open': sha(prompt)}).encode() + b'\n'])
                self.assertNotIn(b'private', self.requests[0])

    def test_one_request_per_process_never_retried(self):
        self.parent(b'{"opened":false}\n')
        for _ in range(2):
            with self.assertRaisesRegex(DriverFailure, '^helper_failed$'):
                self.desktop.open_prompt('private')
        self.assertEqual(len(self.requests), 1)

    def test_invalid_or_oversized_receipts_fail_without_raw_output(self):
        for output in (b'private-query\n', b'{"opened":false}\n', b'{"opened":1}\n',
                       b'{"opened":true,"url":"private-query"}\n',
                       b'{"opened":true,"opened":true}\n', b'[["opened",true]]\n',
                       b'{"opened":true}\n{}', b'x' * 1025, b''):
            with self.subTest(output=output[:40]):
                self.setUp()
                self.parent(output)
                if not output:
                    self.parent_end.shutdown(socket.SHUT_WR)
                with self.assertRaisesRegex(DriverFailure, '^helper_failed$'):
                    self.desktop.open_prompt('private')

    def test_oversized_unencodable_or_missing_channel_never_requests(self):
        with self.assertRaisesRegex(DriverFailure, 'input_too_large'):
            self.desktop.open_prompt('😀' * (INPUT_LIMIT // 4 + 1))
        with self.assertRaisesRegex(DriverFailure, 'invalid_prompt'):
            self.desktop.open_prompt('bad\ud800')
        self.assertEqual(self.requests, [])
        with tempfile.TemporaryFile() as regular:
            for fd in (None, 0, 2, 999, regular.fileno()):
                with self.subTest(fd=fd):
                    self.desktop.open_fd = fd
                    with self.assertRaisesRegex(DriverFailure, 'helper_missing'):
                        self.desktop.require_helpers()

    def test_timeout_is_capped_by_the_driver_deadline_without_retry(self):
        self.parent(None)
        self.desktop.deadline = time.monotonic() + 0.08
        started = time.monotonic()
        with self.assertRaisesRegex(DriverFailure, '^helper_timeout$'):
            self.desktop.open_prompt('private')
        self.assertLess(time.monotonic() - started, 2)
        desktop = object.__new__(Desktop)
        desktop.open_fd = self.driver_end.fileno()
        with patch.object(desktop, 'remaining', return_value=0.01, create=True) as remaining:
            with self.assertRaisesRegex(DriverFailure, '^helper_timeout$'):
                desktop.open_prompt('private')
            remaining.assert_called_once_with(30)


@patch('chatgpt_linux.os.path.isfile', return_value=True)
@patch('chatgpt_linux.os.access', return_value=True)
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
            Component=SimpleNamespace(get_extents=Mock(side_effect=[rect, frame]),
                                      contains=Mock(return_value=True)))
        return desktop, nodes, rect

    def test_primary_click_is_one_mouse_click_at_live_window_plus_screen_geometry(self, *_):
        for hit_test in (True, False):
            with self.subTest(hit_test=hit_test), patch('chatgpt_linux.subprocess.run') as run:
                desktop, nodes, _ = self.setup_geometry()
                contains = desktop.api.Component.contains
                if not hit_test:
                    del desktop.api.Component.contains  # Optional in AT-SPI.
                desktop.select_profession(nodes, nodes[1])
                run.assert_called_once()
                self.assertEqual(run.call_args.args[0], [XDOTOOL, 'mousemove', '370', '260', 'click', '1'])
                self.assertFalse(run.call_args.kwargs['shell'])
                self.assertEqual(run.call_args.kwargs['stdout'], subprocess.DEVNULL)
                if hit_test:
                    contains.assert_called_once_with(nodes[1]['node'], 370, 260, 'screen')

    def test_invalid_geometry_frame_component_or_hit_test_never_click(self, *_):
        cases = [('rect', field, value) for field, value in
                 [('x', -1), ('width', 0), ('height', 1.5), ('y', 900), ('width', True)]]
        cases += [('miss', None, None), ('missing-frame', None, None),
                  ('two-frames', None, None), ('no-component', None, None)]
        with patch('chatgpt_linux.subprocess.run') as run:
            for kind, field, value in cases:
                with self.subTest(kind=kind, field=field):
                    desktop, nodes, rect = self.setup_geometry()
                    choice = nodes[1]
                    if kind == 'rect':
                        setattr(rect, field, value)
                    elif kind == 'miss':
                        desktop.api.Component.contains.return_value = False
                    elif kind == 'missing-frame':
                        choice['ancestors'] = ()
                    elif kind == 'two-frames':
                        nodes.append(nodes[0].copy())
                        choice['ancestors'] = (0, 2)
                    else:
                        choice['node'] = SimpleNamespace(get_interfaces=lambda: [])
                    with self.assertRaisesRegex(DriverFailure, 'profession_geometry_invalid'):
                        desktop.select_profession(nodes, choice)
            run.assert_not_called()

    def test_mouse_failure_is_not_retried(self, *_):
        for error, code in [(subprocess.TimeoutExpired('private', 2), 'helper_timeout'),
                            (subprocess.CalledProcessError(1, 'private'), 'helper_failed')]:
            with self.subTest(code=code), patch('chatgpt_linux.subprocess.run', side_effect=error) as run:
                desktop, nodes, _ = self.setup_geometry()
                with self.assertRaisesRegex(DriverFailure, code):
                    desktop.select_profession(nodes, nodes[1])
                run.assert_called_once()


class RichTextTest(unittest.TestCase):
    """AT-SPI composer readback: exact, bounded, never guesses, never exports UI text."""

    def linked(self, value=''):
        desktop, editor_node, app = public_desktop()
        editor_node.role, editor_node.value = 'entry', '\ufffc'
        paragraph = PublicNode('private paragraph name', 'paragraph', editable=True, value=value)
        editor_node.children = [paragraph]
        paragraph.children = [PublicNode('private static name', 'static')]
        self.link(editor_node, 0, paragraph)
        return desktop, editor_node, paragraph

    def link(self, parent, offset, *children):
        if 'Hypertext' not in parent.interfaces:
            parent.interfaces.append('Hypertext')
        parent.links[offset] = SimpleNamespace(anchors=children)

    def structural(self, value='', static=False, hypertext=False):
        desktop, editor_node, paragraph = self.linked(value)
        editor_node.interfaces = ['Text', 'Hypertext'] if hypertext else ['Text']
        editor_node.links = {}
        if static:
            paragraph.value = '\ufffc'
            paragraph.children[0].name = value
        return desktop, editor_node, paragraph

    def read(self, desktop, editor_node, limit=None):
        return desktop.text({'node': editor_node}, limit=limit)

    def assert_unavailable(self, desktop, editor_node, limit=None):
        with self.assertRaisesRegex(DriverFailure, '^composer_text_unavailable$') as error:
            self.read(desktop, editor_node, limit)
        self.assertNotIn('private', str(error.exception))

    def no_names(self, *nodes):
        for item in nodes:
            item.get_name = Mock(side_effect=AssertionError('names are labels, not content'))

    def test_linked_paragraph_readback_is_exact_and_uses_unbound_text(self):
        for value in ('', 'single line', '  π 😀e\u0301\t\r\n\nExact.  \n', 'a\ufffcb'):
            with self.subTest(value=value):
                desktop, editor_node, paragraph = self.linked(value)
                paragraph.interfaces.append('Hypertext')  # Unlinked marker stays literal.
                self.no_names(editor_node, paragraph, paragraph.children[0])
                desktop.api.Text.get_text = Mock(wraps=desktop.api.Text.get_text)
                self.assertEqual(self.read(desktop, editor_node), value)
                self.assertEqual(desktop.api.Text.get_text.call_args_list,
                                 [call(editor_node, 0, 1), call(paragraph, 0, len(value))])
                desktop.api.Hyperlink.get_object.assert_called_once_with(editor_node.links[0], 0)

    def test_only_linked_markers_expand_at_character_offsets_with_reported_separators(self):
        desktop, editor_node, paragraph = self.linked('child')
        editor_node.value, editor_node.links = '😀\ufffc \n\ufffc\t', {}
        self.link(editor_node, 4, paragraph)
        self.assertEqual(self.read(desktop, editor_node), '😀\ufffc \nchild\t')
        self.assertEqual(desktop.api.Hypertext.get_link_index.call_args_list,
                         [call(editor_node, 1), call(editor_node, 4)])
        desktop.api.Hypertext.get_link.assert_called_once_with(editor_node, 4)
        desktop, editor_node, paragraph = self.linked('before\ufffcafter')
        child = PublicNode('private nested name', 'text', editable=True, value='inner\n')
        self.link(paragraph, 6, child)
        editor_node.value = '\ufffc\r\n\ufffc'
        self.link(editor_node, 3, child)
        self.assertEqual(self.read(desktop, editor_node), 'beforeinner\nafter\r\ninner\n')

    def test_bare_and_qualified_interfaces_in_snapshot_and_readback(self):
        for prefix in ('', 'org.a11y.atspi.'):
            with self.subTest(prefix=prefix):
                desktop, editor_node, paragraph = self.linked('exact')
                for item in (editor_node, paragraph):
                    item.interfaces = [prefix + name for name in item.interfaces + ['EditableText']]
                current = composer(desktop.snapshot())
                self.assertIs(current['node'], editor_node)
                self.assertTrue(current['textInterface'] and current['editableInterface'])
                self.assertEqual(desktop.text(current), 'exact')

    def test_structural_fallback_reads_one_owned_child_or_static_leaf(self):
        for hypertext in (False, True):
            for static in (False, True):
                for value in ('', '  π 😀e\u0301\r\n\nExact. \t\n', 'a\ufffcb'):
                    with self.subTest(hypertext=hypertext, static=static, value=value):
                        desktop, editor_node, paragraph = self.structural(value, static, hypertext)
                        if not static:
                            paragraph.role = 'text'
                            paragraph.states.discard('EDITABLE')
                            self.no_names(editor_node, paragraph)
                        self.assertEqual(self.read(desktop, editor_node), value)
                        desktop.api.Hypertext.get_link.assert_not_called()
        desktop, editor_node, paragraph = self.structural('name', static=True)
        leaf = paragraph.children[0]
        leaf.interfaces, leaf.value = ['Text'], 'actual Text value'
        self.no_names(leaf)
        self.assertEqual(self.read(desktop, editor_node), leaf.value)  # Text beats the name.
        desktop, editor_node, paragraph = self.linked('linked value')
        editor_node.children = [PublicNode('x', 'paragraph', editable=True, value='structural')]
        self.assertEqual(self.read(desktop, editor_node), 'linked value')  # Hypertext wins.

    def test_structural_never_guesses_order_ownership_or_literals(self):
        for value in ('literal', ' \ufffc', '\ufffc\n', '\ufffc\ufffc'):
            with self.subTest(value=value):
                desktop, editor_node, _ = self.structural('not content')
                editor_node.value = value
                self.assertEqual(self.read(desktop, editor_node), value)
        for hypertext in (False, True):
            for count in (0, 2):
                with self.subTest(hypertext=hypertext, count=count):
                    desktop, editor_node, paragraph = self.structural('', hypertext=hypertext)
                    editor_node.children = [paragraph] * count
                    editor_node.get_child_at_index = Mock(side_effect=AssertionError('no guessing'))
                    self.assertEqual(self.read(desktop, editor_node), '\ufffc')
        desktop, editor_node, _ = self.structural('not owned')
        editor_node.states.discard('EDITABLE')
        self.assertEqual(self.read(desktop, editor_node), '\ufffc')
        desktop, editor_node, paragraph = self.linked('\ufffc')
        editor_node.children = []  # A hyperlink alone does not establish ownership.
        self.no_names(paragraph.children[0])
        self.assertEqual(self.read(desktop, editor_node), '\ufffc')

    def test_unsafe_children_links_and_metadata_fail_without_reading_names(self):
        def role(kind):
            return lambda d, e, p: setattr(p, 'role', kind)
        def link_index(value):
            return lambda d, e, p: d.api.Hypertext.get_link_index.configure_mock(
                side_effect=None, return_value=value)
        def anchors(*children):
            return lambda d, e, p: self.link(e, 0, *children)
        cases = {'image': role('image'), 'password': role('password text'),
                 'no-text': lambda d, e, p: setattr(p, 'interfaces', []),
                 'no-text-iface': lambda d, e, p: setattr(p, 'get_text_iface', lambda: None),
                 'no-anchor': anchors(), 'none-anchor': anchors(None),
                 'two-anchors': anchors(PublicNode('private'), PublicNode('private')),
                 'none-link': lambda d, e, p: e.links.update({0: None}),
                 'cycle': lambda d, e, p: self.link(p, 0, e),
                 'bad-count': lambda d, e, p: setattr(d.api.Text, 'get_character_count',
                                                      Mock(return_value=-1)),
                 'huge-count': lambda d, e, p: setattr(d.api.Text, 'get_character_count',
                                                       Mock(return_value=INPUT_LIMIT + 1)),
                 'short-text': lambda d, e, p: setattr(d.api.Text, 'get_text',
                                                       Mock(return_value='private incomplete'))}
        cases.update({f'index-{v}': link_index(v) for v in (-2, None, 'private', True)})
        for kind, mutate in cases.items():
            with self.subTest(kind=kind):
                desktop, editor_node, paragraph = self.linked('\ufffc' if kind == 'cycle' else 'private')
                mutate(desktop, editor_node, paragraph)
                self.no_names(paragraph)
                self.assert_unavailable(desktop, editor_node)
        for kind in ('label', 'entry', 'static-not-leaf', 'hidden', 'bad-name', 'bad-child-count', 'rpc'):
            with self.subTest(structural=kind):
                desktop, editor_node, paragraph = self.structural('private', static=True)
                leaf = paragraph.children[0]
                if kind in ('label', 'entry'):
                    paragraph.role = kind
                elif kind == 'static-not-leaf':
                    leaf.children = [PublicNode('private')]
                elif kind == 'hidden':
                    leaf.states.discard('VISIBLE')
                elif kind == 'bad-name':
                    leaf.name = '\ud800'
                elif kind == 'bad-child-count':
                    editor_node.get_child_count = Mock(return_value=True)
                else:
                    editor_node.get_child_at_index = Mock(side_effect=FakeGLibError('private UI'))
                if kind != 'bad-name':
                    self.no_names(leaf)
                self.assert_unavailable(desktop, editor_node)

    def test_readback_limits_cycles_depth_nodes_bytes_and_deadline(self):
        # Node/depth budgets include the root and apply before a child is read.
        for budget in ('TEXT_NODE_LIMIT', 'TEXT_DEPTH_LIMIT'):
            for static in (False, True):
                with self.subTest(budget=budget, static=static):
                    desktop, editor_node, _ = self.structural('😀', static=static)
                    visits = 3 if static else 2
                    with patch('chatgpt_linux.' + budget, visits - 1):
                        self.assert_unavailable(desktop, editor_node)
                    with patch('chatgpt_linux.' + budget, visits):
                        self.assertEqual(self.read(desktop, editor_node), '😀')
                    # Source + expanded UTF-8 bytes share one caller limit.
                    total = 10 if static else 7
                    self.assertEqual(self.read(desktop, editor_node, limit=total), '😀')
                    self.assert_unavailable(desktop, editor_node, limit=total - 1)
        desktop, editor_node, paragraph = self.structural('\ufffc')
        current = paragraph
        for _ in range(16):
            child = PublicNode('private', 'paragraph', editable=True, value='\ufffc')
            current.children, current = [child], child
        self.assert_unavailable(desktop, editor_node)  # Depth, not recursion error.
        desktop, editor_node, paragraph = self.structural('\ufffc')
        paragraph.children = [paragraph]
        self.assert_unavailable(desktop, editor_node)  # Structural cycle.
        desktop, editor_node, _ = self.linked('😀')
        desktop.api.Text.get_text = Mock(wraps=desktop.api.Text.get_text)
        self.assert_unavailable(desktop, editor_node, limit=0)
        desktop.api.Text.get_text.assert_not_called()
        with patch('chatgpt_linux.INPUT_LIMIT', 6):
            self.assert_unavailable(desktop, editor_node, limit=100)  # Caller cannot raise the cap.
        desktop.deadline = 0
        with self.assertRaisesRegex(DriverFailure, '^deadline_exceeded$'):
            self.read(desktop, editor_node)

    def test_rpc_errors_never_expose_content_and_diagnostics_are_unreadable(self):
        for interface, method in (('Text', 'get_text'), ('Hypertext', 'get_link_index'),
                                  ('Hypertext', 'get_link'), ('Hyperlink', 'get_n_anchors'),
                                  ('Hyperlink', 'get_object')):
            with self.subTest(method=method):
                desktop, editor_node, _ = self.linked('private prompt')
                setattr(getattr(desktop.api, interface), method,
                        Mock(side_effect=FakeGLibError('private text and error')))
                self.assert_unavailable(desktop, editor_node)
                driver = Driver(desktop, 60_000, 24)
                driver.snapshot()
                receipt = driver.receipt('failed')
                self.assertEqual(set(receipt['draftState']), UNREADABLE)
                self.assertNotIn('private', json.dumps(receipt))

    def test_driver_uses_expanded_readback_for_setup_submit_and_diagnostics(self):
        for static in (False, True):
            for query, readback in [('', 'Ask anything here\n'), (PROMPT, PROMPT), (PROMPT, PROMPT + '\n')]:
                with self.subTest(static=static, query=query, readback=readback):
                    desktop, editor_node, paragraph = self.structural('prior draft', static=static)
                    target, field = (paragraph.children[0], 'name') if static else (paragraph, 'value')
                    desktop.require_helpers = Mock()
                    desktop.open_prompt = Mock(side_effect=lambda v, t=target, f=field, r=readback:
                                               setattr(t, f, r))
                    def send(control, allowed, d=desktop, e=editor_node, r=readback):
                        self.assertEqual(control['name'], 'Send')
                        self.assertEqual(self.read(d, e), r)
                    desktop.activate = Mock(side_effect=send)
                    desktop.api.Text.get_text = Mock(wraps=desktop.api.Text.get_text)
                    driver = Driver(desktop, 60_000, 24)
                    receipt = driver.submit(query, 'chatgpt-work') if query else driver.prepare('chatgpt-work')
                    self.assertEqual((receipt['status'], receipt['action_count']),
                                     ('submitted', 2) if query else ('ready', 1))
                    desktop.open_prompt.assert_called_once_with(query)
                    self.assertEqual(desktop.activate.call_count, 1 if query else 0)
                    if not query:
                        desktop.api.Text.get_text.assert_not_called()
                    state = driver.receipt('failed')['draftState']
                    self.assertEqual(state, readable_state(readback))

    @patch('chatgpt_linux.time.sleep')
    def test_unrecoverable_paragraph_separators_never_send(self, _sleep):
        for layout in ('structural-two-children', 'linked-no-separator'):
            with self.subTest(layout=layout):
                if layout == 'structural-two-children':
                    desktop, editor_node, _ = self.structural('first')
                    editor_node.children.append(PublicNode('private', 'paragraph', editable=True, value='second'))
                    expected = '\ufffc'
                else:
                    desktop, editor_node, _ = self.linked('first')
                    editor_node.value = '\ufffc\ufffc'
                    self.link(editor_node, 1, PublicNode('private', 'paragraph', editable=True, value='second'))
                    expected = 'firstsecond'
                desktop.require_helpers, desktop.open_prompt, desktop.activate = Mock(), Mock(), Mock()
                self.assertEqual(self.read(desktop, editor_node), expected)
                with self.assertRaisesRegex(DriverFailure, '^state_transition_unobserved$'):
                    Driver(desktop, 60_000, 24).submit('first\nsecond', 'chatgpt-work')
                desktop.open_prompt.assert_called_once_with('first\nsecond')
                desktop.activate.assert_not_called()


class AccessibilityTest(unittest.TestCase):
    def test_only_visible_enabled_editable_text_roles_authorize_a_composer(self):
        desktop, editor_node, _ = public_desktop()
        editor_node.value = PROMPT
        current = composer(desktop.snapshot())
        self.assertTrue(current['textInterface'])
        self.assertFalse(current['editableInterface'])  # Text alone suffices for readback.
        self.assertEqual(desktop.text(current), PROMPT)
        mutations = {'static': lambda e: e.states.remove('EDITABLE'),
                     'password': lambda e: setattr(e, 'role', 'password text'),
                     'wrong-role': lambda e: setattr(e, 'role', 'document web'),
                     'hidden': lambda e: e.states.remove('SHOWING'),
                     'disabled': lambda e: e.states.remove('SENSITIVE'),
                     'no-text': lambda e: setattr(e, 'interfaces', ['EditableText'])}
        for kind, mutate in mutations.items():
            with self.subTest(kind=kind):
                desktop, editor_node, _ = public_desktop()
                mutate(editor_node)
                with self.assertRaisesRegex(DriverFailure, 'composer_missing_or_ambiguous'):
                    composer(desktop.snapshot())

    def test_snapshot_flushes_events_within_budget_and_retries_only_reads(self):
        desktop, editor_node, _ = public_desktop()
        editor_node.states.remove('ENABLED')
        self.assertFalse(next(n for n in desktop.snapshot() if n['node'] is editor_node)['enabled'])
        desktop.context.events = [lambda: editor_node.states.update({'ENABLED', 'CHECKED'})]
        after = next(n for n in desktop.snapshot() if n['node'] is editor_node)
        self.assertTrue(after['enabled'] and after['selected'])
        self.assertEqual(desktop.context.iterations, 1)
        desktop.context = FakeGLibContext(busy=True)
        with self.assertRaisesRegex(DriverFailure, 'accessibility_event_budget'):
            desktop.snapshot()
        self.assertEqual(desktop.context.iterations, 256)
        desktop.context = FakeGLibContext([lambda: None] * 256)
        self.assertTrue(desktop.snapshot())
        with patch.object(desktop, '_snapshot', side_effect=[FakeGLibError('private'), []]) as snapshot:
            self.assertEqual(desktop.snapshot(), [])
            self.assertEqual(snapshot.call_count, 2)
        with patch.object(desktop, '_snapshot', side_effect=FakeGLibError('private')) as snapshot:
            with self.assertRaises(FakeGLibError):
                desktop.snapshot()
            self.assertEqual(snapshot.call_count, 3)

    def test_action_name_must_be_observed_unique_and_not_retried(self):
        desktop, _, _ = public_desktop()
        def target(names, error=None):
            action = SimpleNamespace(get_n_actions=lambda: len(names), get_action_name=lambda i: names[i],
                                     do_action=Mock(side_effect=error))
            return action, {'node': SimpleNamespace(get_action_iface=lambda: action)}
        for names in (['delete'], ['click', 'press']):
            action, control = target(names)
            with self.assertRaisesRegex(DriverFailure, 'action_missing_or_ambiguous'):
                desktop.activate(control, {'click', 'press'})
            action.do_action.assert_not_called()
        action, control = target(['click'], FakeGLibError('private'))
        with self.assertRaises(FakeGLibError):
            desktop.activate(control, {'click'})
        action.do_action.assert_called_once()

    def test_error_codes_match_contract_and_exceptions_map_to_static_codes(self):
        contract = json.loads((Path(__file__).parent / 'chatgpt_linux_contract.json').read_text())
        self.assertEqual(ERROR_CODES, frozenset(contract['errorCodes']))
        self.assertEqual(len(contract['errorCodes']), len(ERROR_CODES))
        source = (Path(__file__).parent / 'chatgpt_linux.py').read_text('utf-8')
        raised = set(re.findall(r"DriverFailure\('([a-z_]+)'\)", source))
        mapped = set(re.findall(r"return '(desktop_[a-z_]+)'", source))
        self.assertTrue(raised and mapped)
        self.assertLessEqual(raised | mapped, ERROR_CODES)
        self.assertIn('NO_AT_BRIDGE', SESSION_KEYS)
        self.assertFalse([key for key in SESSION_KEYS if key.startswith('MST_')])
        for error, code in [(AttributeError('private'), 'desktop_attribute_error'),
                            (TypeError('private'), 'desktop_type_error'),
                            (FakeGLibError('private'), 'desktop_glib_error'),
                            (DriverFailure('private'), 'desktop_driver_failed')]:
            self.assertEqual(error_code(error, FakeGLibError), code)
        self.assertEqual(error_code(FakeGLibError('private')), 'desktop_driver_failed')


if __name__ == '__main__':
    unittest.main()
