const mode = process.argv[2];

if (mode === 'pass') {
  process.stdout.write('fixture passed\n');
} else if (mode === 'fail') {
  process.stderr.write('token=synthetic-secret\nfixture failed\n');
  process.exitCode = 2;
} else if (mode === 'output') {
  process.stdout.write('x'.repeat(32_000));
  process.stderr.write('y'.repeat(16_000));
} else if (mode === 'wait') {
  setInterval(() => {}, 1_000);
} else {
  process.exitCode = 3;
}
