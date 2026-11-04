// Parse the entire request before initializing the backend or running an operation.
// Keep this module free of system access so malformed commands cannot change anything.
const COMMANDS = {
  '--snapshot': { values: 1, options: ['--preset'], missing: 'Give the snapshot a name: --snapshot "Before installing X"' },
  '--compare': { values: 2, options: ['--report'], missing: 'Name two snapshots to compare, or a snapshot and "now".' },
  '--list-snapshots': { values: 0, options: [] },
  '--monitor': { values: 1, options: ['--name'], missing: 'Name the installer: --monitor "C:\\Downloads\\setup.exe"' },
  '--maintenance': { values: 0, options: [] },
  '--autostart': { values: 1, options: [], missing: 'Use --autostart on or --autostart off.' },
  '--help': { values: 0, options: [] },
};

const isOption = (arg) => arg.startsWith('-') || arg === '/?';
const isValue = (arg) => arg !== undefined && arg.trim() !== '' && !isOption(arg);

/**
 * Validate a complete Purgeon command line without performing any I/O.
 * Returns { command, values, options }; throws an actionable Error for invalid input.
 * For example, parseCliArgs(['--snapshot', 'Before', '--preset', 'quick']).
 */
export function parseCliArgs(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('Command-line arguments must be text without NUL characters.');
  }
  const first = (args[0] ?? '--help').toLowerCase();
  const command = first === '-h' || first === '/?' ? '--help' : first;
  if (!Object.hasOwn(COMMANDS, command)) throw new Error(`Unknown command "${args[0]}". Use --help for available commands.`);
  const spec = COMMANDS[command];
  const values = [];
  const options = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!isOption(arg)) {
      if (!isValue(arg) || values.length >= spec.values) throw new Error(`Unexpected argument "${arg}" for ${command}.`);
      values.push(arg);
      continue;
    }
    const key = arg.toLowerCase();
    if (Object.hasOwn(COMMANDS, key) || key === '-h' || key === '/?') {
      throw new Error('Use one command at a time. Run --help on its own for help.');
    }
    if (!spec.options.includes(key)) throw new Error(`Unknown option "${arg}" for ${command}. Use --help for available options.`);
    if (Object.hasOwn(options, key)) throw new Error(`Use ${key} only once.`);
    if (!isValue(args[i + 1])) throw new Error(`Give ${key} a value.`);
    options[key] = args[++i];
  }
  if (values.length !== spec.values) throw new Error(spec.missing);
  if (command === '--snapshot' && !['quick', 'standard', 'deep'].includes(options['--preset'] ?? 'standard')) {
    throw new Error('--preset must be quick, standard or deep.');
  }
  if (command === '--autostart' && !['on', 'off'].includes(values[0].toLowerCase())) {
    throw new Error('Use --autostart on or --autostart off.');
  }
  return { command, values, options };
}
