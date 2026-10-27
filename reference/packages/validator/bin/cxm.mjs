// SPDX-License-Identifier: Apache-2.0
// The `cxm` command. Run it with node: the licence rule keeps the SPDX line first, so there is no shebang.
import { runCli } from '../src/cli.ts';

process.exitCode = await runCli(process.argv.slice(2));
