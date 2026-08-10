#!/usr/bin/env node
import { InputContractError, routeRequest } from '../../../lib/workflow-router.mjs';

if (process.argv.length !== 2) {
  console.error('route-request.mjs accepts JSON on stdin only');
  process.exit(64);
}

try {
  process.stdin.setEncoding('utf8');
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new InputContractError('route-request.mjs received malformed JSON on stdin');
  }
  const result = await routeRequest(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(error && error.exitCode ? error.exitCode : 1);
}
