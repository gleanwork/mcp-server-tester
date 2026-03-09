import {
  createTokenAuthHeaders,
  validateAccessToken,
  isTokenExpired,
  isTokenExpiringSoon,
} from '@gleanwork/mcp-server-tester';

const token = process.env.MCP_ACCESS_TOKEN;
const expiresAt = Number(process.env.MCP_TOKEN_EXPIRES_AT);

// Create auth headers — { Authorization: 'Bearer eyJ...' }
const _headers = createTokenAuthHeaders(token);

// Validate token is present (throws if missing or empty)
validateAccessToken(token);

// Check JWT expiration (best-effort)
if (isTokenExpired(token)) {
  console.log('Token has expired');
}

// Check if token expires within buffer time
if (isTokenExpiringSoon(expiresAt, 60000)) {
  console.log('Token expires within 1 minute');
}
