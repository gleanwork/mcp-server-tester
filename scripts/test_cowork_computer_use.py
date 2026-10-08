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
CONFIRM_MODEL = {'tool': 'confirm_model', 'input': {'model': 'claude-opus-4-6'}}


class DriverTests(unittest.TestCase):
    def run_actions(self, actions, mode='submit', budget=8, query='query', next_plan=None, entry_error=False, response_metadata=None, planner_error=None, application='cowork', target_model=None, reasoning_effort=None, chatgpt_surface='chatgpt-work', frontmost=None):
        api = MagicMock()
        app_name = 'ChatGPT' if application == 'chatgpt' else 'Claude'
        front = MagicMock(side_effect=frontmost) if frontmost is not None else MagicMock(return_value=app_name)

        def response(plan):
            return types.SimpleNamespace(**(response_metadata or {}), content=[
                types.SimpleNamespace(type='tool_use', name=a.get('tool', 'computer'), id=str(i), input=a.get('input', a))
                for i, a in enumerate(plan)
            ])

        def construct(**kwargs):
            self.client_env = dict(driver.os.environ)
            return unittest.mock.DEFAULT

        api.Anthropic.side_effect = construct
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
            if action.get('action') == 'screenshot':
                return {'type': 'image'}, False
            return 'done', action.get('action') == 'key' and str(action.get('text', '')).lower() in {'enter', 'return'}

        with patch.dict(sys.modules, {'anthropic': api}), patch.dict(driver.os.environ, {'ANTHROPIC_API_KEY': 'test-only'}), patch.object(driver.subprocess, 'run') as launched, patch.object(driver, 'check_chatgpt_permissions'), patch.object(driver.time, 'sleep'), patch.object(driver, 'screenshot', return_value={'type': 'image'}), patch.object(driver, 'execute_action', side_effect=execute) as performed, patch.object(driver, 'frontmost_app', front):
            try:
                result = asyncio.run(driver.run(query, budget, mode, application, target_model, reasoning_effort, chatgpt_surface))
            except RuntimeError as error:
                result = str(error)
                self.error_telemetry = getattr(error, 'telemetry', None)
                self.error_code = getattr(error, 'code', None)
            self.executed_actions = [call.args[0] for call in performed.call_args_list]
            self.requested_tools = planner.call_args.kwargs['tools'] if planner.call_args else []
            self.planner_request = planner.call_args.kwargs if planner.call_args else {}
            self.launches = launched.call_args_list
            self.client_kwargs = api.Anthropic.call_args.kwargs if api.Anthropic.call_args else {}
            self.focus_checks = front.call_count
            return result, performed.call_count

    def test_planner_ignores_inherited_gateway_settings(self):
        gateway = {'ANTHROPIC_BASE_URL': 'https://gateway.example/anthropic', 'ANTHROPIC_AUTH_TOKEN': 'gateway-token'}
        with patch.dict(driver.os.environ, gateway):
            self.run_actions([], mode='hitl')
        # The API key goes only to the public API, and the gateway token never does.
        self.assertEqual(self.client_kwargs, {'api_key': 'test-only', 'base_url': 'https://api.anthropic.com'})
        self.assertNotIn('ANTHROPIC_AUTH_TOKEN', self.client_env)

    def test_planner_sends_only_the_gateway_token_to_the_resolved_gateway(self):
        resolved = {'MST_COWORK_CUA_BASE_URL': 'https://gateway.example/anthropic', 'MST_COWORK_CUA_AUTH_TOKEN': 'gateway-token'}
        with patch.dict(driver.os.environ, resolved):
            self.run_actions([], mode='hitl')
        self.assertEqual(self.client_kwargs, {'auth_token': 'gateway-token', 'base_url': 'https://gateway.example/anthropic'})
        # The SDK would otherwise also send ANTHROPIC_API_KEY as x-api-key.
        self.assertNotIn('ANTHROPIC_API_KEY', self.client_env)

    def test_assistant_turn_drops_fields_a_gateway_adds_to_its_reply(self):
        reply = [
            types.SimpleNamespace(type='text', text='Taking a screenshot.', citations=None),
            types.SimpleNamespace(type='tool_use', id='toolu_1', name='computer', input={'action': 'screenshot'},
                                  caller=types.SimpleNamespace(), toolset_name=None),
            (other := types.SimpleNamespace(type='thinking', thinking='...', signature='sig')),
        ]
        self.assertEqual(driver.assistant_turn(reply), [
            {'type': 'text', 'text': 'Taking a screenshot.'},
            {'type': 'tool_use', 'id': 'toolu_1', 'name': 'computer', 'input': {'action': 'screenshot'}},
            other,
        ])

    def test_planner_sends_back_a_clean_assistant_turn(self):
        self.run_actions([{'action': 'screenshot'}], mode='hitl', budget=2, next_plan=[])
        sent = self.planner_request['messages']
        assistant = [m for m in sent if m['role'] == 'assistant']
        self.assertTrue(assistant)
        for message in assistant:
            for block in message['content']:
                self.assertIsInstance(block, dict)
                self.assertEqual(set(block), {'type', 'id', 'name', 'input'})

    def test_planner_never_sends_a_gateway_token_to_the_public_api(self):
        with patch.dict(driver.os.environ, {'MST_COWORK_CUA_AUTH_TOKEN': 'gateway-token'}):
            result, performed = self.run_actions([], mode='hitl')
        self.assertIn('gateway base URL', result)
        self.assertEqual((performed, self.client_kwargs), (0, {}))

    def test_cowork_hitl_defaults_to_read_only_and_never_persistent_approval(self):
        with patch.dict(driver.os.environ, {'MST_COWORK_APPROVE_WRITE_TOOLS': '0'}):
            self.run_actions([], mode='hitl')
        self.assertIn('Never approve writes or tools with unknown effects', self.planner_request['system'])
        self.assertIn('Never grant persistent access', self.planner_request['system'])
        self.assertIn('Prefer current-task approval', self.planner_request['system'])
        self.assertIn('covers other tools, or could include ineligible writes, use Allow once', self.planner_request['system'])

    def test_cowork_write_opt_in_does_not_allow_persistent_approval(self):
        with patch.dict(driver.os.environ, {'MST_COWORK_APPROVE_WRITE_TOOLS': '1'}):
            self.run_actions([], mode='hitl')
        self.assertIn('explicitly permits tool writes', self.planner_request['system'])
        self.assertIn('Never grant persistent access', self.planner_request['system'])
        self.assertIn('limited to this task and the eligible named tool or tools', self.planner_request['system'])

    def test_cowork_focuses_exact_pinned_bundle_for_submission_and_hitl(self):
        path = '/private/tmp/mst-test/unpacked/Claude.app'
        with patch.dict(driver.os.environ, {'MST_COWORK_APP_PATH': path}):
            for mode in ('submit', 'hitl'):
                self.run_actions([FILL, ENTER], mode=mode)
                self.assertEqual(self.launches[0].args[0], ['open', '-a', path])
                self.assertTrue(self.launches[0].kwargs['check'])

    def test_cowork_refocuses_and_skips_an_action_aimed_at_another_app(self):
        click = {'action': 'left_click', 'coordinate': [10, 10]}
        # Finder came forward; refocusing brings Claude back for the next plan.
        result, count = self.run_actions([click], next_plan=[{'action': 'screenshot'}, FILL, ENTER],
                                         frontmost=['Finder', 'Claude', 'Claude', 'Claude'])
        self.assertEqual(result['status'], 'submitted')
        self.assertEqual(self.executed_actions, [{'action': 'screenshot'}, {'action': 'type', 'text': 'query'}, ENTER])
        self.assertEqual(sum(1 for call in self.launches if call.args[0] == ['open', '-a', 'Claude']), 2)
        feedback = self.planner_request['messages'][2]['content'][0]
        self.assertTrue(feedback['is_error'])
        self.assertIn('Take a fresh screenshot', feedback['content'])
        self.assertEqual(result['telemetry']['refused_action_count'], 1)

    def test_cowork_stops_without_acting_when_it_cannot_refocus(self):
        result, count = self.run_actions([FILL, ENTER], frontmost=['Slack', 'Slack'])
        self.assertIsInstance(result, str)
        self.assertEqual(self.error_code, 'navigation_blocked')
        self.assertEqual(self.executed_actions, [])

    def test_cowork_screenshots_do_not_need_focus(self):
        result, count = self.run_actions([{'action': 'screenshot'}], next_plan=[FILL, ENTER],
                                         frontmost=['Claude', 'Claude'])
        self.assertEqual(result['status'], 'submitted')
        self.assertEqual(self.focus_checks, 2)

    def test_cowork_reset_also_checks_focus(self):
        stop = {'action': 'left_click', 'coordinate': [10, 10]}
        result, count = self.run_actions([stop], mode='reset', frontmost=['Finder', 'Finder'])
        self.assertIsInstance(result, str)
        self.assertEqual(self.executed_actions, [])

    def test_cowork_reset_with_nothing_running_takes_no_action(self):
        result, count = self.run_actions([], mode='reset')
        self.assertEqual(result['status'], 'reset_done')
        self.assertEqual(count, 0)
        self.assertIn('never approve', self.planner_request['system'])
        self.assertNotIn('fill_query', [tool['name'] for tool in self.requested_tools])

    def test_cowork_reset_clicks_stop_then_reports_done(self):
        stop = {'action': 'left_click', 'coordinate': [10, 10]}
        result, count = self.run_actions([stop], mode='reset', next_plan=[])
        self.assertEqual(result['status'], 'reset_done')
        self.assertEqual(self.executed_actions, [stop])

    def test_cowork_reset_never_types_presses_keys_or_drags(self):
        for action in (
            {'action': 'type', 'text': 'x'},
            {'action': 'key', 'text': 'enter'},
            {'action': 'left_click_drag', 'coordinate': [10, 10]},
            {'action': 'double_click', 'coordinate': [10, 10]},
            {'action': 'right_click', 'coordinate': [10, 10]},
        ):
            result, count = self.run_actions([action], mode='reset')
            self.assertIn('Reset cannot type, press keys', result)
            self.assertEqual(self.executed_actions, [])

    def test_cowork_reset_refuses_other_tools(self):
        result, count = self.run_actions([{'tool': 'fill_query', 'input': {}}], mode='reset')
        self.assertIn('Reset cannot type, press keys', result)
        self.assertEqual(self.executed_actions, [])

    def test_cowork_reset_that_only_watches_until_the_budget_fails(self):
        # Never concluding the app is idle is not a reset.
        result, count = self.run_actions([{'action': 'screenshot'}], mode='reset', budget=2)
        self.assertIn('Computer Use reset exceeded 2 actions', result)

    def test_cowork_reset_forbids_send_and_answers(self):
        self.run_actions([], mode='reset')
        prompt = self.planner_request['messages'][0]['content'][0]['text']
        self.assertIn('Never click Send', prompt)
        self.assertIn('do not answer it', prompt)

    def test_cowork_reset_that_keeps_acting_fails(self):
        click = {'action': 'left_click', 'coordinate': [10, 10]}
        result, count = self.run_actions([click], mode='reset', budget=2)
        self.assertIn('Computer Use reset exceeded 2 actions', result)

    def test_chatgpt_reset_is_not_automated(self):
        result, count = self.run_actions([], mode='reset', application='chatgpt')
        self.assertIn('resets are not automated', result)
        self.assertEqual(count, 0)

    def test_cowork_target_model_blocks_fill_without_confirmation(self):
        result, count = self.run_actions([FILL, ENTER], budget=2, target_model='claude-opus-4-6')
        self.assertIsInstance(result, str)
        self.assertEqual(count, 0)
        self.assertEqual(self.error_telemetry['refused_action_count'], 2)

    def test_cowork_rejects_wrong_or_generic_model_confirmation(self):
        for model in ('claude-opus-4-8', 'Opus', 'auto'):
            with self.subTest(model=model):
                result, count = self.run_actions([
                    {'tool': 'confirm_model', 'input': {'model': model}}, FILL, ENTER,
                ], budget=3, target_model='claude-opus-4-6')
                self.assertIsInstance(result, str)
                self.assertEqual(count, 0)
                tool = next(tool for tool in self.requested_tools if tool['name'] == 'confirm_model')
                self.assertEqual(tool['input_schema']['properties']['model']['enum'], ['claude-opus-4-6'])
                self.assertEqual(self.error_telemetry['refused_action_count'], 3)

    def test_cowork_initial_screenshot_can_ground_confirmation(self):
        result, count = self.run_actions([CONFIRM_MODEL, FILL, ENTER], budget=3,
                                        target_model='claude-opus-4-6')
        self.assertEqual(result['status'], 'submitted')
        self.assertEqual(count, 2)
        self.assertEqual(result['action_count'], 3)
        self.assertEqual(result['telemetry']['attempted_action_count'], 2)
        self.assertEqual(result['telemetry']['executed_action_count'], 2)
        instruction = self.planner_request['messages'][0]['content'][0]['text']
        self.assertIn("EXACT model 'claude-opus-4-6'", instruction)
        self.assertIn('Do not open a browser, terminal', instruction)
        self.assertIn('native exact-model verification', instruction)

    def test_cowork_fresh_observed_confirmation_submits_unchanged_query_once(self):
        query = '  Original “query”\n\n[MCP_SERVER_TESTER_marker]\n'
        result, count = self.run_actions([
            {'action': 'left_click', 'coordinate': [5, 5]}, {'action': 'screenshot'},
        ], next_plan=[CONFIRM_MODEL, FILL, ENTER, ENTER], budget=5,
            target_model='claude-opus-4-6', query=query)
        self.assertEqual(result['status'], 'submitted')
        self.assertEqual(count, 4)
        self.assertEqual(self.executed_actions[-2:], [{'action': 'type', 'text': query}, ENTER])
        self.assertEqual(result['telemetry']['executed_action_count'], 4)
        self.assertEqual(result['telemetry']['planner_response_count'], 2)

    def test_cowork_unseen_screenshot_cannot_ground_same_plan_confirmation(self):
        result, count = self.run_actions([
            {'action': 'left_click', 'coordinate': [5, 5]}, {'action': 'screenshot'},
            CONFIRM_MODEL, FILL, ENTER,
        ], budget=5, target_model='claude-opus-4-6')
        self.assertIsInstance(result, str)
        self.assertEqual(count, 2)
        self.assertEqual(self.error_telemetry['refused_action_count'], 3)

    def test_cowork_navigation_invalidates_confirmation_before_fill(self):
        for navigation in ({'action': 'left_click', 'coordinate': [5, 5]},
                           {'action': 'key', 'text': 'Tab'},
                           {'action': 'scroll', 'scroll_direction': 'down'}):
            with self.subTest(navigation=navigation):
                result, count = self.run_actions([CONFIRM_MODEL, navigation, FILL, ENTER],
                                                budget=4, target_model='claude-opus-4-6')
                self.assertIsInstance(result, str)
                self.assertEqual(self.executed_actions, [navigation])
                self.assertEqual(count, 1)

    def test_cowork_unavailable_model_stops_without_input_or_submission(self):
        result, count = self.run_actions([
            {'tool': 'report_blocker', 'input': {'code': 'model_unavailable'}}, FILL, ENTER,
        ], target_model='claude-opus-4-6')
        self.assertIsInstance(result, str)
        self.assertEqual(self.error_code, 'model_unavailable')
        self.assertEqual(count, 0)
        self.assertEqual(self.error_telemetry['attempted_action_count'], 0)

    def test_cowork_model_gate_does_not_apply_to_hitl(self):
        result, count = self.run_actions([], mode='hitl', target_model='claude-opus-4-6')
        self.assertEqual(result['status'], 'hitl_checked')
        self.assertEqual(count, 0)
        self.assertEqual([tool['name'] for tool in self.requested_tools], ['computer'])
        self.assertNotIn('claude-opus-4-6', self.planner_request['messages'][0]['content'][0]['text'])

    def test_chatgpt_ignores_cowork_bundle_override(self):
        with patch.dict(driver.os.environ, {'MST_COWORK_APP_PATH': '/private/tmp/Claude.app'}):
            self.run_actions([FILL, ENTER], application='chatgpt')
            self.assertEqual(self.launches[0].args[0], ['open', '-a', 'ChatGPT'])

    def test_chatgpt_codex_surface_is_consumed_by_planner_not_added_to_query(self):
        query = '  original query\n'
        result, count = self.run_actions([FILL, ENTER], application='chatgpt',
                                        chatgpt_surface='codex', query=query)
        self.assertEqual(result['status'], 'submitted')
        self.assertEqual(count, 2)
        instruction = self.planner_request['messages'][0]['content'][0]['text']
        self.assertIn('Open Codex', instruction)
        self.assertIn('verify its current-mode label', instruction)
        self.assertNotIn('ChatGPT Work', instruction)
        self.assertEqual(self.executed_actions[0], {'action': 'type', 'text': query})

    def test_chatgpt_uses_shared_ai_loop_with_app_model_and_power_instructions(self):
        result, count = self.run_actions([FILL, ENTER, ENTER], application='chatgpt',
                                        target_model='test-chatgpt-model', reasoning_effort='medium')
        self.assertEqual(result['status'], 'submitted')
        self.assertEqual(count, 2)
        self.assertEqual(self.launches[0].args[0], ['open', '-a', 'ChatGPT'])
        instruction = self.planner_request['messages'][0]['content'][0]['text']
        self.assertIn('ChatGPT Work', instruction)
        self.assertIn('test-chatgpt-model', instruction)
        self.assertIn('Standard', instruction)
        self.assertIn('Do not change account settings', instruction)
        self.assertEqual(self.executed_actions[0], {'action': 'type', 'text': 'query'})
        self.assertEqual(self.planner_request['tools'][0]['type'], 'computer_20251124')

    def test_permission_denial_stops_before_planner_launch_or_input(self):
        api, quartz = MagicMock(), MagicMock()
        quartz.CGPreflightScreenCaptureAccess.return_value = False
        with patch.dict(sys.modules, {'Quartz': quartz, 'anthropic': api}), patch.object(driver.subprocess, 'run') as launch, patch.object(driver, 'execute_action') as action:
            with self.assertRaises(driver.ComputerUseDriverError) as failed:
                asyncio.run(driver.run('query', 8, 'submit', 'chatgpt'))
            self.assertEqual(failed.exception.code, 'screen_recording_required')
            self.assertEqual(failed.exception.telemetry['planner_response_count'], 0)
            api.Anthropic.assert_not_called()
            launch.assert_not_called()
            action.assert_not_called()

    def test_accessibility_permission_is_checked_separately(self):
        quartz, framework = MagicMock(), MagicMock()
        quartz.CGPreflightScreenCaptureAccess.return_value = True
        framework.AXIsProcessTrusted.return_value = False
        with patch.dict(sys.modules, {'Quartz': quartz}), patch('ctypes.CDLL', return_value=framework):
            with self.assertRaises(driver.DesktopBlockedError) as failed:
                driver.check_chatgpt_permissions()
            self.assertEqual(failed.exception.code, 'accessibility_required')

    def test_chatgpt_classifies_provider_status_without_exposing_response_content(self):
        error = RuntimeError('sensitive provider response')
        error.status_code = 429
        self.run_actions([{'action': 'screenshot'}], application='chatgpt', planner_error=error)
        self.assertEqual(self.error_code, 'provider_rate_limit')

    def test_screenshot_history_preserves_three_latest_images_and_tool_structure(self):
        images = [{'type': 'image', 'source': {'data': str(i)}} for i in range(6)]
        messages = [{'role': 'user', 'content': [images[0]]},
                    {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': '1', 'content': images[1:]}]}]
        driver.trim_screenshot_history(messages)
        self.assertTrue(all(image['type'] == 'text' for image in images[:3]))
        self.assertEqual([image['source']['data'] for image in images[3:]], ['3', '4', '5'])
        self.assertEqual(messages[1]['content'][0]['tool_use_id'], '1')

    def test_chatgpt_reports_only_a_blocker_code_without_further_actions(self):
        result, count = self.run_actions([{'tool': 'report_blocker', 'input': {'code': 'reasoning_unavailable'}}, FILL, ENTER], application='chatgpt')
        self.assertEqual(self.error_code, 'reasoning_unavailable')
        self.assertEqual(count, 0)
        self.assertEqual(self.error_telemetry['refused_action_count'], 1)

    def test_chatgpt_rejects_automatic_permission_approval(self):
        result, count = self.run_actions([], mode='hitl', application='chatgpt')
        self.assertIn('approvals and resets are not automated', result)
        self.assertEqual(count, 0)
        self.assertEqual(self.launches, [])

    def test_chatgpt_no_click_or_retyping_after_fill(self):
        result, count = self.run_actions([FILL, {'action': 'left_click', 'coordinate': [5, 5]}, FILL, ENTER], application='chatgpt')
        self.assertEqual(result['status'], 'submitted')
        self.assertEqual(count, 2)
        self.assertEqual(result['telemetry']['refused_action_count'], 2)

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
        query = "From the ‘Quarterly Product Metrics’ document, what are monthly and weekly active users?\n\n[MCP_SERVER_TESTER_test-marker]"
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
