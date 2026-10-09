import assert from 'node:assert/strict';
import fs from 'node:fs';

const installer = fs.readFileSync(new URL('../install-hub.sh', import.meta.url), 'utf8');
assert.match(installer, /SUPPORT_ENV_FILE=\$\{HUB_SUPPORT_ENV_FILE:-\/etc\/wickhunter-hub\/support\.env\}/,
  'the support bridge has a stable default path and can be overridden for an isolated install');
assert.match(installer, /"EnvironmentFile=-\$SUPPORT_ENV_FILE"/,
  'regenerating the Hub unit must retain optional support configuration');
assert.match(installer, /"EnvironmentFile=\$ENV_FILE"[\s\S]*"EnvironmentFile=-\$MARKETPLACE_BRIDGE_ENV_FILE"[\s\S]*"EnvironmentFile=-\$SUPPORT_ENV_FILE"/,
  'the Hub unit loads its primary, Marketplace bridge, and support environment files');

console.log('Hub installer keeps the optional support EnvironmentFile in its generated unit');
