#!/usr/bin/env python3
"""Bounded ChatGPT AT-SPI setup/submission. Caller owns login and desktop lifecycle.

No inference API, shell, keyboard fallback, answer extraction, or action retry.
Input is JSON on stdin; output contains only a fixed receipt, never UI/query text.
"""
from __future__ import annotations

import argparse
import json
import sys
import time


class DriverFailure(RuntimeError):
    pass


BUTTONS = {'button', 'push button'}
SURFACES = {'chatgpt-work': 'ChatGPT Work', 'codex': 'Codex'}
MENU_LABELS = {'chatgpt-work': 'ChatGPT Work Create, learn, and explore',
               'codex': 'Codex Build, debug, and ship'}


class Desktop:
    def __init__(self):
        import gi
        gi.require_version('Atspi', '2.0')
        from gi.repository import Atspi
        self.api = Atspi

    def snapshot(self):
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
            visible = states.contains(self.api.StateType.SHOWING) and states.contains(self.api.StateType.VISIBLE)
            enabled = states.contains(self.api.StateType.ENABLED) and states.contains(self.api.StateType.SENSITIVE)
            role = node.get_role_name()
            editable = (role in {'entry', 'text', 'text area', 'editable text', 'paragraph'}
                        and states.contains(self.api.StateType.EDITABLE)
                        and node.get_editable_text_iface() is not None)
            nodes.append({'node': node, 'ancestors': ancestors, 'name': node.get_name() or '',
                          'role': role, 'visible': visible, 'enabled': enabled, 'editable': editable,
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
        return text.get_text(0, -1)

    def fill(self, control, prompt):
        if not control['node'].get_editable_text_iface().set_text_contents(prompt):
            raise DriverFailure('fill_acknowledgement_uncertain')


def controls(nodes, names, roles=BUTTONS, enabled=True):
    return [n for n in nodes if n['visible'] and (n['enabled'] or not enabled)
            and n['role'] in roles and n['name'] in names]


def unique(nodes, code):
    if len(nodes) != 1:
        raise DriverFailure(code)
    return nodes[0]


def composer(nodes):
    # Role alone is insufficient: Chromium also exposes static text with role text.
    return unique([n for n in nodes if n['visible'] and n['enabled'] and n['editable']],
                  'composer_missing_or_ambiguous')


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
        self.max_actions = max_actions
        self.actions = 0

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
        return self.desktop.snapshot()

    def wait(self, predicate):
        # Poll only; an acknowledged action that does not change state is NOT retried.
        for _ in range(100):
            nodes = self.snapshot()
            if predicate(nodes):
                return nodes
            time.sleep(0.1)
        raise DriverFailure('state_transition_unobserved')

    def selected(self, nodes, surface):
        return len(controls(nodes, {'Switch mode, current mode: ' + SURFACES[surface]})) == 1

    def ready(self, nodes, surface):
        if not self.selected(nodes, surface):
            return False
        editors = [n for n in nodes if n['visible'] and n['enabled'] and n['editable']]
        sends = controls(nodes, {'Send'}, enabled=False)
        if not editors or not sends:
            return False
        unique(editors, 'composer_missing_or_ambiguous')
        unique(sends, 'send_missing_or_ambiguous')
        return True

    def prepare(self, surface):
        if surface not in SURFACES:
            raise DriverFailure('invalid_surface')
        nodes = self.wait(lambda ns: bool(controls(ns, {'Engineering'}, {'radio button', 'toggle button'})
                                          or controls(ns, {'Leave a note on my Desktop', 'Go to ChatGPT',
                                                           'Switch mode, current mode: ChatGPT Work',
                                                           'Switch mode, current mode: Codex'})))
        engineering = controls(nodes, {'Engineering'}, {'radio button', 'toggle button'})
        if engineering:
            choice = unique(engineering, 'profession_ambiguous')
            if not choice['selected']:
                self.click(choice, {'check', 'toggle', 'click', 'press'})
            # Selection acknowledgement and Continue enablement can arrive in
            # separate accessibility updates. Observe both; never retry check.
            nodes = self.wait(lambda ns: any(n['selected'] for n in controls(
                ns, {'Engineering'}, {'radio button', 'toggle button'}))
                and bool(controls(ns, {'Continue'})))
            self.click(unique(controls(nodes, {'Continue'}), 'continue_missing_or_ambiguous'))
            nodes = self.wait(lambda ns: not controls(ns, {'Engineering'}, {'radio button', 'toggle button'})
                              and bool(controls(ns, {'Leave a note on my Desktop', 'Go to ChatGPT',
                                                     'Switch mode, current mode: ChatGPT Work',
                                                     'Switch mode, current mode: Codex'})))
        # Only skip the observed, specific product-introduction screen.
        if (controls(nodes, {'Leave a note on my Desktop'})
                and controls(nodes, {'Turn this spreadsheet into a chart'})):
            self.click(unique(controls(nodes, {'Skip'}), 'skip_missing_or_ambiguous'))
            nodes = self.wait(lambda ns: bool(controls(ns, {'Go to ChatGPT'})))
        if controls(nodes, {'Go to ChatGPT'}) and controls(nodes, {'Keep setting up'}):
            self.click(unique(controls(nodes, {'Go to ChatGPT'}), 'intro_confirmation_ambiguous'))
            nodes = self.wait(lambda ns: bool(controls(ns, {
                'Switch mode, current mode: ChatGPT Work', 'Switch mode, current mode: Codex'})))
        if not self.selected(nodes, surface):
            switch = unique(controls(nodes, {'Switch mode, current mode: ChatGPT Work',
                                             'Switch mode, current mode: Codex'}), 'mode_missing_or_ambiguous')
            self.click(switch, {'open'})
            nodes = self.wait(lambda ns: bool(controls(ns, {MENU_LABELS[surface]}, {'menu item'})))
            item = unique(controls(nodes, {MENU_LABELS[surface]}, {'menu item'}), 'surface_item_ambiguous')
            self.click(item, {'select'})
            nodes = self.wait(lambda ns: self.selected(ns, surface))
        self.wait(lambda ns: self.ready(ns, surface))
        return self.receipt('ready', surface)

    def submit(self, prompt, surface):
        if not isinstance(prompt, str) or not prompt.strip():
            raise DriverFailure('invalid_prompt')
        if surface not in SURFACES:
            raise DriverFailure('invalid_surface')
        # Setup ran once for the batch. A changed surface blocks submission.
        nodes = self.snapshot()
        if not self.ready(nodes, surface):
            raise DriverFailure('surface_mismatch')
        self.click(fresh_chat(nodes, composer(nodes)))
        nodes = self.wait(lambda ns: self.ready(ns, surface) and self.desktop.text(composer(ns)) == '')
        self.action(lambda: self.desktop.fill(composer(nodes), prompt))
        nodes = self.wait(lambda ns: self.ready(ns, surface)
                          and self.desktop.text(composer(ns)) == prompt
                          and len(controls(ns, {'Send'})) == 1)
        # Exactly one send. No retry, Enter fallback, or resubmission on missing trace.
        self.click(unique(controls(nodes, {'Send'}), 'send_missing_or_ambiguous'))
        return self.receipt('submitted', surface)

    def receipt(self, status, surface=None):
        return {'status': status, 'action_count': self.actions,
                'duration_ms': (time.monotonic() - self.started) * 1000,
                **({'surface': surface} if surface else {})}


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
        result['error'] = str(error) if isinstance(error, DriverFailure) else 'desktop_driver_failed'
        print(json.dumps(result))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
