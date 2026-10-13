import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const result=spawnSync(process.execPath,['--test','tests/unit/core/*.test.cjs','tests/integration/core/*.test.cjs'],{stdio:'inherit',env:{...process.env,AI1_BUILD_DIR:resolve('dist/backend')}});
process.exit(result.status??1);
