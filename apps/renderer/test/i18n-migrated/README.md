# i18n-migrated

Each lane owns one JSON file here (`shell.json`, `script.json`, `assets.json`, `storyboard.json`,
`generate.json`, `export.json`, `canvas.json`, `home.json`). The file is an array of paths relative to
`apps/renderer/src/`. `test/i18nLiterals.test.js` checks every registered `.vue` / `.js` file:

- `<template>`: after removing `t(...)` / `$t(...)` calls and HTML comments, no Chinese characters may remain
  (text, `{{ }}` string literals and bound attributes are all checked).
- `<script>` / `.js`: no string literal (quotes, backticks) may contain Chinese characters. Comments are ignored.
- A line containing `i18n-ignore` (in a `//` comment, or in a template `<!-- -->` comment) is skipped.
  Use it only for text that must stay Chinese (e.g. the `中文` language name, test fixtures).

Entries may use wildcards: `components/script/*` (one level), `shell/**` (recursive), `shell/actions/*.js`.
An entry without a wildcard must exist.

When a lane finishes migrating a file, add it to its own json. Do not register files you have not fully migrated.
