"""Offline safety checks: never opens Claude or accesses the display."""
import asyncio
import sys
import types
import unittest
from unittest.mock import MagicMock, patch

import cowork_computer_use as driver


class DriverTests(unittest.TestCase):
    def run_actions(self, actions, mode='submit', budget=8):
        api = MagicMock()
        api.Anthropic.return_value.beta.messages.create.return_value = types.SimpleNamespace(
            content=[types.SimpleNamespace(type='tool_use', id=str(i), input=a) for i, a in enumerate(actions)]
        )
        def execute(action):
            return 'done', action.get('action') == 'key'
        with patch.dict(sys.modules, {'anthropic': api}), patch.dict(driver.os.environ, {'ANTHROPIC_API_KEY': 'test-only'}), patch.object(driver.subprocess, 'run'), patch.object(driver.time, 'sleep'), patch.object(driver, 'screenshot', return_value={'type': 'image'}), patch.object(driver, 'execute_action', side_effect=execute) as performed:
            try:
                result = asyncio.run(driver.run('query', budget, mode))
                return result, performed.call_count
            except RuntimeError as error:
                return str(error), performed.call_count

    def test_stops_at_first_submit_even_if_plan_has_more_actions(self):
        result, count = self.run_actions([{'action': 'type', 'text': 'query'}, {'action': 'key', 'text': 'Return'}, {'action': 'key', 'text': 'Return'}])
        self.assertEqual(result['status'], 'submitted')
        self.assertEqual(count, 2)

    def test_rejects_enter_before_query(self):
        result, count = self.run_actions([{'action': 'key', 'text': 'enter'}])
        self.assertIn('Only an unmodified Enter', result)
        self.assertEqual(count, 0)

    def test_rejects_click_to_send_after_typing(self):
        result, count = self.run_actions([{'action': 'type', 'text': 'query'}, {'action': 'left_click', 'coordinate': [5, 5]}])
        self.assertIn('After typing', result)
        self.assertEqual(count, 1)

    def test_hitl_cannot_type_or_press_enter(self):
        for action in [{'action': 'type', 'text': 'query'}, {'action': 'key', 'text': 'enter'}]:
            result, count = self.run_actions([action], mode='hitl')
            self.assertIn('HITL cannot', result)
            self.assertEqual(count, 0)

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


if __name__ == '__main__':
    unittest.main()
