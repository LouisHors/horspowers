const mode = process.argv[2];
if (mode === 'stdin') {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(input);
  process.exit(0);
}
process.stdout.write(mode === 'sleep' ? 'before timeout\n' : 'fixture stdout\n');
process.stderr.write(mode === 'sleep' ? 'before timeout\n' : 'fixture stderr\n');
if (mode === 'sleep') {
  setTimeout(() => {}, 10_000);
}
