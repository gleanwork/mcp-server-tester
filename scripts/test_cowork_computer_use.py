"""Offline safety checks: never opens Claude or accesses the display."""
import asyncio
import json
import sys
import types
import unittest
from unittest.mock import MagicMock, patch

import cowork_computer_use as driver

FILL = {'tool': 'fill_query', 'input': {}}
ENTER = {'action': 'key', 'text': 'Return'}


class DriverTests(unittest.TestCase):
    def run_actions(self, actions, mode='submit', budget=8, query='query', next_plan=None, entry_error=False, response_metadata=None, planner_error=None):
        api = MagicMock()

        def response(plan):
            return types.SimpleNamespace(**(response_metadata or {}), content=[
                types.SimpleNamespace(type='tool_use', name=a.get('tool', 'computer'), id=str(i), input=a.get('input', a))
                for i, a in enumerate(plan)
            ])

        planner = api.Anthropic.return_value.beta.messages.create
        if planner_error is not None:
            planner.side_effect = [response(actions), planner_error]
        elif next_plan is not None:
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
                self.error_telemetry = getattr(error, 'telemetry', None)
            self.executed_actions = [call.args[0] for call in performed.call_args_list]
            self.requested_tools = planner.call_args.kwargs['tools']
            return result, performed.call_count

    def test_observed_response_models_and_cached_usage_sum_each_completed_plan(self):
        metadata = {'model': 'claude-sonnet-4-6', 'usage': types.SimpleNamespace(
            input_tokens=100, output_tokens=20, cache_creation_input_tokens=30, cache_read_input_tokens=40,
            prompt='private query', api_key='secret')}
        result, count = self.run_actions([{'action': 'screenshot'}], next_plan=[FILL, ENTER], response_metadata=metadata)
        telemetry = result['telemetry']
        self.assertEqual(telemetry['response_models'], ['claude-sonnet-4-6'])
        self.assertEqual(telemetry['planner_response_count'], 2)
        self.assertEqual(telemetry['usage'], {'input_tokens': 200, 'output_tokens': 40, 'cache_creation_input_tokens': 60, 'cache_read_input_tokens': 80})
        self.assertEqual(set(telemetry['usage_observation_counts'].values()), {2})
        self.assertEqual(telemetry['cost'], {'status': 'unavailable'})
        self.assertEqual(telemetry['executed_action_count'], count)
        self.assertEqual(telemetry['accounting'], 'complete')
        self.assertGreaterEqual(telemetry['duration_ms'], 0)
        self.assertNotIn('private', json.dumps(telemetry))
        self.assertNotIn('secret', json.dumps(telemetry))

    def test_observation_tracks_model_changes_and_partial_usage_coverage(self):
        telemetry = driver.Telemetry()
        telemetry.observe(types.SimpleNamespace(model='claude-sonnet-4-6', usage=types.SimpleNamespace(input_tokens=10)))
        telemetry.observe(types.SimpleNamespace(model='claude-opus-4-6', usage=types.SimpleNamespace(input_tokens=20, cache_read_input_tokens=0)))
        result = telemetry.snapshot('complete')
        self.assertEqual(result['response_models'], ['claude-sonnet-4-6', 'claude-opus-4-6'])
        self.assertEqual(result['usage'], {'input_tokens': 30, 'cache_read_input_tokens': 0})
        self.assertEqual(result['usage_observation_counts']['input_tokens'], 2)
        self.assertEqual(result['usage_observation_counts']['cache_read_input_tokens'], 1)
        self.assertEqual(result['usage_observation_counts']['output_tokens'], 0)

    def test_main_serializes_partial_telemetry_on_failure(self):
        error = driver.ComputerUseDriverError('bounded failure', driver.Telemetry().snapshot('partial'))
        with patch.object(sys, 'argv', ['cowork_computer_use.py', 'private prompt']), patch.object(driver, 'run', side_effect=error), patch('builtins.print') as output:
            self.assertEqual(driver.main(), 1)
        record = json.loads(output.call_args.args[0])
        self.assertEqual(record['status'], 'failed')
        self.assertEqual(record['telemetry']['accounting'], 'partial')
        self.assertEqual(record['telemetry']['planner_response_count'], 0)
        self.assertNotIn('private prompt', json.dumps(record['telemetry']))

    def test_missing_and_invalid_usage_never_become_zero_or_configured_model(self):
        metadata = {'model': 'private prompt\nsecret', 'usage': types.SimpleNamespace(
            input_tokens=True, output_tokens=-1, cache_creation_input_tokens=float('nan'), cache_read_input_tokens=float('inf'))}
        result, _ = self.run_actions([FILL, ENTER], response_metadata=metadata)
        self.assertEqual(result['telemetry']['usage'], {})
        self.assertEqual(result['telemetry']['response_models'], [])
        self.assertEqual(set(result['telemetry']['usage_observation_counts'].values()), {0})

    def test_failed_api_call_preserves_only_completed_response_usage(self):
        result, _ = self.run_actions([{'action': 'screenshot'}], planner_error=RuntimeError('provider failure'), response_metadata={
            'model': 'claude-sonnet-4-6', 'usage': types.SimpleNamespace(input_tokens=12, output_tokens=0)})
        self.assertEqual(result, 'provider failure')
        self.assertEqual(self.error_telemetry['planner_response_count'], 1)
        self.assertEqual(self.error_telemetry['usage'], {'input_tokens': 12, 'output_tokens': 0})
        self.assertEqual(self.error_telemetry['accounting'], 'partial')

    def test_hitl_without_tools_counts_responses_not_actions(self):
        result, count = self.run_actions([], mode='hitl')
        self.assertEqual(result['action_count'], 0)
        self.assertEqual(result['telemetry']['planner_response_count'], 1)
        self.assertEqual(result['telemetry']['executed_action_count'], count)

    def test_hitl_budget_error_keeps_partial_action_counts(self):
        result, count = self.run_actions([{'action': 'left_click', 'coordinate': [5, 5]}], mode='hitl', budget=1)
        self.assertIn('HITL check exceeded', result)
        self.assertEqual(self.error_telemetry['executed_action_count'], count)
        self.assertEqual(self.error_telemetry['accounting'], 'partial')

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
        self.assertEqual(result['telemetry']['action_count'], 3)
        self.assertEqual(result['telemetry']['refused_action_count'], 1)
        self.assertEqual(result['telemetry']['attempted_action_count'], 2)
        self.assertEqual(result['telemetry']['executed_action_count'], 2)

    def test_keyboard_failure_is_not_retried(self):
        result, count = self.run_actions([FILL, FILL, ENTER], entry_error=True)
        self.assertEqual(result, 'uncertain keyboard failure')
        self.assertEqual(count, 1)
        self.assertEqual(self.error_telemetry['attempted_action_count'], 1)
        self.assertEqual(self.error_telemetry['executed_action_count'], 0)
        self.assertEqual(self.error_telemetry['planner_response_count'], 1)


if __name__ == '__main__':
    unittest.main()
