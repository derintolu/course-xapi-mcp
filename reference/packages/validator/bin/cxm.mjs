#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The `cxm` command.
import { runCli } from '../src/cli.ts';

process.exitCode = await runCli(process.argv.slice(2));
