/** The MCP endpoint in mcp.mjs, as the scripts that call it in-process see it. */
declare const handler: {
  fetch(request: Request): Promise<Response>;
};
export default handler;
