export default {
  '*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}': [
    'eslint --fix --max-warnings=0 --no-warn-ignored',
    'prettier --write',
  ],
  '*.{json,jsonc,md,yml,yaml,css,html}': ['prettier --write --ignore-unknown'],
};
