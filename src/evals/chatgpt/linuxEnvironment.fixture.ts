import { join } from 'node:path';

/** A syntactically complete Scio -> MST Linux environment for offline tests. */
export function linuxEnvironment(home: string): Record<string, string> {
  return {
    HOME: home,
    XDG_RUNTIME_DIR: join(home, 'run'),
    TMPDIR: join(home, 'tmp'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local/state'),
    DISPLAY: ':1',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture/bus',
    AT_SPI_BUS_ADDRESS: 'unix:path=/fixture/a11y',
    GNOME_KEYRING_CONTROL: join(home, 'run/keyring'),
    MST_CHATGPT_APP_PATH: '/usr/bin/chatgpt',
    MST_CHATGPT_CODEX_PATH: '/opt/chatgpt/codex',
    MST_CHATGPT_API_KEY_FILE: join(home, 'run/key'),
    MST_CHATGPT_EVIDENCE_DIR: join(home, 'evidence'),
  };
}
