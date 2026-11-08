import type { ReactNode } from 'react';
import { McpInstallButton } from 'docusaurus-plugin-mcp-server/theme';

interface McpInstallNavbarItemProps {
  mobile?: boolean;
}

/**
 * The plugin's install button. With no props it reads the server URL and name
 * from the plugin's global data, so it always points at this site's /mcp.
 */
export default function McpInstallNavbarItem({
  mobile,
}: McpInstallNavbarItemProps): ReactNode {
  // The dropdown is built for the desktop navbar; hide it in the mobile sidebar.
  if (mobile) {
    return null;
  }
  // navbar__item hides it on narrow screens along with the other right-hand items.
  return (
    <div className="navbar__item">
      <McpInstallButton
        label="Install MCP"
        headerText="Connect the MST docs to:"
      />
    </div>
  );
}
