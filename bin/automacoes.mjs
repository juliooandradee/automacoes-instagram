#!/usr/bin/env node
// Automações do Instagram. Ajuda: npm run ajuda
import { main } from '../src/cli.mjs';

process.exitCode = await main(process.argv.slice(2));
