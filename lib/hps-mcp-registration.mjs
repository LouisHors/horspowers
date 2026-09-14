import path from 'node:path';

export const SUPPORTED_HOSTS = Object.freeze(['claude', 'codex', 'opencode']);

function assertInstallationRoot(installationRoot) {
  if (typeof installationRoot !== 'string' || !path.isAbsolute(installationRoot)) {
    throw new TypeError('installation root must be an absolute installation root discovered by the host');
  }
  if (installationRoot.split(/[\\/]/u).some((segment) => segment === '..' || segment === '.')) {
    throw new TypeError('installation root must be a normalized native installation root');
  }
  const root = path.resolve(installationRoot);
  if (root === path.parse(root).root) {
    throw new TypeError('installation root must point to the native plugin installation, not filesystem root');
  }
  return root;
}

export function renderMcpRegistration(host, installationRoot) {
  if (!SUPPORTED_HOSTS.includes(host)) throw new RangeError(`unsupported host: ${host}`);
  const root = assertInstallationRoot(installationRoot);
  const command = path.join(root, 'bin', 'hps');
  if (host === 'claude') {
    return { mcpServers: { hps: { command, args: ['serve', '--stdio'] } } };
  }
  if (host === 'codex') {
    return { mcp_servers: { hps: { command, args: ['serve', '--stdio'] } } };
  }
  return { mcp: { hps: { type: 'local', command: [command, 'serve', '--stdio'], enabled: true } } };
}

export function renderMcpTemplate(host) {
  if (!SUPPORTED_HOSTS.includes(host)) throw new RangeError(`unsupported host: ${host}`);
  return renderMcpRegistration(host, '/__HPS_INSTALL_ROOT__');
}
