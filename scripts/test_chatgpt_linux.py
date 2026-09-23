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
        self.links = {}
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
        Text=SimpleNamespace(get_text=lambda node, start, end: node.value[start:end],
                             get_character_count=lambda node: len(node.value)),
        Hypertext=SimpleNamespace(
            get_link_index=Mock(side_effect=lambda node, offset: offset if offset in node.links else -1),
            get_link=Mock(side_effect=lambda node, index: node.links[index])),
        Hyperlink=SimpleNamespace(
            get_n_anchors=Mock(side_effect=lambda link: len(link.anchors)),
            get_object=Mock(side_effect=lambda link, index: link.anchors[index])))
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

    @patch('chatgpt_linux.time.sleep')
    def test_setup_controls_are_read_only_visible_role_allowlisted_and_bounded(self, _sleep):
        roles = ('button', 'push button', 'toggle button', 'radio button', 'menu item')
        desktop = FakeDesktop([
            node('private excluded', role) for role in
            ('frame', 'label', 'entry', 'text', 'paragraph', 'static', 'password text')
        ] + [node('hidden', visible=False), node('not showing', showing=False)] + [
            node('', 'button'), node('Loading', enabled=False, sensitive=False),
            *[node('Trust folder', role) for role in roles],
            *[node('Control ' + str(i)) for i in range(40)]])
        driver = self.driver(desktop)
        with self.assertRaisesRegex(DriverFailure, '^state_transition_unobserved$'):
            driver.prepare('codex')
        desktop.snapshot = Mock(side_effect=AssertionError('no new diagnostic snapshot'))
        desktop.text = Mock(side_effect=AssertionError('no editor or label reads'))
        diagnostic = driver.receipt('failed')['setupControls']
        self.assertIs(diagnostic['setupOnly'], True)
        self.assertEqual(len(diagnostic['controls']), 32)
        self.assertEqual(diagnostic['controls'][:2], [
            {'role': 'button', 'name': ''}, {'role': 'button', 'name': 'Loading'}])
        self.assertEqual([item['role'] for item in diagnostic['controls'][2:7]], list(roles))
        self.assertTrue(all(set(item) == {'role', 'name'} for item in diagnostic['controls']))
        self.assertNotIn('private', json.dumps(diagnostic))
        self.assertEqual(driver.actions, 0)
        self.assertEqual(desktop.actions, [])
        desktop.snapshot.assert_not_called()
        desktop.text.assert_not_called()

    @patch('chatgpt_linux.time.sleep')
    def test_setup_controls_redact_whole_private_names_before_truncation(self, _sleep):
        private = ['sk-test', 'BEARER secret', 'https://private.example/path',
                   'codex://new?prompt=secret', 'www.private.example', 'private.example',
                   'person@private.example', 'a' * 20, 'π' * 20,
                   'name\nsecret', 'name\tsecret', 'name\x00secret', 'name\x7fsecret',
                   'name\u0085secret', 'name\u200bsecret', 'name\u202esecret',
                   'name\u00a0secret', 'name\ud800secret',
                   'Safe label ' * 20 + 'sk-secret', 'Safe label ' * 500]
        desktop = FakeDesktop([node(value) for value in private] + [
            node('Open folder'), node('a' * 19), node('é 😀 ' * 40)])
        driver = self.driver(desktop)
        with self.assertRaises(DriverFailure):
            driver.prepare('codex')
        controls = driver.receipt('failed')['setupControls']['controls']
        self.assertEqual([item['name'] for item in controls[:len(private)]],
                         ['[redacted]'] * len(private))
        self.assertEqual([item['name'] for item in controls[len(private):]],
                         ['Open folder', 'a' * 19, ('é 😀 ' * 40)[:120]])
        self.assertEqual(desktop.actions, [])

    @patch('chatgpt_linux.time.sleep')
    def test_setup_controls_last_complete_snapshot_and_empty_snapshot(self, _sleep):
        for nodes in ([], [node('Trust folder')]):
            desktop = FakeDesktop(nodes)
            desktop.snapshot = Mock(side_effect=[nodes, FakeGLibError('private')])
            driver = self.driver(desktop)
            with self.assertRaises(FakeGLibError):
                driver.prepare('codex')
            self.assertEqual(driver.receipt('failed')['setupControls'], {
                'setupOnly': True,
                'controls': [{'role': 'button', 'name': 'Trust folder'}] if nodes else []})
            self.assertEqual(desktop.snapshot.call_count, 2)
            self.assertEqual(desktop.actions, [])
        driver = self.driver(FakeDesktop())
        driver.desktop.require_helpers = Mock(side_effect=DriverFailure('helper_missing'))
        with self.assertRaises(DriverFailure):
            driver.prepare('codex')
        self.assertNotIn('setupControls', driver.receipt('failed'))

    @patch('chatgpt_linux.time.sleep')
    def test_setup_controls_never_emitted_for_success_or_submit_even_after_prepare(self, _sleep):
        desktop = FakeDesktop([node('private query in control')])
        driver = self.driver(desktop)
        with self.assertRaises(DriverFailure):
            driver.prepare('codex')
        for status in ('ready', 'submitted'):
            self.assertNotIn('setupControls', driver.receipt(status))
        for prompt in (None, 'private query'):
            with self.assertRaises(DriverFailure):
                driver.submit(prompt, 'codex')
            receipt = driver.receipt('failed')
            self.assertNotIn('setupControls', receipt)
            self.assertNotIn('private query', json.dumps(receipt))
        self.assertEqual(desktop.actions, [])

    @patch('chatgpt_linux.time.sleep')
    def test_setup_controls_on_draft_modal_preserve_phase_step_and_draft_state(self, _sleep):
        desktop = FakeDesktop(ready('Codex'))
        def open_empty(prompt):
            desktop.actions.append(('open', prompt))
            desktop.nodes = [node('Trust folder'), node('Loading', enabled=False),
                             node('private content', 'paragraph')]
        desktop.open_prompt = open_empty
        driver = self.driver(desktop)
        with self.assertRaisesRegex(DriverFailure, '^state_transition_unobserved$'):
            driver.prepare('codex')
        receipt = driver.receipt('failed')
        self.assertEqual((receipt['phase'], receipt['step']), ('composer', 'draft-surface'))
        self.assertEqual(receipt['draftState'], {
            'observedSurface': 'unknown', 'composerRootCount': 0,
            'sendControlCount': 0, 'textReadable': False})
        self.assertEqual(receipt['setupControls']['controls'], [
            {'role': 'button', 'name': 'Trust folder'}, {'role': 'button', 'name': 'Loading'}])
        self.assertEqual(desktop.actions, [('open', '')])
        self.assertNotIn('private', json.dumps(receipt))

    @patch('chatgpt_linux.time.sleep')
    def test_main_emits_setup_assertion_only_on_failed_prepare(self, _sleep):
        for mode in ('prepare', 'submit'):
            desktop = FakeDesktop([node('Loading'), node('sk-private'),
                                   node('https://private.example'), node('person@private.example'),
                                   node('private content', 'paragraph')])
            payload = json.dumps({'surface': 'codex', 'prompt': 'private prompt'}).encode()
            with patch('chatgpt_linux.Desktop', return_value=desktop), \
                    patch('sys.argv', ['driver', '--mode', mode, '--timeout-ms', '60000']), \
                    patch('sys.stdin', SimpleNamespace(buffer=io.BytesIO(payload))), \
                    patch('sys.stdout', new_callable=io.StringIO) as output:
                self.assertEqual(main(), 1)
            receipt = json.loads(output.getvalue())
            self.assertEqual(receipt['status'], 'failed')
            self.assertNotIn('private', output.getvalue())
            if mode == 'prepare':
                self.assertEqual(receipt['error'], 'state_transition_unobserved')
                self.assertEqual(receipt['phase'], 'waiting-for-initial-ui')
                self.assertEqual(receipt['setupControls'], {
                    'setupOnly': True, 'controls': [
                        {'role': 'button', 'name': 'Loading'},
                        *[{'role': 'button', 'name': '[redacted]'} for _ in range(3)]]})
            else:
                self.assertEqual(receipt['error'], 'surface_mismatch')
                self.assertNotIn('setupControls', receipt)
                self.assertNotIn('Loading', output.getvalue())
            self.assertEqual(desktop.actions, [])

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

    def test_setup_placeholder_is_ready_without_text_read_or_send(self):
        for surface, label in [('chatgpt-work', 'ChatGPT Work'), ('codex', 'Codex')]:
            desktop = FakeDesktop(ready(label))
            def open_empty(prompt):
                desktop.actions.append(('open', prompt))
                desktop.nodes = ready('ChatGPT Work', 'Ask anything here\n')
                desktop.nodes[1]['enabled'] = False
            desktop.open_prompt = open_empty
            desktop.text = Mock(side_effect=AssertionError('setup has no prompt to read back'))
            # Fake mode selection must also avoid reading placeholder content.
            desktop.preserve_draft = False
            receipt = self.driver(desktop).prepare(surface)
            self.assertEqual(receipt['status'], 'ready')
            self.assertEqual(receipt['surface'], surface)
            self.assertEqual(set(receipt), {'status', 'surface', 'action_count', 'duration_ms'})
            self.assertEqual(desktop.actions[0], ('open', ''))
            self.assertEqual(self.actions(desktop).count('open'), 1)
            self.assertEqual(self.actions(desktop).count('Send'), 0)
            self.assertEqual(receipt['action_count'], 1 if surface == 'chatgpt-work' else 3)
            desktop.text.assert_not_called()

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

    def test_exact_or_one_native_terminal_lf_preserves_opener_payload(self):
        for prompt in ('Find docs', '  π 😀e\u0301\n\nExact.  \n', 'π\n\n'):
            for suffix in ('', '\n'):
                for corrected in (False, True):
                    with self.subTest(prompt=prompt, suffix=suffix, corrected=corrected):
                        desktop = FakeDesktop()
                        original = desktop.open_prompt
                        def open_prompt(value):
                            original(value)
                            composer(desktop.nodes)['text'] = value + suffix
                        desktop.open_prompt = open_prompt
                        desktop.open_surface = 'Codex' if corrected else None
                        receipt = self.driver(desktop).submit(prompt, 'chatgpt-work')
                        self.assertEqual(receipt['status'], 'submitted')
                        self.assertEqual(receipt['action_count'], 4 if corrected else 2)
                        self.assertEqual(desktop.actions[0], ('open', prompt))
                        self.assertEqual(desktop.actions[0][1].encode('utf-8'), prompt.encode('utf-8'))
                        self.assertEqual(self.actions(desktop).count('open'), 1)
                        self.assertEqual(self.actions(desktop).count('Send'), 1)
                        self.assertEqual(composer(desktop.nodes)['text'], prompt + suffix)

    @patch('chatgpt_linux.time.sleep')
    def test_draft_mismatch_blocks_before_and_after_mode_correction(self, _sleep):
        prompt = '  π 😀e\u0301\nExact.  \n'
        mismatches = [prompt + '\n\n', prompt + '\n\n\n', 'prefix' + prompt,
                      prompt + 'suffix', prompt.strip(), prompt.lstrip(), prompt.rstrip(),
                      prompt[:-1], prompt + '\r\n', prompt.replace('\n', ''), '']
        for text in mismatches:
            for after_correction in (False, True):
                with self.subTest(text=text, after_correction=after_correction):
                    desktop = FakeDesktop()
                    desktop.open_surface = 'Codex'
                    original_open, original_activate = desktop.open_prompt, desktop.activate
                    def open_prompt(value):
                        original_open(value)
                        composer(desktop.nodes)['text'] = value + '\n' if after_correction else text
                    def activate(control, allowed):
                        original_activate(control, allowed)
                        if control['name'] == 'ChatGPT Work Create, learn, and explore':
                            composer(desktop.nodes)['text'] = text
                    desktop.open_prompt, desktop.activate = open_prompt, activate
                    driver = self.driver(desktop)
                    with self.assertRaisesRegex(DriverFailure, 'state_transition_unobserved'):
                        driver.submit(prompt, 'chatgpt-work')
                    expected = ['open', 'Switch mode, current mode: Codex',
                                'ChatGPT Work Create, learn, and explore'] if after_correction else ['open']
                    self.assertEqual(self.actions(desktop), expected)
                    self.assertEqual(desktop.actions[0], ('open', prompt))
                    self.assertEqual(driver.step, 'draft-readback' if after_correction else 'draft-surface')

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

    def test_setup_ready_does_not_claim_nonempty_text_became_empty(self):
        desktop = FakeDesktop(ready(text='prior draft'))
        desktop.stall = 'open'
        desktop.text = Mock(side_effect=AssertionError('no setup emptiness predicate'))
        receipt = self.driver(desktop).prepare('chatgpt-work')
        self.assertEqual(receipt['status'], 'ready')
        self.assertNotIn('draftState', receipt)
        self.assertEqual(desktop.actions, [('open', '')])
        self.assertEqual(composer(desktop.nodes)['text'], 'prior draft')
        desktop.text.assert_not_called()

    @patch('chatgpt_linux.time.sleep')
    def test_setup_still_requires_surface_unique_composer_and_send_after_open(self, _sleep):
        for kind in ('surface', 'composer-missing', 'composer-ambiguous', 'send-missing', 'send-ambiguous'):
            with self.subTest(kind=kind):
                desktop = FakeDesktop()
                def open_empty(prompt):
                    desktop.actions.append(('open', prompt))
                    desktop.nodes = ready(text='Ask anything here\n')
                    if kind == 'surface':
                        desktop.nodes[0]['name'] = 'unknown mode'
                    elif kind == 'composer-missing':
                        desktop.nodes.pop()
                    elif kind == 'composer-ambiguous':
                        desktop.nodes.append(node('other', 'entry', editable=True))
                    elif kind == 'send-missing':
                        desktop.nodes.pop(1)
                    else:
                        desktop.nodes.append(node('Send'))
                desktop.open_prompt = open_empty
                with self.assertRaises(DriverFailure):
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


class RichTextTest(unittest.TestCase):
    def linked(self, value=''):
        desktop, editor, app = public_desktop()
        editor.role, editor.value = 'entry', '\ufffc'
        paragraph = PublicNode('private paragraph name', 'paragraph', editable=True)
        paragraph.value = value
        editor.children = [paragraph]
        paragraph.children = [PublicNode('private static name', 'static')]
        self.link(editor, 0, paragraph)
        return desktop, editor, paragraph, app

    def link(self, parent, offset, *children):
        if 'Hypertext' not in parent.interfaces:
            parent.interfaces.append('Hypertext')
        parent.links[offset] = SimpleNamespace(anchors=children)

    def read(self, desktop, editor, limit=None):
        return desktop.text({'node': editor}, limit=limit)

    def assert_unavailable(self, desktop, editor, limit=None):
        with self.assertRaisesRegex(DriverFailure, '^composer_text_unavailable$') as error:
            self.read(desktop, editor, limit)
        self.assertNotIn('private', str(error.exception))

    def structural(self, value='', static=False, hypertext=False):
        desktop, editor, paragraph, app = self.linked(value)
        editor.interfaces = ['Text', 'Hypertext'] if hypertext else ['Text']
        editor.links = {}
        if static:
            paragraph.value = '\ufffc'
            paragraph.children[0].name = value
        return desktop, editor, paragraph, app

    def test_structural_single_paragraph_empty_and_exact_unicode(self):
        for hypertext in (False, True):
            for role in ('paragraph', 'text'):
                for value in ('', '  π 😀e\u0301\t\r\n\nExact.  \n'):
                    desktop, editor, paragraph, _ = self.structural(value, hypertext=hypertext)
                    paragraph.role = role
                    paragraph.states.discard('EDITABLE')
                    editor.get_name = paragraph.get_name = Mock(side_effect=AssertionError('no labels'))
                    desktop.api.Text.get_text = Mock(wraps=desktop.api.Text.get_text)
                    self.assertEqual(self.read(desktop, editor), value)
                    self.assertEqual(desktop.api.Text.get_text.call_args_list, [
                        unittest.mock.call(editor, 0, 1),
                        unittest.mock.call(paragraph, 0, len(value))])
                    desktop.api.Hypertext.get_link.assert_not_called()

    def test_structural_static_leaf_exact_content_only_under_paragraph(self):
        for role in ('static', 'static text'):
            for value in ('', '  π 😀\r\n\nExact. \t\n', '\ufffc', 'a\ufffcb'):
                desktop, editor, paragraph, _ = self.structural(value, static=True)
                paragraph.children[0].role = role
                editor.get_name = paragraph.get_name = Mock(side_effect=AssertionError('no labels'))
                self.assertEqual(self.read(desktop, editor), value)
        desktop, editor, paragraph, _ = self.structural('name', static=True)
        leaf = paragraph.children[0]
        leaf.interfaces, leaf.value = ['Text'], 'actual Text value'
        leaf.get_name = Mock(side_effect=AssertionError('Text is preferred'))
        self.assertEqual(self.read(desktop, editor), leaf.value)

    def test_structural_never_changes_nonmarker_literals_or_guesses_child_order(self):
        for value in ('', 'literal', ' \ufffc', '\ufffc\n', '\ufffc\ufffc', 'a\ufffcb'):
            desktop, editor, _, _ = self.structural('not content')
            editor.value = value
            editor.get_child_count = Mock(side_effect=AssertionError('no traversal'))
            self.assertEqual(self.read(desktop, editor), value)
            editor.get_child_count.assert_not_called()
        for hypertext in (False, True):
            for count in (0, 2):
                desktop, editor, paragraph, _ = self.structural('', hypertext=hypertext)
                editor.children = [paragraph] * count
                editor.get_child_at_index = Mock(side_effect=AssertionError('no guessing'))
                self.assertEqual(self.read(desktop, editor), '\ufffc')
                editor.get_child_at_index.assert_not_called()

    def test_structural_rejects_unsafe_children_without_reading_names(self):
        for role in ('image', 'password text', 'label', 'button', 'static', 'entry'):
            for text_iface in (False, True):
                desktop, editor, paragraph, _ = self.structural('private')
                paragraph.role = role
                paragraph.interfaces = ['Text'] if text_iface else []
                paragraph.get_name = Mock(side_effect=AssertionError('no labels'))
                self.assert_unavailable(desktop, editor)
                paragraph.get_name.assert_not_called()
        for kind in ('no-text', 'no-text-iface', 'static-not-leaf', 'hidden', 'not-showing'):
            desktop, editor, paragraph, _ = self.structural('private', static=True)
            leaf = paragraph.children[0]
            leaf.get_name = Mock(side_effect=AssertionError('no labels'))
            if kind == 'no-text':
                paragraph.interfaces = []
            elif kind == 'no-text-iface':
                paragraph.get_text_iface = lambda: None
            elif kind == 'static-not-leaf':
                leaf.children = [PublicNode('private')]
            else:
                leaf.states.discard('VISIBLE' if kind == 'hidden' else 'SHOWING')
            self.assert_unavailable(desktop, editor)
            leaf.get_name.assert_not_called()

    def test_structural_requires_owned_editable_root_and_does_not_extend_link_targets(self):
        desktop, editor, _, _ = self.structural('not owned')
        editor.states.discard('EDITABLE')
        self.assertEqual(self.read(desktop, editor), '\ufffc')
        desktop, editor, paragraph, _ = self.linked('\ufffc')
        # A hyperlink alone does not establish direct composer-tree ownership.
        editor.children = []
        paragraph.children[0].get_name = Mock(side_effect=AssertionError('outside tree'))
        self.assertEqual(self.read(desktop, editor), '\ufffc')
        paragraph.children[0].get_name.assert_not_called()

    def test_structural_hypertext_reference_remains_preferred(self):
        desktop, editor, paragraph, _ = self.linked('linked value')
        alternative = PublicNode('not a label', 'paragraph', editable=True)
        alternative.value = 'different structural value'
        editor.children = [alternative]
        editor.get_child_count = Mock(side_effect=AssertionError('link wins'))
        self.assertEqual(self.read(desktop, editor), paragraph.value)
        editor.get_child_count.assert_not_called()

    def test_structural_cycles_depth_node_and_utf8_budgets(self):
        desktop, editor, paragraph, _ = self.structural('\ufffc')
        paragraph.children = [paragraph]
        self.assert_unavailable(desktop, editor)
        for static in (False, True):
            visits = 3 if static else 2
            for budget in ('TEXT_NODE_LIMIT', 'TEXT_DEPTH_LIMIT'):
                desktop, editor, _, _ = self.structural('😀', static=static)
                with patch('chatgpt_linux.' + budget, visits - 1):
                    self.assert_unavailable(desktop, editor)
                with patch('chatgpt_linux.' + budget, visits):
                    self.assertEqual(self.read(desktop, editor), '😀')
            total = 10 if static else 7
            self.assertEqual(self.read(desktop, editor, limit=total), '😀')
            self.assert_unavailable(desktop, editor, limit=total - 1)
        desktop, editor, paragraph, _ = self.structural('\ufffc')
        current = paragraph
        for _ in range(16):
            child = PublicNode('private', 'paragraph', editable=True)
            child.value = '\ufffc'
            current.children, current = [child], child
        self.assert_unavailable(desktop, editor)

    def test_structural_invalid_metadata_and_private_rpc_failures(self):
        for count in (-1, True, None, 'private'):
            desktop, editor, _, _ = self.structural('')
            editor.get_child_count = Mock(return_value=count)
            self.assert_unavailable(desktop, editor)
        for value in (None, 1, '\ud800'):
            desktop, editor, paragraph, _ = self.structural('', static=True)
            paragraph.children[0].name = value
            self.assert_unavailable(desktop, editor)
        for method in ('get_child_count', 'get_child_at_index', 'get_role_name'):
            desktop, editor, _, _ = self.structural('')
            setattr(editor, method, Mock(side_effect=FakeGLibError('private UI content')))
            self.assert_unavailable(desktop, editor)

    def test_structural_prepare_placeholder_and_submit_readback_do_not_export_content(self):
        prompt = '  π 😀\n\nExact.  \n'
        for static in (False, True):
            for query, readback in [('', 'Ask anything here\n'), (prompt, prompt), (prompt, prompt + '\n')]:
                desktop, editor, paragraph, _ = self.structural('prior draft', static=static)
                target, field = (paragraph.children[0], 'name') if static else (paragraph, 'value')
                desktop.require_helpers = Mock()
                desktop.open_prompt = Mock(side_effect=lambda value: setattr(target, field, readback))
                desktop.activate = Mock()
                desktop.api.Text.get_text = Mock(wraps=desktop.api.Text.get_text)
                driver = Driver(desktop, 60_000, 24)
                receipt = (driver.submit(query, 'chatgpt-work') if query
                           else driver.prepare('chatgpt-work'))
                self.assertEqual(receipt['status'], 'submitted' if query else 'ready')
                desktop.open_prompt.assert_called_once_with(query)
                self.assertEqual(desktop.activate.call_count, 1 if query else 0)
                if not query:
                    desktop.api.Text.get_text.assert_not_called()
                    self.assertEqual(len(readback), 18)
                    self.assertEqual(readback.count('\n'), 1)
                state = driver.receipt('failed')['draftState']
                self.assertEqual(state['textLength'], len(readback))
                self.assertEqual(state['textSha256'], hashlib.sha256(readback.encode('utf-8')).hexdigest())
                self.assertNotIn('Exact', json.dumps(state))
                self.assertNotIn('Ask anything', json.dumps(state))

    @patch('chatgpt_linux.time.sleep')
    def test_structural_ambiguous_paragraphs_never_send(self, _sleep):
        desktop, editor, paragraph, _ = self.structural('first')
        other = PublicNode('private second', 'paragraph', editable=True)
        other.value = 'second'
        editor.children.append(other)
        desktop.require_helpers, desktop.open_prompt, desktop.activate = Mock(), Mock(), Mock()
        self.assertEqual(self.read(desktop, editor), '\ufffc')
        with self.assertRaisesRegex(DriverFailure, '^state_transition_unobserved$'):
            Driver(desktop, 60_000, 24).submit('first\nsecond', 'chatgpt-work')
        desktop.open_prompt.assert_called_once_with('first\nsecond')
        desktop.activate.assert_not_called()

    def test_empty_embedded_paragraph_is_exact_empty_not_its_static_child_name(self):
        desktop, editor, paragraph, _ = self.linked()
        editor.get_name = paragraph.get_name = Mock(side_effect=AssertionError('no names'))
        self.assertEqual(self.read(desktop, editor), '')
        desktop.api.Hypertext.get_link_index.assert_called_once_with(editor, 0)
        desktop.api.Hypertext.get_link.assert_called_once_with(editor, 0)
        desktop.api.Hyperlink.get_object.assert_called_once_with(editor.links[0], 0)

    def test_one_paragraph_preserves_unicode_whitespace_multiline_and_literal_marker(self):
        for value in ('single line', '  π 😀e\u0301\t\r\n\nExact.  \n', '\ufffc', 'a\ufffcb'):
            with self.subTest(value=value):
                desktop, editor, paragraph, _ = self.linked(value)
                paragraph.interfaces.append('Hypertext')
                self.assertEqual(self.read(desktop, editor), value)
                if '\ufffc' in value:
                    desktop.api.Hypertext.get_link_index.assert_any_call(paragraph, value.index('\ufffc'))

    def test_root_and_child_bound_get_text_collisions_are_never_called(self):
        desktop, editor, paragraph, _ = self.linked('π😀\n')
        editor.get_text = paragraph.get_text = Mock(side_effect=TypeError('private collision'))
        desktop.api.Text.get_text = Mock(wraps=desktop.api.Text.get_text)
        self.assertEqual(self.read(desktop, editor), paragraph.value)
        self.assertEqual(desktop.api.Text.get_text.call_args_list,
                         [unittest.mock.call(editor, 0, 1), unittest.mock.call(paragraph, 0, 3)])
        editor.get_text.assert_not_called()

    def test_bare_and_qualified_interfaces_support_snapshot_and_expansion(self):
        for prefix in ('', 'org.a11y.atspi.'):
            desktop, editor, paragraph, _ = self.linked('exact')
            for item in (editor, paragraph):
                item.interfaces.append('EditableText')
                item.interfaces = [prefix + name for name in item.interfaces]
            current = composer(desktop.snapshot())
            self.assertIs(current['node'], editor)
            self.assertTrue(current['textInterface'])
            self.assertTrue(current['editableInterface'])
            self.assertEqual(desktop.text(current), 'exact')

    def test_only_linked_markers_expand_at_unicode_character_offsets(self):
        desktop, editor, paragraph, _ = self.linked('child')
        editor.value = '😀\ufffc \n\ufffc\t'
        editor.links = {}
        self.link(editor, 4, paragraph)
        self.assertEqual(self.read(desktop, editor), '😀\ufffc \nchild\t')
        self.assertEqual(desktop.api.Hypertext.get_link_index.call_args_list,
                         [unittest.mock.call(editor, 1), unittest.mock.call(editor, 4)])
        desktop.api.Hypertext.get_link.assert_called_once_with(editor, 4)

    def test_unlinked_markers_remain_literal_with_or_without_hypertext(self):
        for hypertext in (False, True):
            desktop, editor, _ = public_desktop()
            editor.value = '\ufffc\n\ufffc'
            editor.children = [PublicNode('private child', 'paragraph', editable=True)]
            if hypertext:
                editor.interfaces.append('Hypertext')
            self.assertEqual(self.read(desktop, editor), editor.value)
            desktop.api.Hypertext.get_link.assert_not_called()
            desktop.api.Hyperlink.get_object.assert_not_called()

    def test_nested_links_preserve_reported_separators_only(self):
        desktop, editor, paragraph, _ = self.linked('before\ufffcafter')
        child = PublicNode('private nested name', 'text', editable=True)
        child.value = 'inner\n'
        self.link(paragraph, 6, child)
        self.assertEqual(self.read(desktop, editor), 'beforeinner\nafter')
        editor.value = '\ufffc\r\n\ufffc'
        self.link(editor, 3, child)
        self.assertEqual(self.read(desktop, editor), 'beforeinner\nafter\r\ninner\n')

    def test_direct_and_nested_cycles_fail(self):
        for nested in (False, True):
            desktop, editor, paragraph, _ = self.linked('\ufffc')
            self.link(paragraph if nested else editor, 0, editor)
            self.assert_unavailable(desktop, editor)

    def test_ambiguous_missing_or_invalid_links_fail_without_reading_children(self):
        for anchors in ((), (None,), (PublicNode('private'), PublicNode('private'))):
            desktop, editor, _, _ = self.linked()
            self.link(editor, 0, *anchors)
            self.assert_unavailable(desktop, editor)
        for index in (-2, None, 'private', True):
            desktop, editor, _, _ = self.linked()
            desktop.api.Hypertext.get_link_index.return_value = index
            desktop.api.Hypertext.get_link_index.side_effect = None
            self.assert_unavailable(desktop, editor)
            desktop.api.Hypertext.get_link.assert_not_called()
        desktop, editor, _, _ = self.linked()
        editor.links[0] = None
        self.assert_unavailable(desktop, editor)

    def test_image_password_and_nontext_children_fail_never_read_names(self):
        for kind in ('image', 'password text', 'no-text', 'no-text-iface'):
            desktop, editor, paragraph, _ = self.linked('private text')
            if kind == 'no-text':
                paragraph.interfaces = []
            elif kind == 'no-text-iface':
                paragraph.get_text_iface = lambda: None
            else:
                paragraph.role = kind
            paragraph.get_name = Mock(side_effect=AssertionError('no names'))
            desktop.api.Text.get_text = Mock(wraps=desktop.api.Text.get_text)
            self.assert_unavailable(desktop, editor)
            desktop.api.Text.get_text.assert_called_once_with(editor, 0, 1)
            paragraph.get_name.assert_not_called()

    def test_node_and_depth_budgets_include_root_and_bound_before_child_read(self):
        for budget in ('TEXT_NODE_LIMIT', 'TEXT_DEPTH_LIMIT'):
            desktop, editor, _, _ = self.linked('exact')
            desktop.api.Text.get_text = Mock(wraps=desktop.api.Text.get_text)
            with patch('chatgpt_linux.' + budget, 1):
                self.assert_unavailable(desktop, editor)
                desktop.api.Text.get_text.assert_called_once_with(editor, 0, 1)
            with patch('chatgpt_linux.' + budget, 2):
                self.assertEqual(self.read(desktop, editor), 'exact')
        desktop, editor, paragraph, _ = self.linked('x')
        editor.value = '\ufffc\ufffc'
        self.link(editor, 1, paragraph)
        with patch('chatgpt_linux.TEXT_NODE_LIMIT', 2):
            self.assert_unavailable(desktop, editor)

    def test_utf8_and_cumulative_source_byte_budgets_apply_to_all_reads(self):
        desktop, editor, paragraph, _ = self.linked('😀')
        self.assertEqual(self.read(desktop, editor, limit=7), '😀')
        self.assert_unavailable(desktop, editor, limit=6)
        paragraph.value = 'abcd'
        self.assert_unavailable(desktop, editor, limit=6)
        desktop.api.Text.get_text = Mock(wraps=desktop.api.Text.get_text)
        self.assert_unavailable(desktop, editor, limit=0)
        desktop.api.Text.get_text.assert_not_called()
        with patch('chatgpt_linux.INPUT_LIMIT', 6):
            self.assert_unavailable(desktop, editor)
            self.assert_unavailable(desktop, editor, limit=100)
        desktop, editor, _ = public_desktop()
        editor.value = '😀'
        self.assertEqual(self.read(desktop, editor, limit=4), '😀')
        self.assert_unavailable(desktop, editor, limit=3)

    def test_invalid_counts_and_incomplete_or_invalid_text_fail(self):
        for count in (-1, True, 'private', INPUT_LIMIT + 1):
            desktop, editor, _ = public_desktop()
            desktop.api.Text.get_character_count = Mock(return_value=count)
            desktop.api.Text.get_text = Mock()
            self.assert_unavailable(desktop, editor)
            desktop.api.Text.get_text.assert_not_called()
        for value in (None, 1, 'private incomplete', '\ud800'):
            desktop, editor, _ = public_desktop()
            desktop.api.Text.get_character_count = Mock(return_value=1)
            desktop.api.Text.get_text = Mock(return_value=value)
            self.assert_unavailable(desktop, editor)

    def test_rpc_errors_never_expose_content_and_diagnostics_are_unreadable(self):
        for interface, method in (('Text', 'get_text'), ('Hypertext', 'get_link_index'),
                                  ('Hypertext', 'get_link'), ('Hyperlink', 'get_n_anchors'),
                                  ('Hyperlink', 'get_object')):
            desktop, editor, _, _ = self.linked('private prompt')
            setattr(getattr(desktop.api, interface), method,
                    Mock(side_effect=FakeGLibError('private text and error')))
            self.assert_unavailable(desktop, editor)
            driver = Driver(desktop, 60_000, 24)
            driver.snapshot()
            receipt = driver.receipt('failed')
            self.assertFalse(receipt['draftState']['textReadable'])
            self.assertNotIn('textSha256', receipt['draftState'])
            self.assertNotIn('private', json.dumps(receipt))

    def test_expansion_checks_deadline(self):
        desktop, editor, _, _ = self.linked('exact')
        desktop.deadline = 0
        with self.assertRaisesRegex(DriverFailure, '^deadline_exceeded$'):
            self.read(desktop, editor)
        desktop.api.Hypertext.get_link.assert_not_called()

    def test_failure_diagnostics_measure_expanded_text_not_root_marker(self):
        for value in ('', '  π 😀\n\ufffc\t'):
            desktop, _, _, _ = self.linked(value)
            driver = Driver(desktop, 60_000, 24)
            driver.snapshot()
            state = driver.receipt('failed')['draftState']
            self.assertEqual(state, {
                'observedSurface': 'chatgpt-work', 'composerRootCount': 1,
                'sendControlCount': 1, 'textReadable': True, 'textLength': len(value),
                'textSha256': hashlib.sha256(value.encode('utf-8')).hexdigest(),
                'embeddedObjectCount': value.count('\ufffc'), 'newlineCount': value.count('\n')})

    def test_empty_paragraph_passes_prepare_and_exact_paragraph_sends_once(self):
        for prompt in ('', 'single line', '  π 😀\n\nExact.  \n'):
            desktop, editor, paragraph, _ = self.linked('prior draft')
            desktop.require_helpers = Mock()
            desktop.open_prompt = Mock(side_effect=lambda value: setattr(paragraph, 'value', value))
            def send(control, allowed):
                self.assertEqual(control['name'], 'Send')
                self.assertEqual(self.read(desktop, editor), prompt)
            desktop.activate = Mock(side_effect=send)
            driver = Driver(desktop, 60_000, 24)
            receipt = (driver.submit(prompt, 'chatgpt-work') if prompt
                       else driver.prepare('chatgpt-work'))
            self.assertEqual(receipt['status'], 'submitted' if prompt else 'ready')
            self.assertEqual(receipt['action_count'], 2 if prompt else 1)
            desktop.open_prompt.assert_called_once_with(prompt)
            self.assertEqual(desktop.activate.call_count, 1 if prompt else 0)

    @patch('chatgpt_linux.time.sleep')
    def test_missing_paragraph_separators_never_guessed_or_sent(self, _sleep):
        desktop, editor, _, _ = self.linked('first')
        other = PublicNode('private second', 'paragraph', editable=True)
        other.value = 'second'
        editor.value = '\ufffc\ufffc'
        self.link(editor, 1, other)
        desktop.require_helpers, desktop.open_prompt, desktop.activate = Mock(), Mock(), Mock()
        self.assertEqual(self.read(desktop, editor), 'firstsecond')
        driver = Driver(desktop, 60_000, 24)
        with self.assertRaisesRegex(DriverFailure, '^state_transition_unobserved$'):
            driver.submit('first\nsecond', 'chatgpt-work')
        desktop.open_prompt.assert_called_once_with('first\nsecond')
        desktop.activate.assert_not_called()


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
