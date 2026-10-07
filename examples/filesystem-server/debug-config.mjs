import { Project } from 'fixturify-project';
import {
  createMCPClientForConfig,
  closeMCPClient,
} from '@gleanwork/mcp-server-tester';

const project = new Project('debug-test', '1.0.0', {
  files: {
    'config.json': JSON.stringify(
      { version: '1.0.0', features: ['a', 'b'] },
      null,
      2
    ),
  },
});
await project.write();

const config = {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', project.baseDir],
  cwd: project.baseDir,
};

const client = await createMCPClientForConfig(config);

try {
  const result = await client.callTool({
    name: 'read_file',
    arguments: { path: 'config.json' },
  });

  console.log('Full result:', JSON.stringify(result, null, 2));
  console.log('\nText content:', result.content?.[0]?.text);
} catch (error) {
  console.error('Error:', error.message);
} finally {
  await closeMCPClient(client);
  project.dispose();
}
