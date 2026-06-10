// Config files (*.config.ts, *.config.js, …) are eslint-ignored by policy
// (see .eslintrc `ignorePatterns`). lint-staged must NOT pass them to eslint:
// eslint 8 emits a "File ignored because of a matching ignore pattern" WARNING
// for an explicitly-passed ignored file, and `--max-warnings=0` turns that into
// a failed commit. So editing any vite/vitest/tailwind config used to be
// uncommittable. Here we filter those out of the eslint task while still letting
// prettier format them — identical behavior to the old JSON config otherwise.
const isEslintIgnored = (f) => /\.config\.(c|m)?(ts|js|tsx|jsx)$/.test(f);
const quote = (f) => `"${f}"`;

module.exports = {
  '*.{ts,tsx}': (files) => {
    const lintable = files.filter((f) => !isEslintIgnored(f));
    const cmds = [];
    if (lintable.length) {
      cmds.push(`eslint --fix --max-warnings=0 ${lintable.map(quote).join(' ')}`);
    }
    cmds.push(`prettier --write ${files.map(quote).join(' ')}`);
    return cmds;
  },
  '*.{json,md,yaml,yml,css,html}': (files) => `prettier --write ${files.map(quote).join(' ')}`,
};
