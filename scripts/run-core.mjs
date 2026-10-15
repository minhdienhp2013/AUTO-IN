import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// Core PostgreSQL integration files share one disposable database and reapply migrations.
// Serialize files to avoid cross-file DDL deadlocks; concurrency/race assertions inside each file remain unchanged.
const result=spawnSync(process.execPath,['--test','--test-concurrency=1','tests/unit/core/*.test.cjs','tests/integration/core/*.test.cjs'],{stdio:'inherit',env:{...process.env,AI1_BUILD_DIR:resolve('dist/backend')}});
process.exit(result.status??1);
