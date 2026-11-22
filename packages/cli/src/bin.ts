#!/usr/bin/env node
import { buildProgram } from './commands/index.js';

buildProgram()
  .parseAsync(process.argv)
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
