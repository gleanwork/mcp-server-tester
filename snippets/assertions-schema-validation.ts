import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { z } from 'zod';

const UserSchema = z.object({ id: z.string(), name: z.string() });

test('schema validation', async ({ mcp }) => {
  const result = await mcp.callTool('get_user', { userId: '123' });
  expect(result).toMatchToolSchema(UserSchema);
});
