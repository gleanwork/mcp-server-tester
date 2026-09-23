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
XDOTOOL = '/usr/bin/xdotool'
INPUT_LIMIT = 2 * 1024 * 1024
OUTPUT_LIMIT = 1024
SESSION_KEYS = ('PATH', 'HOME', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS',
                'AT_SPI_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME',
                'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CODEX_HOME',
                'LANG', 'LC_ALL', 'NO_AT_BRIDGE')
GLIB_ERROR = ()
ERROR_CODES = frozenset({
    'accessibility_event_budget', 'accessibility_tree_budget', 'desktop_ambiguous',
    'action_unavailable', 'action_missing_or_ambiguous', 'action_acknowledgement_uncertain',
    'composer_text_unavailable', 'composer_missing_or_ambiguous',
    'deadline_exceeded', 'action_budget_exhausted', 'state_transition_unobserved',
    'send_missing_or_ambiguous', 'invalid_surface', 'profession_ambiguous',
    'continue_missing_or_ambiguous', 'skip_missing_or_ambiguous',
    'intro_confirmation_ambiguous', 'mode_missing_or_ambiguous', 'surface_item_ambiguous',
    'invalid_prompt', 'surface_mismatch', 'invalid_budget', 'input_too_large', 'invalid_input',
    'helper_missing', 'helper_failed', 'helper_timeout', 'profession_geometry_invalid',
    'desktop_attribute_error', 'desktop_type_error',
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
        self.deadline = float('inf')

    def require_helpers(self):
        path = os.environ.get('MST_CHATGPT_URL_OPENER', '')
        if not (os.path.isabs(path) and os.path.isfile(path) and os.access(path, os.X_OK)):
            raise DriverFailure('helper_missing')
        self.opener = path

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

    def environment(self):
        return {key: os.environ[key] for key in SESSION_KEYS if key in os.environ}

    def open_prompt(self, prompt):
        # The caller-owned helper dispatches native app IPC. It must only open a
        # draft (empty -> codex://threads/new; otherwise codex://new?prompt=...).
        # No URL/prompt argv, shell, CLI inference, clipboard, or retry.
        if not isinstance(prompt, str):
            raise DriverFailure('invalid_prompt')
        data = json.dumps({'prompt': prompt}, ensure_ascii=False).encode('utf-8')
        if len(data) > INPUT_LIMIT:
            raise DriverFailure('input_too_large')
        expires = time.monotonic() + self.remaining(15)
        process = None

        def remaining():
            seconds = expires - time.monotonic()
            if seconds <= 0:
                raise DriverFailure('helper_timeout')
            return seconds

        try:
            process = subprocess.Popen(
                [self.opener], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, env=self.environment(), shell=False)
            output = bytearray()
            os.set_blocking(process.stdin.fileno(), False)
            os.set_blocking(process.stdout.fileno(), False)
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdin, selectors.EVENT_WRITE)
                selector.register(process.stdout, selectors.EVENT_READ)
                offset = 0
                while selector.get_map():
                    events = selector.select(remaining())
                    if not events:
                        raise DriverFailure('helper_timeout')
                    for key, _ in events:
                        if key.fileobj is process.stdin:
                            offset += os.write(process.stdin.fileno(), data[offset:offset + 65536])
                            if offset == len(data):
                                selector.unregister(process.stdin)
                                process.stdin.close()
                        else:
                            chunk = os.read(process.stdout.fileno(), OUTPUT_LIMIT + 1 - len(output))
                            if not chunk:
                                selector.unregister(process.stdout)
                            output.extend(chunk)
                            if len(output) > OUTPUT_LIMIT:
                                raise DriverFailure('helper_failed')
            if process.wait(timeout=remaining()) != 0:
                raise DriverFailure('helper_failed')
            # Preserve pairs to reject duplicate keys as well as extra keys and
            # non-boolean values. Only this receipt can acknowledge dispatch.
            receipt = json.loads(output.decode('utf-8'), object_pairs_hook=list)
            if receipt != [('opened', True)] or type(receipt[0][1]) is not bool:
                raise DriverFailure('helper_failed')
        except subprocess.TimeoutExpired:
            raise DriverFailure('helper_timeout') from None
        except (OSError, ValueError):
            raise DriverFailure('helper_failed') from None
        finally:
            if process is not None:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=0.5)
                for pipe in (process.stdin, process.stdout):
                    if not pipe.closed:
                        pipe.close()

    def select_profession(self, nodes, choice):
        # Primary selection path: the observed radio's WINDOW extents plus its
        # top-level frame's SCREEN origin. Never reuse guessed coordinates.
        if not (os.path.isfile(XDOTOOL) and os.access(XDOTOOL, os.X_OK)):
            raise DriverFailure('helper_missing')
        frames = [nodes[i] for i in choice['ancestors'] if nodes[i]['role'] == 'frame'
                  and available(nodes[i], enabled=False)]
        frame = unique(frames, 'profession_geometry_invalid')
        for control in (choice, frame):
            if 'Component' not in control['node'].get_interfaces():
                raise DriverFailure('profession_geometry_invalid')
        target = self.api.Component.get_extents(choice['node'], self.api.CoordType.WINDOW)
        bounds = self.api.Component.get_extents(frame['node'], self.api.CoordType.SCREEN)
        if any(type(value) is not int for rect in (target, bounds)
               for value in (rect.x, rect.y, rect.width, rect.height)):
            raise DriverFailure('profession_geometry_invalid')
        if (target.x < 0 or target.y < 0 or target.width <= 0 or target.height <= 0
                or bounds.width <= 0 or bounds.height <= 0
                or target.x + target.width > bounds.width
                or target.y + target.height > bounds.height):
            raise DriverFailure('profession_geometry_invalid')
        x = bounds.x + target.x + target.width // 2
        y = bounds.y + target.y + target.height // 2
        if x < 0 or y < 0:
            raise DriverFailure('profession_geometry_invalid')
        # Public Component.contains is a hit test on this actual accessible.
        contains = getattr(self.api.Component, 'contains', None)
        if contains is not None and not contains(choice['node'], x, y, self.api.CoordType.SCREEN):
            raise DriverFailure('profession_geometry_invalid')
        try:
            subprocess.run([XDOTOOL, 'mousemove', str(x), str(y), 'click', '1'],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, env=self.environment(),
                           timeout=self.remaining(), check=True, shell=False)
        except subprocess.TimeoutExpired:
            raise DriverFailure('helper_timeout') from None
        except (OSError, subprocess.CalledProcessError):
            raise DriverFailure('helper_failed') from None


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
        switches = controls(nodes, {'Switch mode, current mode: ' + label for label in SURFACES.values()})
        return len(switches) == 1 and switches[0]['name'] == 'Switch mode, current mode: ' + SURFACES[surface]

    def select_surface(self, nodes, surface):
        if self.selected(nodes, surface):
            return nodes
        switch = unique(controls(nodes, {'Switch mode, current mode: ChatGPT Work',
                                         'Switch mode, current mode: Codex'}), 'mode_missing_or_ambiguous')
        self.click(switch, {'open'})
        nodes = self.wait(lambda ns: bool(controls(ns, {MENU_LABELS[surface]}, {'menu item'})))
        item = unique(controls(nodes, {MENU_LABELS[surface]}, {'menu item'}), 'surface_item_ambiguous')
        self.click(item, {'select'})
        return self.wait(lambda ns: self.selected(ns, surface))

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
                self.action(lambda: self.desktop.select_profession(nodes, choice))
            # Chromium can keep the checked bit stale after a real selection.
            # Observe the same profession page and enabled Continue, not that bit.
            self.phase = 'continue-ready'
            nodes = self.wait(lambda ns: len(controls(
                ns, {'Engineering'}, {'radio button', 'toggle button'})) == 1
                and bool(controls(ns, {'Continue'})))
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
        self.select_surface(nodes, surface)
        self.phase = 'composer'
        self.wait(lambda ns: self.ready(ns, surface))
        self.step = 'draft-open'
        self.action(lambda: self.desktop.open_prompt(''))
        self.step = 'draft-surface'
        nodes = self.wait(lambda ns: any(self.ready(ns, candidate) for candidate in SURFACES)
                          and self.desktop.text(composer(ns)) == '')
        self.select_surface(nodes, surface)
        self.step = 'draft-readback'
        self.wait(lambda ns: self.ready(ns, surface) and self.desktop.text(composer(ns)) == '')
        self.step = None
        return self.receipt('ready', surface)

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
        self.step = 'draft-open'
        self.action(lambda: self.desktop.open_prompt(prompt))
        self.step = 'draft-surface'
        nodes = self.wait(lambda ns: any(self.ready(ns, candidate) for candidate in SURFACES)
                          and self.desktop.text(composer(ns)) == prompt)
        # A deep link may change mode. One fixed UI selection is allowed, but it
        # must preserve the draft. Never reopen, refill, or fall back on loss.
        self.select_surface(nodes, surface)
        self.step = 'draft-readback'
        nodes = self.wait(lambda ns: self.ready(ns, surface)
                          and self.desktop.text(composer(ns)) == prompt
                          and len(controls(ns, {'Send'})) == 1)
        # Exactly one send. No retry, Enter fallback, or resubmission on missing trace.
        self.step = 'send'
        self.click(unique(controls(nodes, {'Send'}), 'send_missing_or_ambiguous'))
        self.step = None
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
        data = sys.stdin.buffer.read(INPUT_LIMIT + 1)
        if len(data) > INPUT_LIMIT:
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
