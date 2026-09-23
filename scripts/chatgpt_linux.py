#!/usr/bin/env python3
"""Bounded ChatGPT AT-SPI setup/submission. Caller owns desktop lifecycle.

No inference API, shell, arbitrary keyboard input, answer extraction, or action retry.
Input is JSON on stdin; output never contains query text or accessible names.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import selectors
import subprocess
import sys
import time
from pathlib import Path


class DriverFailure(RuntimeError):
    pass


BUTTONS = {'button', 'push button'}
SURFACES = {'chatgpt-work': 'ChatGPT Work', 'codex': 'Codex'}
MENU_LABELS = {'chatgpt-work': 'ChatGPT Work Create, learn, and explore',
               'codex': 'Codex Build, debug, and ship'}
EDITOR_ROLES = {'entry', 'text', 'text area', 'editable text', 'paragraph'}
XDOTOOL = '/usr/bin/xdotool'
INPUT_LIMIT = 2 * 1024 * 1024
TEXT_NODE_LIMIT = 256
TEXT_DEPTH_LIMIT = 16
OUTPUT_LIMIT = 1024
# Shared with the Node adapter. Helpers get the session, not the runtime's opener path.
CONTRACT = json.loads(Path(__file__).with_name('chatgpt_linux_contract.json').read_text('utf-8'))
SESSION_KEYS = tuple(CONTRACT['sessionEnvironment'] + CONTRACT['profileEnvironment']
                     + CONTRACT['helperEnvironment'])
MAX_ACTIONS = CONTRACT['maxActions']
GLIB_ERROR = ()
ERROR_CODES = frozenset(CONTRACT['errorCodes'])


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


def has_interface(interfaces, name):
    return name in interfaces or 'org.a11y.atspi.' + name in interfaces


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
                text_interface = (has_interface(interfaces, 'Text')
                                  and node.get_text_iface() is not None)
                editable_interface = (has_interface(interfaces, 'EditableText')
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

    def text(self, control, limit=None):
        # Prefer public Hypertext references. The structural fallback follows
        # only a single direct child of a whole-marker owned composer node.
        # Bound both source reads and expanded output; never export UI content.
        byte_limit = INPUT_LIMIT if limit is None else min(limit, INPUT_LIMIT)
        nodes_read = 0
        bytes_read = 0
        output_bytes = 0
        fragments = []

        def append(value):
            nonlocal output_bytes
            output_bytes += len(value.encode('utf-8'))
            if output_bytes > byte_limit:
                raise DriverFailure('composer_text_unavailable')
            fragments.append(value)

        def structural(node, role, ancestors, owned):
            if not owned:
                return False
            if not ancestors and (role not in EDITOR_ROLES or not
                    node.get_state_set().contains(self.api.StateType.EDITABLE)):
                return False
            count = node.get_child_count()
            if type(count) is not int or count < 0:
                raise DriverFailure('composer_text_unavailable')
            if count != 1:
                return False  # No separators or child order can be inferred.
            child = node.get_child_at_index(0)
            if child is None:
                raise DriverFailure('composer_text_unavailable')
            child_role = child.get_role_name()
            static = role == 'paragraph' and child_role in {'static', 'static text'}
            if child_role not in {'paragraph', 'text'} and not static:
                raise DriverFailure('composer_text_unavailable')
            expand(child, ancestors + (node,), owned=True, static=static)
            return True

        def expand(node, ancestors, owned=False, static=False):
            nonlocal nodes_read, bytes_read
            self.remaining()
            if (node is None or len(ancestors) >= TEXT_DEPTH_LIMIT
                    or nodes_read >= TEXT_NODE_LIMIT or node in ancestors):
                raise DriverFailure('composer_text_unavailable')
            nodes_read += 1
            interfaces = node.get_interfaces()
            role = node.get_role_name()
            if static:
                count = node.get_child_count()
                states = node.get_state_set()
                if (type(count) is not int or count != 0
                        or role not in {'static', 'static text'}
                        or not states.contains(self.api.StateType.SHOWING)
                        or not states.contains(self.api.StateType.VISIBLE)):
                    raise DriverFailure('composer_text_unavailable')
                if not has_interface(interfaces, 'Text'):
                    # Only a visible static leaf under an owned paragraph has
                    # a name that represents content, not an arbitrary label.
                    value = node.get_name()
                    if not isinstance(value, str):
                        raise DriverFailure('composer_text_unavailable')
                    bytes_read += len(value.encode('utf-8'))
                    if bytes_read > byte_limit:
                        raise DriverFailure('composer_text_unavailable')
                    append(value)
                    return
            if (role in {'image', 'password text'}
                    or not has_interface(interfaces, 'Text')
                    or node.get_text_iface() is None):
                raise DriverFailure('composer_text_unavailable')
            # Accessible.get_text_iface() may return the Accessible itself.
            # Always use unbound Text methods to avoid the PyGObject collision.
            count = self.api.Text.get_character_count(node)
            if type(count) is not int or not 0 <= count <= byte_limit - bytes_read:
                raise DriverFailure('composer_text_unavailable')
            value = self.api.Text.get_text(node, 0, count)
            if not isinstance(value, str) or len(value) != count:
                raise DriverFailure('composer_text_unavailable')
            bytes_read += len(value.encode('utf-8'))
            if bytes_read > byte_limit:
                raise DriverFailure('composer_text_unavailable')
            if not has_interface(interfaces, 'Hypertext'):
                if value == '\ufffc' and structural(node, role, ancestors, owned):
                    return
                append(value)
                return
            start = 0
            for offset, character in enumerate(value):
                if character != '\ufffc':
                    continue
                self.remaining()
                index = self.api.Hypertext.get_link_index(node, offset)
                if type(index) is not int or index < -1:
                    raise DriverFailure('composer_text_unavailable')
                if index == -1:
                    if value == '\ufffc' and structural(node, role, ancestors, owned):
                        return
                    continue  # An unresolved object character is not empty.
                append(value[start:offset])
                link = self.api.Hypertext.get_link(node, index)
                if link is None:
                    raise DriverFailure('composer_text_unavailable')
                anchors = self.api.Hyperlink.get_n_anchors(link)
                if type(anchors) is not int or anchors != 1:
                    raise DriverFailure('composer_text_unavailable')
                child = self.api.Hyperlink.get_object(link, 0)
                expand(child, ancestors + (node,))
                start = offset + 1
            append(value[start:])

        try:
            expand(control['node'], (), owned=True)
            return ''.join(fragments)
        except DriverFailure:
            raise
        except Exception:
            # RPC errors can contain private text. Do not propagate their values.
            raise DriverFailure('composer_text_unavailable') from None

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
        self._open(data)

    def _open(self, data):
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


def matches_prompt(text, prompt):
    # Same bounded representation as native exact_prompt correlation. Do not
    # trim text or alter the prompt dispatched to the opener.
    return text == prompt or text == prompt + '\n'


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
        self.last_snapshot = None

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
        self.last_snapshot = nodes
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
        # Setup has no user prompt to match. A new chat can expose a visible
        # placeholder as Text; ready means controls/surface, not verified emptiness.
        nodes = self.wait(lambda ns: any(self.ready(ns, candidate) for candidate in SURFACES))
        self.select_surface(nodes, surface)
        self.step = 'draft-readback'
        self.wait(lambda ns: self.ready(ns, surface))
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
                          and matches_prompt(self.desktop.text(composer(ns)), prompt))
        # A deep link may change mode. One fixed UI selection is allowed, but it
        # must preserve the draft. Never reopen, refill, or fall back on loss.
        self.select_surface(nodes, surface)
        self.step = 'draft-readback'
        nodes = self.wait(lambda ns: self.ready(ns, surface)
                          and matches_prompt(self.desktop.text(composer(ns)), prompt)
                          and len(controls(ns, {'Send'})) == 1)
        # Exactly one send. No retry, Enter fallback, or resubmission on missing trace.
        self.step = 'send'
        self.click(unique(controls(nodes, {'Send'}), 'send_missing_or_ambiguous'))
        self.step = None
        return self.receipt('submitted', surface)

    def draft_state(self):
        # Failure-only, read-only evidence from the last complete snapshot. Never
        # serialize nodes, names, URLs, prompt/config values, or exception details.
        nodes = self.last_snapshot
        if nodes is None:
            return None
        roots = editor_roots(nodes)
        switches = controls(nodes, {'Switch mode, current mode: ' + label
                                   for label in SURFACES.values()})
        observed = 'unknown'
        if len(switches) > 1:
            observed = 'ambiguous'
        elif len(switches) == 1:
            observed = next(surface for surface, label in SURFACES.items()
                            if switches[0]['name'] == 'Switch mode, current mode: ' + label)
        state = {'observedSurface': observed, 'composerRootCount': len(roots),
                 'sendControlCount': len(controls(nodes, {'Send'}, enabled=False)),
                 'textReadable': False}
        if len(roots) != 1:
            return state
        try:
            text = self.desktop.text(roots[0], limit=INPUT_LIMIT)
            if not isinstance(text, str) or len(text) > INPUT_LIMIT:
                return state
            encoded = text.encode('utf-8')
            if len(encoded) > INPUT_LIMIT:
                return state
            # Length/counts are Unicode code points; hash is exact UTF-8 bytes.
            state.update(textReadable=True, textLength=len(text),
                         textSha256=hashlib.sha256(encoded).hexdigest(),
                         embeddedObjectCount=text.count('\ufffc'), newlineCount=text.count('\n'))
        except Exception:
            # Diagnostics must not replace the original failure or expose its text.
            pass
        return state

    def receipt(self, status, surface=None):
        draft_state = self.draft_state() if status == 'failed' else None
        return {'status': status, 'action_count': self.actions,
                'duration_ms': (time.monotonic() - self.started) * 1000,
                **({'surface': surface} if surface else {}),
                **({'phase': self.phase} if status == 'failed' and self.phase else {}),
                **({'step': self.step} if status == 'failed' and self.step else {}),
                **({'draftState': draft_state} if draft_state is not None else {})}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['prepare', 'submit'], required=True)
    parser.add_argument('--timeout-ms', type=int, required=True)
    parser.add_argument('--max-actions', type=int, default=MAX_ACTIONS['default'])
    args = parser.parse_args()
    driver = None
    try:
        if args.timeout_ms <= 0 or not 1 <= args.max_actions <= MAX_ACTIONS['max']:
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
