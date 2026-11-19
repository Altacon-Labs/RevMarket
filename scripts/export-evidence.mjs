// Operator command: copy the exact stored evidence bytes for one recorded digest into an existing directory.
// Usage: node scripts/export-evidence.mjs <digest> --out <dir> [--root <dir>]
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { exportEvidence, EvidenceExportError } from '../service/evidence-export.mjs';

const usage = 'Usage: npm run evidence:export -- <digest> --out <dir> [--root <dir>]\n'
  + 'The evidence root is --root, then EVIDENCE_DIR, then service/evidence/. The output directory must already exist.';
const defaultRoot = fileURLToPath(new URL('../service/evidence/', import.meta.url));

function failWith(code, message) {
  console.error(`evidence:export failed [${code}]: ${message}`);
  process.exitCode = 1;
}

let args;
try {
  args = parseArgs({
    strict: true,
    allowPositionals: true,
    tokens: true,
    options: {out: {type: 'string'}, root: {type: 'string'}, help: {type: 'boolean', short: 'h'}},
  });
  const seen = new Set();
  for (const token of args.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new Error(`--${token.name} was given more than once`);
    seen.add(token.name);
  }
} catch (e) {
  args = undefined;
  failWith('USAGE', `${e.message}\n${usage}`);
}

if (args?.values.help) {
  console.log(usage);
} else if (args) {
  const {positionals, values} = args;
  if (positionals.length !== 1) failWith('USAGE', `expected exactly one digest argument\n${usage}`);
  else if (!values.out) failWith('USAGE', `--out <dir> is required\n${usage}`);
  else {
    try {
      const root = values.root ?? (process.env.EVIDENCE_DIR || defaultRoot);
      const result = await exportEvidence({root, digest: positionals[0], out: values.out});
      console.log(JSON.stringify(result));
    } catch (e) {
      if (e instanceof EvidenceExportError) failWith(e.code, e.message);
      else failWith(e.code ? `IO_${e.code}` : 'UNEXPECTED', e.message);
    }
  }
}
