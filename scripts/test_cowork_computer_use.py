"""Offline safety checks: never opens Claude or accesses the display."""
import asyncio
import sys
import types
import unittest
from unittest.mock import MagicMock, patch

import cowork_computer_use as driver

FILL = {'tool': 'fill_query', 'input': {}}
ENTER = {'action': 'key', 'text': 'Return'}


class DriverTests(unittest.TestCase):
    def run_actions(self, actions, mode='submit', budget=8, query='query', next_plan=None, entry_error=False):
        api = MagicMock()

        def response(plan):
            return types.SimpleNamespace(content=[
                types.SimpleNamespace(type='tool_use', name=a.get('tool', 'computer'), id=str(i), input=a.get('input', a))
                for i, a in enumerate(plan)
            ])

        planner = api.Anthropic.return_value.beta.messages.create
        if next_plan is not None:
            planner.side_effect = [response(actions), response(next_plan)]
        else:
            planner.return_value = response(actions)

        def execute(action):
            if entry_error and action.get('action') == 'type':
                raise RuntimeError('uncertain keyboard failure')
            return 'done', action.get('action') == 'key'

        with patch.dict(sys.modules, {'anthropic': api}), patch.dict(driver.os.environ, {'ANTHROPIC_API_KEY': 'test-only'}), patch.object(driver.subprocess, 'run'), patch.object(driver.time, 'sleep'), patch.object(driver, 'screenshot', return_value={'type': 'image'}), patch.object(driver, 'execute_action', side_effect=execute) as performed:
            try:
                result = asyncio.run(driver.run(query, budget, mode))
            except RuntimeError as error:
                result = str(error)
            self.executed_actions = [call.args[0] for call in performed.call_args_list]
            self.requested_tools = planner.call_args.kwargs['tools']
            return result, performed.call_count

    def test_stops_at_first_submit_even_if_plan_has_more_actions(self):
        result, count = self.run_actions([FILL, ENTER, ENTER])
        self.assertEqual(result['status'], 'submitted')
        self.assertEqual(count, 2)

    def test_rejects_enter_before_query(self):
        result, count = self.run_actions([ENTER])
        self.assertIn('exceeded', result)
        self.assertEqual(count, 0)

    def test_rejects_click_to_send_after_typing(self):
        result, count = self.run_actions([FILL, {'action': 'left_click', 'coordinate': [5, 5]}])
        self.assertIn('budget exhausted', result)
        self.assertEqual(count, 1)

    def test_hitl_cannot_type_press_enter_or_fill(self):
        for action in [{'action': 'type', 'text': 'query'}, ENTER, FILL]:
            result, count = self.run_actions([action], mode='hitl')
            self.assertIn('HITL cannot', result)
            self.assertEqual(count, 0)
            self.assertNotIn('fill_query', [tool['name'] for tool in self.requested_tools])

    def test_budget_counts_actions_not_planner_rounds(self):
        result, count = self.run_actions([{'action': 'screenshot'}] * 4, budget=2)
        self.assertIn('budget exhausted', result)
        self.assertEqual(count, 2)

    def test_unicode_line_breaks_use_shift_enter_without_clipboard(self):
        quartz, gui = MagicMock(), MagicMock()
        with patch.dict(sys.modules, {'Quartz': quartz, 'pyautogui': gui}), patch.object(driver.time, 'sleep'):
            driver.type_query('héllo\nworld')
        gui.hotkey.assert_called_once_with('shift', 'enter')
        self.assertEqual(quartz.CGEventKeyboardSetUnicodeString.call_count, 4)
        gui.write.assert_not_called()

    def test_fill_inserts_original_unicode_query_and_marker_without_model_copy(self):
        query = "From the ‘Tipalti & Glean Business Review’ document, what are MAU and WAU?\n\n[MCP_SERVER_TESTER_test-marker]"
        result, count = self.run_actions([FILL, ENTER], query=query)
        self.assertEqual(result['status'], 'submitted')
        self.assertEqual(self.executed_actions[0], {'action': 'type', 'text': query})
        self.assertEqual(count, 2)
        self.assertIn('fill_query', [tool['name'] for tool in self.requested_tools])

    def test_reproduces_missing_marker_proposal_and_corrects_without_typing_it(self):
        query = 'original query\n\n[MCP_SERVER_TESTER_marker]'
        result, count = self.run_actions([{'action': 'type', 'text': 'original query'}, ENTER], next_plan=[FILL, ENTER], query=query)
        self.assertEqual(result['status'], 'submitted')
        self.assertEqual(count, 2)
        self.assertEqual(self.executed_actions[0]['text'], query)

    def test_duplicate_fill_has_no_second_keyboard_effect(self):
        result, count = self.run_actions([FILL, FILL, ENTER])
        self.assertEqual(result['status'], 'submitted')
        self.assertEqual(count, 2)

    def test_keyboard_failure_is_not_retried(self):
        result, count = self.run_actions([FILL, FILL, ENTER], entry_error=True)
        self.assertEqual(result, 'uncertain keyboard failure')
        self.assertEqual(count, 1)


if __name__ == '__main__':
    unittest.main()
