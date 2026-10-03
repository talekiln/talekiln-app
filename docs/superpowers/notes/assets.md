# Assets lane (T7) notes

Characters, scenes and props now live in one place: `useAssetsStore` (`src/stores/assets.js`), a collapsible
`<AssetPanel/>` (usable in every view) and the `/p/:dramaId/assets` page (`src/views/AssetLibrary.vue`).

## How other lanes use it

- Mount `<AssetPanel @pick="..." @select="..."/>` in the view. It renders only when `shell.assetsPanelOpen` is true,
  so the view decides when to open it (`shell.openAssetsPanel()`). `pick` gives `{ kind, asset, token }`, where `token`
  is `@name` for characters and `#location·time` for scenes and `#name` for props (`mentionToken` in `utils/assets.js`).
- Dialogs (via `openDialog` from `@/shell/dialogs`):
  - `assets.pick` `{ kinds?, kind? }` -> `{ kind, asset, token } | undefined`
  - `assets.edit` `{ kind, id? }` -> create (no id) or edit
  - `assets.extract` `{ outline? }` -> `{ extracted: [kind] }`
  - `assets.globalLibrary` `{ kind?, scope? }` -> `{ imported, kind }`. Browse + import only, scope `global` or `project`.
    The home lane can open it, or keep its own `GlobalLibraryPanel` (which owns edit and delete of library items).
- Actions: `assets.extract`, `assets.importFromGlobal`, `assets.create`.
- Store helpers other lanes can call: `byKind`, `counts`, `find(kind,id)`, `resolveMention(token)`, `refs(shot)`,
  `isLocked`, `load(dramaId)`, `reload()`. Pure helpers: `refsForShot`, `affectedShots`, `searchAssets`.
- Components load assets themselves (`useAssetContext`), but the store is keyed by drama, so a view that only needs
  the data can call `useAssetsStore().load(dramaId)`.

## Parity table (legacy -> new location)

| Legacy feature | New location | Status |
| --- | --- | --- |
| Character CRUD (FilmCreate/DramaDetail) | AssetFormDialog + AssetDetail | done |
| Scene CRUD | same | done |
| Prop CRUD | same | done |
| Reference image upload (single) | AssetFormDialog "reference image" | done |
| Multi-image upload, extra images, set primary, remove | AssetImages | done |
| AI image generation (char / scene / prop) | AssetImages | done, gated (see below) |
| AI prompt generation (polished prompt, single prompt) | AssetFormDialog | done |
| Extract appearance/description from image | AssetFormDialog | done |
| Extract identity anchors (polling) | AssetFormDialog (characters) | done, read-only display |
| Extract characters / scenes / props from script | AssetExtractDialog | done |
| Add to project library / global material library | AssetDetail "Material library" | done |
| Import from library | GlobalLibraryDialog | done (project + global scope) |
| Reference candidates (4) + lock / unlock (ReferenceLibrary.vue) | AssetCandidates | done (characters, scenes) |
| Auto-pick best reference | AssetCandidates | done |
| SD2 certification + voice reference | AssetDetail | done |
| Shots that use an asset, regenerate them | AssetUsage | done, uses the shot queue |
| Asset counts in the shell | store `counts` | done |

## Gaps

- Props cannot lock a reference: the backend lock API only supports character and scene. The detail view says so.
- Quad-grid option (`use_quad_grid`) is not exposed: the backend ignores it.
- Team library (`add-to-team-library`) is not exposed; the legacy pages did not expose it either, and it returns 501 on
  studios that do not support it.
- `identity_anchors` is shown read-only: `PUT /characters/:id` ignores it. It can only be refreshed by extraction.
- The media tab (MediaLibrary) stays with the home lane (T11).
- Library edit / delete is not duplicated; it lives in the home lane's `GlobalLibraryPanel`.
- The art style is not passed on asset image generation. The shell `style` format was unclear; the backend falls back
  to the project style.
- Legacy `ReferenceLibrary.vue` and the `/project/:dramaId/library` route are untouched until legacy cleanup.
  `utils/referenceLibrary.js` must stay (AssetCandidates and `test/shotWorkbench.test.js` use it).

## Decisions and deviations

- Asset image generation: the generation queue only supports shot image/video, so asset images keep the legacy
  synchronous routes (`/characters/:id/generate-image`, `/scenes/generate-image`, `/props/:id/generate`, `/images`
  for candidates). Every one of these is disabled, with an explanation, unless `generation.legacy_enabled === true`
  (from `GET /episodes/:id/generation/status`; false or unknown means disabled). A 402 (spend limit) is handled
  inline with a message, never as a popup. Text AI actions (prompts, extraction, auto-pick) are not gated.
  "Regenerate related shots" goes through the queue (`approveBatch` + `queueShot` with `regenerate: true`).
- Characters are created without `episode_id`: sending it would replace `episode_characters`. Scenes and props get
  the episode from `pickEpisodeId` (route, then last view, then first episode).
- Library item -> asset conversion (`libraryItemToAsset`) copies text and image; `time` and `type` are kept when present.

## Verification

Unit tests: `assetPanelModel`, `assetGeneration`, `assetsStore`, `assetForm`, plus `i18n*` and `shotWorkbench`.
Components are checked by the i18n literal test (`test/i18n-migrated/assets.json`) and by compiling each file
through the Vite dev server; see the lane report for whether the browser walkthrough could be done.
