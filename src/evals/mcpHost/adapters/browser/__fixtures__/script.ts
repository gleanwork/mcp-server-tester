import type { Page } from 'playwright';

export default async function browserScript(
  _page: Page,
  scenario: string
): Promise<unknown> {
  if (scenario === 'reject') throw new Error('script rejection');
  if (scenario === 'invalid') return null;
  if (scenario === 'timeout') return new Promise<never>(() => {});
  return { success: true, toolCalls: [] };
}
