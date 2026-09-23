#!/usr/bin/env python3
"""Bounded ChatGPT AT-SPI setup/submission. Caller owns login and desktop lifecycle.

No inference API, shell, arbitrary keyboard input, answer extraction, or action retry.
Input is JSON on stdin; output contains only a fixed receipt, never UI/query text.
"""
from __future__ import annotations

import argparse
import json
import os
import selectors
import subprocess
import sys
import time


class DriverFailure(RuntimeError):
    pass


BUTTONS = {'button', 'push button'}
SURFACES = {'chatgpt-work': 'ChatGPT Work', 'codex': 'Codex'}
MENU_LABELS = {'chatgpt-work': 'ChatGPT Work Create, learn, and explore',
               'codex': 'Codex Build, debug, and ship'}
EDITOR_ROLES = {'entry', 'text', 'text area', 'editable text', 'paragraph'}
XCLIP = '/usr/bin/xclip'
XDOTOOL = '/usr/bin/xdotool'
GLIB_ERROR = ()
ERROR_CODES = frozenset({
    'accessibility_event_budget', 'accessibility_tree_budget', 'desktop_ambiguous',
    'action_unavailable', 'action_missing_or_ambiguous', 'action_acknowledgement_uncertain',
    'composer_text_unavailable', 'fill_acknowledgement_uncertain',
    'composer_missing_or_ambiguous', 'new_chat_missing_or_ambiguous',
    'deadline_exceeded', 'action_budget_exhausted', 'state_transition_unobserved',
    'send_missing_or_ambiguous', 'invalid_surface', 'profession_ambiguous',
    'continue_missing_or_ambiguous', 'skip_missing_or_ambiguous',
    'intro_confirmation_ambiguous', 'mode_missing_or_ambiguous', 'surface_item_ambiguous',
    'invalid_prompt', 'surface_mismatch', 'invalid_budget', 'input_too_large', 'invalid_input',
    'helper_missing', 'helper_failed', 'helper_timeout', 'clipboard_unavailable',
    'focus_failed', 'composer_not_empty', 'desktop_attribute_error', 'desktop_type_error',
    'desktop_glib_error', 'desktop_driver_failed',
})


def error_code(error):
    if isinstance(error, DriverFailure) and str(error) in ERROR_CODES:
        return str(error)
    if isinstance(error, AttributeError):
        return 'desktop_attribute_error'
    if isinstance(error, TypeError):
        return 'desktop_type_error'
    if isinstance(error, GLIB_ERROR):
        return 'desktop_glib_error'
    return 'desktop_driver_failed'


class Desktop:
    def __init__(self):
        import gi
        gi.require_version('Atspi', '2.0')
        from gi.repository import Atspi, GLib
        global GLIB_ERROR
        GLIB_ERROR = GLib.Error
        self.glib_error = GLib.Error
        self.api = Atspi
        self.context = GLib.MainContext.default()
        self.clipboard = None
        self.deadline = float('inf')

    def require_helpers(self):
        if not all(os.path.isfile(path) and os.access(path, os.X_OK)
                   for path in (XCLIP, XDOTOOL)):
            raise DriverFailure('helper_missing')

    def remaining(self, cap=2):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise DriverFailure('deadline_exceeded')
        return min(cap, remaining)

    def snapshot(self):
        # Retry only a read-only traversal, discarding every partial tree.
        for attempt in range(3):
            try:
                return self._snapshot()
            except getattr(self, 'glib_error', ()):
                if attempt == 2:
                    raise
                self.remaining()

    def _snapshot(self):
        # AT-SPI cache invalidation runs on the default GLib context. Never
        # authorize actions from a snapshot while that event queue is still busy.
        for _ in range(256):
            if not self.context.pending():
                break
            self.context.iteration(False)
        if self.context.pending():
            raise DriverFailure('accessibility_event_budget')
        root = self.api.get_desktop(0)
        apps = [root.get_child_at_index(i) for i in range(min(root.get_child_count(), 128))]
        apps = [a for a in apps if a and (a.get_name() or '').casefold()
                in {'chatgpt', 'codex', 'codex-launcher'}]
        if not apps:
            return []
        if len(apps) != 1:
            raise DriverFailure('desktop_ambiguous')
        pending = [(apps[0], ())]
        nodes = []
        while pending:
            node, ancestors = pending.pop()
            if node is None:
                continue
            if len(nodes) >= 5000:
                raise DriverFailure('accessibility_tree_budget')
            index = len(nodes)
            # A stale or incomplete tree cannot authorize an action.
            states = node.get_state_set()
            showing = states.contains(self.api.StateType.SHOWING)
            visible = states.contains(self.api.StateType.VISIBLE)
            enabled = states.contains(self.api.StateType.ENABLED)
            sensitive = states.contains(self.api.StateType.SENSITIVE)
            role = node.get_role_name()
            editable_state = states.contains(self.api.StateType.EDITABLE)
            # Unsupported interface RPCs can fail even on otherwise valid nodes.
            # Query only candidate roles and use the advertised public interfaces.
            text_interface = False
            editable_interface = False
            if role in EDITOR_ROLES and editable_state:
                interfaces = node.get_interfaces()
                text_interface = 'Text' in interfaces and node.get_text_iface() is not None
                editable_interface = ('EditableText' in interfaces
                                      and node.get_editable_text_iface() is not None)
            editable = role in EDITOR_ROLES and editable_state and text_interface
            nodes.append({'node': node, 'ancestors': ancestors, 'name': node.get_name() or '',
                          'role': role, 'showing': showing, 'visible': visible,
                          'enabled': enabled, 'sensitive': sensitive, 'editable': editable,
                          'editableState': editable_state, 'editableInterface': editable_interface,
                          'textInterface': text_interface,
                          'selected': states.contains(self.api.StateType.CHECKED)
                          or states.contains(self.api.StateType.SELECTED)})
            pending.extend((node.get_child_at_index(i), ancestors + (index,))
                           for i in range(node.get_child_count()))
        return nodes

    def activate(self, control, allowed):
        action = control['node'].get_action_iface()
        if action is None:
            raise DriverFailure('action_unavailable')
        matches = [i for i in range(action.get_n_actions()) if action.get_action_name(i) in allowed]
        if len(matches) != 1:
            raise DriverFailure('action_missing_or_ambiguous')
        if not action.do_action(matches[0]):
            raise DriverFailure('action_acknowledgement_uncertain')

    def text(self, control):
        text = control['node'].get_text_iface()
        if text is None:
            raise DriverFailure('composer_text_unavailable')
        # Accessible.get_text_iface() may return the Accessible itself. Its bound
        # get_text is not necessarily Text.get_text in PyGObject.
        return self.api.Text.get_text(control['node'], 0, -1)

    def helper(self, argv, allow_unavailable=False):
        try:
            return subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, timeout=self.remaining(), check=True).stdout
        except subprocess.TimeoutExpired:
            raise DriverFailure('helper_timeout') from None
        except subprocess.CalledProcessError:
            if allow_unavailable:
                return None
            raise DriverFailure('helper_failed') from None
        except OSError:
            raise DriverFailure('helper_failed') from None

    def release_clipboard(self):
        process = getattr(self, 'clipboard', None)
        self.clipboard = None
        if process is not None:
            try:
                if process.poll() is None:
                    process.terminate()
                process.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=0.5)
            finally:
                if process.stdin and not process.stdin.closed:
                    process.stdin.close()

    def own_clipboard(self, prompt):
        data = prompt.encode('utf-8')
        try:
            # -quiet keeps xclip in the foreground. No detached selection owner,
            # shell, prompt argv, or user clipboard backup is permitted.
            process = subprocess.Popen(
                [XCLIP, '-selection', 'clipboard', '-in', '-quiet'],
                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.clipboard = process
            os.set_blocking(process.stdin.fileno(), False)
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdin, selectors.EVENT_WRITE)
                offset = 0
                while offset < len(data):
                    if not selector.select(self.remaining()):
                        raise DriverFailure('helper_timeout')
                    offset += os.write(process.stdin.fileno(), data[offset:offset + 65536])
            process.stdin.close()
            # The owner starts serving only after stdin EOF. Read-only probes are
            # bounded and never cause another paste or overwrite.
            for _ in range(20):
                if process.poll() is not None:
                    raise DriverFailure('clipboard_unavailable')
                if self.helper([XCLIP, '-selection', 'clipboard', '-out'],
                               allow_unavailable=True) == data:
                    return
                time.sleep(min(0.01, self.remaining()))
            raise DriverFailure('clipboard_unavailable')
        except OSError:
            raise DriverFailure('helper_failed') from None

    def focus_editor(self, control, wait=None):
        # One focus action, followed only by bounded read-only observations.
        if not self.api.Component.grab_focus(control['node']):
            raise DriverFailure('focus_failed')

        def owned_focus(nodes):
            current = composer(nodes)
            if current['node'] != control['node']:
                raise DriverFailure('focus_failed')
            editor_index = next(i for i, node in enumerate(nodes) if node is current)
            focused = [node for node in nodes if available(node, enabled=False)
                       and node['node'].get_state_set().contains(self.api.StateType.FOCUSED)]
            # Chromium may focus a descendant of the editor root. Another field
            # must fail closed, even if the intended editor also reports focus.
            if any(node is not current and editor_index not in node['ancestors']
                   for node in focused):
                raise DriverFailure('focus_failed')
            return bool(focused)

        if wait is None:
            nodes = self.snapshot()
            if not owned_focus(nodes):
                raise DriverFailure('focus_failed')
        else:
            try:
                nodes = wait(owned_focus)
            except DriverFailure as error:
                if str(error) == 'state_transition_unobserved':
                    raise DriverFailure('focus_failed') from None
                raise
        return composer(nodes)

    def new_chat_shortcut(self):
        # Fixed Linux New chat command, not a generic keyboard-input API.
        # https://learn.chatgpt.com/docs/reference/commands
        self.helper([XDOTOOL, 'key', 'ctrl+n'])

    def fill(self, control, prompt, wait=None):
        if not available(control) or not control['editable']:
            raise DriverFailure('composer_missing_or_ambiguous')
        if self.text(control) != '':
            raise DriverFailure('composer_not_empty')
        if control['editableInterface']:
            if not self.api.EditableText.set_text_contents(control['node'], prompt):
                raise DriverFailure('fill_acknowledgement_uncertain')
            return
        try:
            self.own_clipboard(prompt)
            current = self.focus_editor(control, wait)
            if self.text(current) != '':
                raise DriverFailure('composer_not_empty')
            self.helper([XDOTOOL, 'key', 'ctrl+v'])
        except Exception:
            self.release_clipboard()
            raise


def available(node, enabled=True):
    return (node['showing'] and node['visible']
            and (not enabled or (node['enabled'] and node['sensitive'])))


def controls(nodes, names, roles=BUTTONS, enabled=True):
    return [n for n in nodes if available(n, enabled)
            and n['role'] in roles and n['name'] in names]


def unique(nodes, code):
    if len(nodes) != 1:
        raise DriverFailure(code)
    return nodes[0]


def editor_roots(nodes):
    # Chromium exposes an editable entry and editable paragraphs inside it.
    # Select the containing editor by live ancestry, not role priority or order.
    eligible = {i: n for i, n in enumerate(nodes) if available(n) and n['editable']}
    return [n for n in eligible.values()
            if not any(parent in eligible for parent in n['ancestors'])]


def composer(nodes):
    # Separate editors (including dialogs) remain ambiguous and cannot authorize input.
    return unique(editor_roots(nodes), 'composer_missing_or_ambiguous')


def fresh_chat(nodes, editor):
    candidates = controls(nodes, {'New chat'})
    # Two visible New chat controls occur in the app. Prefer the one in the
    # nearest shared container with the actual composer, never tree order.
    scores = [(len(set(n['ancestors']) & set(editor['ancestors'])), n) for n in candidates]
    if not scores:
        raise DriverFailure('new_chat_missing_or_ambiguous')
    best = max(score for score, _ in scores)
    return unique([n for score, n in scores if score == best], 'new_chat_missing_or_ambiguous')


class Driver:
    def __init__(self, desktop, timeout_ms, max_actions):
        self.desktop = desktop
        self.started = time.monotonic()
        self.deadline = self.started + timeout_ms / 1000
        self.desktop.deadline = self.deadline
        self.max_actions = max_actions
        self.actions = 0
        self.phase = None
        self.step = None
        self.composer_candidates = None

    def check(self):
        if time.monotonic() >= self.deadline:
            raise DriverFailure('deadline_exceeded')

    def action(self, operation):
        self.check()
        if self.actions >= self.max_actions:
            raise DriverFailure('action_budget_exhausted')
        self.actions += 1
        operation()

    def click(self, node, actions=frozenset({'click', 'press'})):
        self.action(lambda: self.desktop.activate(node, actions))

    def snapshot(self):
        self.check()
        nodes = self.desktop.snapshot()
        # Keep only the latest bounded structural evidence, never UI text or names.
        self.composer_candidates = []
        for node in nodes:
            if (node['editableState'] or node['editableInterface']
                    or node['role'] in EDITOR_ROLES):
                self.composer_candidates.append({key: node[key] for key in (
                    'role', 'showing', 'visible', 'enabled', 'sensitive',
                    'editableState', 'editableInterface', 'textInterface')})
                if len(self.composer_candidates) == 16:
                    break
        self.check()
        return nodes

    def wait(self, predicate, polls=100):
        # Poll only; an acknowledged action that does not change state is NOT retried.
        # The cold-app wait gets 30 seconds; all waits share the overall deadline.
        wait_deadline = min(self.deadline, time.monotonic() + polls * 0.1)
        ambiguity = None
        for _ in range(polls):
            try:
                nodes = self.snapshot()
            except DriverFailure as error:
                if str(error) == 'deadline_exceeded' and ambiguity is not None:
                    raise ambiguity from None
                raise
            if time.monotonic() >= wait_deadline:
                break
            try:
                matched = predicate(nodes)
            except DriverFailure as error:
                # Only predicate reads may tolerate transient editor/Send overlap.
                # Snapshot failures and every action remain fail-closed, with no retry.
                if str(error) not in {'composer_missing_or_ambiguous', 'send_missing_or_ambiguous'}:
                    raise
                if ambiguity is None:
                    ambiguity = error
            else:
                ambiguity = None
                if matched:
                    return nodes
            time.sleep(min(0.1, max(0, wait_deadline - time.monotonic())))
        if ambiguity is not None:
            raise ambiguity
        raise DriverFailure('state_transition_unobserved')

    def selected(self, nodes, surface):
        return len(controls(nodes, {'Switch mode, current mode: ' + SURFACES[surface]})) == 1

    def ready(self, nodes, surface):
        if not self.selected(nodes, surface):
            return False
        editors = editor_roots(nodes)
        sends = controls(nodes, {'Send'}, enabled=False)
        if not editors or not sends:
            return False
        unique(editors, 'composer_missing_or_ambiguous')
        unique(sends, 'send_missing_or_ambiguous')
        return True

    def prepare(self, surface):
        if surface not in SURFACES:
            raise DriverFailure('invalid_surface')
        self.desktop.require_helpers()
        self.phase = 'waiting-for-initial-ui'
        nodes = self.wait(lambda ns: bool(controls(ns, {'Engineering'}, {'radio button', 'toggle button'})
                                          or controls(ns, {'Leave a note on my Desktop', 'Go to ChatGPT',
                                                           'Switch mode, current mode: ChatGPT Work',
                                                           'Switch mode, current mode: Codex'})), polls=300)
        engineering = controls(nodes, {'Engineering'}, {'radio button', 'toggle button'})
        if engineering:
            self.phase = 'profession-selected'
            choice = unique(engineering, 'profession_ambiguous')
            if not choice['selected']:
                self.click(choice, {'check', 'toggle', 'click', 'press'})
            # Selection acknowledgement and Continue enablement can arrive in
            # separate accessibility updates. Observe both; never retry check.
            def continue_ready(ns):
                selected = any(n['selected'] for n in controls(
                    ns, {'Engineering'}, {'radio button', 'toggle button'}))
                self.phase = 'continue-ready' if selected else 'profession-selected'
                return selected and bool(controls(ns, {'Continue'}))
            nodes = self.wait(continue_ready)
            self.click(unique(controls(nodes, {'Continue'}), 'continue_missing_or_ambiguous'))
            self.phase = 'intro-dismiss'
            nodes = self.wait(lambda ns: not controls(ns, {'Engineering'}, {'radio button', 'toggle button'})
                              and bool(controls(ns, {'Leave a note on my Desktop', 'Go to ChatGPT',
                                                     'Switch mode, current mode: ChatGPT Work',
                                                     'Switch mode, current mode: Codex'})))
        self.phase = 'intro-dismiss'
        # Only skip the observed, specific product-introduction screen.
        if (controls(nodes, {'Leave a note on my Desktop'})
                and controls(nodes, {'Turn this spreadsheet into a chart'})):
            self.click(unique(controls(nodes, {'Skip'}), 'skip_missing_or_ambiguous'))
            nodes = self.wait(lambda ns: bool(controls(ns, {'Go to ChatGPT'})))
        if controls(nodes, {'Go to ChatGPT'}) and controls(nodes, {'Keep setting up'}):
            self.click(unique(controls(nodes, {'Go to ChatGPT'}), 'intro_confirmation_ambiguous'))
            nodes = self.wait(lambda ns: bool(controls(ns, {
                'Switch mode, current mode: ChatGPT Work', 'Switch mode, current mode: Codex'})))
        self.phase = 'surface'
        if not self.selected(nodes, surface):
            switch = unique(controls(nodes, {'Switch mode, current mode: ChatGPT Work',
                                             'Switch mode, current mode: Codex'}), 'mode_missing_or_ambiguous')
            self.click(switch, {'open'})
            nodes = self.wait(lambda ns: bool(controls(ns, {MENU_LABELS[surface]}, {'menu item'})))
            item = unique(controls(nodes, {MENU_LABELS[surface]}, {'menu item'}), 'surface_item_ambiguous')
            self.click(item, {'select'})
            nodes = self.wait(lambda ns: self.selected(ns, surface))
        self.phase = 'composer'
        nodes = self.wait(lambda ns: self.ready(ns, surface))
        try:
            fresh_chat(nodes, composer(nodes))
        except DriverFailure as error:
            if str(error) != 'new_chat_missing_or_ambiguous':
                raise
            self.new_chat(nodes, surface)
        return self.receipt('ready', surface)

    def new_chat(self, nodes, surface):
        self.step = 'new-chat-resolve'
        editor = composer(nodes)
        try:
            target = fresh_chat(nodes, editor)
        except DriverFailure as error:
            if (str(error) != 'new_chat_missing_or_ambiguous'
                    or len(controls(nodes, {'New chat'})) < 2):
                raise
            # Resolve ambiguity before any UI action. Focus verification and the
            # fixed shortcut form one logical action, never retried on failure.
            def shortcut():
                self.step = 'new-chat-focus'
                self.desktop.focus_editor(editor, self.wait)
                self.step = 'new-chat-shortcut'
                self.desktop.new_chat_shortcut()
            self.action(shortcut)
        else:
            self.click(target)
        self.step = 'new-chat-empty'
        nodes = self.wait(lambda ns: self.ready(ns, surface) and self.desktop.text(composer(ns)) == '')
        self.step = None
        return nodes

    def submit(self, prompt, surface):
        if not isinstance(prompt, str) or not prompt.strip():
            raise DriverFailure('invalid_prompt')
        if surface not in SURFACES:
            raise DriverFailure('invalid_surface')
        self.desktop.require_helpers()
        # Setup ran once for the batch. A changed surface blocks submission.
        self.phase = 'surface'
        nodes = self.snapshot()
        if not self.ready(nodes, surface):
            raise DriverFailure('surface_mismatch')
        self.phase = 'composer'
        nodes = self.new_chat(nodes, surface)
        try:
            self.action(lambda: self.desktop.fill(composer(nodes), prompt, self.wait))
            nodes = self.wait(lambda ns: self.ready(ns, surface)
                              and self.desktop.text(composer(ns)) == prompt
                              and len(controls(ns, {'Send'})) == 1)
        finally:
            self.desktop.release_clipboard()
        # Exactly one send. No retry, Enter fallback, or resubmission on missing trace.
        self.click(unique(controls(nodes, {'Send'}), 'send_missing_or_ambiguous'))
        return self.receipt('submitted', surface)

    def receipt(self, status, surface=None):
        return {'status': status, 'action_count': self.actions,
                'duration_ms': (time.monotonic() - self.started) * 1000,
                **({'surface': surface} if surface else {}),
                **({'phase': self.phase} if status == 'failed' and self.phase else {}),
                **({'step': self.step} if status == 'failed' and self.step else {}),
                **({'composerCandidates': self.composer_candidates}
                   if status == 'failed' and self.phase == 'composer'
                   and self.composer_candidates is not None else {})}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['prepare', 'submit'], required=True)
    parser.add_argument('--timeout-ms', type=int, required=True)
    parser.add_argument('--max-actions', type=int, default=24)
    args = parser.parse_args()
    driver = None
    try:
        if args.timeout_ms <= 0 or not 1 <= args.max_actions <= 64:
            raise DriverFailure('invalid_budget')
        data = sys.stdin.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise DriverFailure('input_too_large')
        payload = json.loads(data)
        if not isinstance(payload, dict):
            raise DriverFailure('invalid_input')
        driver = Driver(Desktop(), args.timeout_ms, args.max_actions)
        surface = payload.get('surface')
        result = driver.prepare(surface) if args.mode == 'prepare' else driver.submit(payload.get('prompt'), surface)
        print(json.dumps(result))
        return 0
    except Exception as error:
        result = driver.receipt('failed') if driver else {'status': 'failed', 'action_count': 0, 'duration_ms': 0}
        result['error'] = error_code(error)
        print(json.dumps(result))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
