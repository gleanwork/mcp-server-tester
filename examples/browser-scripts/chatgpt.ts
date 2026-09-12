/**
 * Sample browser script for ChatGPT.
 *
 * Automates a ChatGPT conversation: types the scenario into the chat input,
 * sends it, approves MCP tool calls, waits for the response, and extracts
 * the text + tool calls.
 *
 * Usage:
 * 1. Obtain a storageState JSON file with your ChatGPT cookies
 *    (e.g., via the extract-cookies script or Playwright codegen)
 * 2. Reference in your eval dataset:
 *    {
 *      "hostType": "browser",
 *      "browser": {
 *        "script": "./examples/browser-scripts/chatgpt.ts",
 *        "storageState": "./auth/chatgpt-state.json",
 *        "headless": false
 *      }
 *    }
 *
 * NOTE: ChatGPT's DOM structure changes frequently. You may need to update
 * the selectors below. Inspect the page and adjust as needed.
 */
import type { Page } from 'playwright';
import type {
  MCPHostSimulationResult,
  LLMToolCall,
} from '../../src/evals/mcpHost/mcpHostTypes.js';

const CHATGPT_URL = 'https://chatgpt.com';

export default async function chatgpt(
  page: Page,
  scenario: string
): Promise<MCPHostSimulationResult> {
  try {
    // Navigate to a fresh ChatGPT conversation
    await page.goto(`${CHATGPT_URL}/?model=gpt-4o`, {
      waitUntil: 'networkidle',
    });

    // Wait for the chat input to appear
    const inputSelector = '#prompt-textarea, [contenteditable="true"]';
    await page.waitForSelector(inputSelector, { timeout: 15_000 });

    // Type the scenario into the chat input
    const input = page.locator(inputSelector).first();
    await input.fill(scenario);

    // Click send button
    await page.locator('button[data-testid="send-button"]').click();

    // Wait briefly for streaming to start
    await page.waitForTimeout(3_000);

    // Approve MCP tool calls (ChatGPT shows "Allow" / "Fetch" buttons)
    await approveToolCalls(page);

    // Wait for the response to finish streaming.
    // The send button reappears when the response is complete.
    await page.waitForSelector('button[data-testid="send-button"]', {
      timeout: 120_000,
    });

    // Extra wait for DOM to settle
    await page.waitForTimeout(2_000);

    // Extract response and tool calls
    const { responseText, toolCalls } = await extractResponse(page);

    return {
      success: true,
      toolCalls,
      response: responseText,
      scenario,
    };
  } catch (err) {
    return {
      success: false,
      toolCalls: [],
      error: `ChatGPT automation failed: ${err instanceof Error ? err.message : String(err)}`,
      scenario,
    };
  }
}

/**
 * Poll for and click MCP tool approval buttons until the response completes.
 * ChatGPT shows "Allow", "Allow once", "Fetch", etc. when MCP tools are invoked.
 */
async function approveToolCalls(
  page: Page,
  maxAttempts = 15,
  waitBetween = 5_000
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Look for approval buttons
    const approvalButton = page
      .locator('button')
      .filter({
        hasText:
          /^(Fetch|Allow|Always allow|Allow once|Allow all|Confirm|Run)$/i,
      })
      .first();

    if (await approvalButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await approvalButton.click();
      await page.waitForTimeout(2_000);
      continue; // Check again for more approval buttons
    }

    // Check if still streaming (stop button visible)
    const stopButton = page.locator(
      'button[aria-label="Stop streaming"], button[aria-label="Stop"]'
    );
    if (await stopButton.isVisible({ timeout: 500 }).catch(() => false)) {
      await page.waitForTimeout(waitBetween);
      continue;
    }

    // Check if response is complete (has substantial content)
    const hasResponse = await page
      .locator('[data-message-author-role="assistant"] .markdown')
      .last()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (hasResponse) {
      return; // Response complete
    }

    await page.waitForTimeout(waitBetween);
  }
}

/**
 * Extract the final response text and any tool calls from the conversation.
 */
async function extractResponse(page: Page): Promise<{
  responseText: string;
  toolCalls: LLMToolCall[];
}> {
  // Get the last assistant message
  const lastMessage = page
    .locator('[data-message-author-role="assistant"]')
    .last();

  let responseText = '';
  if (await lastMessage.isVisible({ timeout: 2_000 }).catch(() => false)) {
    // Prefer markdown content if available
    const markdown = lastMessage.locator('.markdown, .prose').first();
    if (await markdown.isVisible({ timeout: 500 }).catch(() => false)) {
      responseText = await markdown.innerText();
    } else {
      responseText = await lastMessage.innerText();
    }
  }

  // Extract tool calls from the conversation
  const toolCalls: LLMToolCall[] = [];

  // Strategy 1: Look for thinking panel "Searched company knowledge"
  const thinkingButton = page
    .locator('button')
    .filter({ hasText: /^Thought\s+for|^Thinking/i })
    .first();
  if (await thinkingButton.isVisible({ timeout: 500 }).catch(() => false)) {
    await thinkingButton.click();
    await page.waitForTimeout(1_000);

    const thinkingText = await thinkingButton
      .locator('..')
      .locator('..')
      .innerText()
      .catch(() => '');
    if (thinkingText.includes('Searched company knowledge')) {
      toolCalls.push({ name: 'search', arguments: {} });
    }
  }

  // Strategy 2: Look for agent turn with citations
  if (toolCalls.length === 0) {
    const agentTurn = page.locator('.agent-turn').last();
    if (await agentTurn.isVisible({ timeout: 500 }).catch(() => false)) {
      const links = await agentTurn.locator('a[href]').count();
      if (links > 0) {
        toolCalls.push({ name: 'search', arguments: {} });
      }
    }
  }

  // Strategy 3: Look for tool-call UI elements (expandable sections, etc.)
  const toolIndicators = page.locator(
    '[data-message-author-role="assistant"] details, [data-message-author-role="assistant"] [class*="tool"]'
  );
  const toolCount = await toolIndicators.count();

  for (let i = 0; i < toolCount; i++) {
    const toolEl = toolIndicators.nth(i);
    const toolText = await toolEl.innerText().catch(() => '');
    const nameMatch = /^(?:Used\s+)?(\w+)/.exec(toolText);
    if (nameMatch && nameMatch[1]) {
      // Avoid duplicates
      const name = nameMatch[1];
      if (!toolCalls.some((tc) => tc.name === name)) {
        toolCalls.push({ name, arguments: {} });
      }
    }
  }

  return { responseText: responseText.trim(), toolCalls };
}
