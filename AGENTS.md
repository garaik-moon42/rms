# AGENTS.md

## Project Overview

This repository is a Google Apps Script based registry system for a Google Sheet. It processes unread Gmail inbox attachments, uploads them to Google Drive, writes registry rows into the `REGISTRY` sheet, enriches rows with OpenAI-based document classification, and provides a sidebar tool for monthly accounting exports.

Important source files:

- `src/code.ts`: main registry workflow, menu setup, Gmail/Drive/Sheet orchestration.
- `src/ai.ts`: OpenAI document analysis and field extraction.
- `src/accounting-export.ts`: backend for the monthly accounting export.
- `src/accounting-export-sidebar.html`: Google Sheets sidebar UI for the accounting export.
- `appsscript.json`: Apps Script manifest and OAuth scopes.
- `scripts/copy-manifest.mjs`: copies manifest and HTML sidebar files into `build/`.

The TypeScript compiler uses `module: "none"` for Google Apps Script. Do not add `import` or `export` to files under `src/`; top-level functions and constants are intentionally global.

## Build And Deploy Commands

- Install dependencies: `npm install`
- Build: `npm run build`
- Watch TypeScript: `npm run watch`
- Push to Apps Script: `npm run push`
- Pull from Apps Script: `npm run pull`

Always run `npm run build` after code changes. The build must produce JavaScript and copied HTML/manifest files under `build/`.

Do not edit generated files in `build/` directly. Edit `src/`, `appsscript.json`, or `scripts/`, then rebuild.

## Apps Script Conventions

- Keep Apps Script entrypoint functions global, for example `processUnreadInboxAttachments`, `showAccountingExportSidebar`, `previewAccountingExport`, and `copyAccountingExport`.
- Use `SpreadsheetApp`, `GmailApp`, `DriveApp`, `LockService`, `PropertiesService`, `CacheService`, `HtmlService`, `UrlFetchApp`, and `Utilities` directly; these are Apps Script globals.
- When adding a sidebar or dialog, ensure the manifest has the needed UI scope: `https://www.googleapis.com/auth/script.container.ui`.
- When adding an HTML sidebar file under `src/`, make sure `scripts/copy-manifest.mjs` still copies `src/*.html` into `build/`.
- Apps Script sidebars can behave badly when the browser is logged into multiple Google accounts. If `google.script.run` returns `Authorization is required` despite scopes being correct, test in a browser profile or incognito window with only the target Google account signed in.

## Registry Data Rules

- The registry sheet name is `REGISTRY`.
- The header order is controlled by `REGISTRY_HEADERS` in `src/code.ts`; keep column constants in sync with this array.
- New registry rows are inserted below the header, newest rows at the top.
- Registry numbers use the `R0000001` format.
- The top data row must hold the highest/latest registry number so future numbering remains unique.
- Uploaded Drive files are named with the registry number prefix: `R0000001_original-file-name.ext`.
- Email and attachment metadata are stored as JSON in the `meta` column.
- Deduplication uses `metaMessageId` and `metaAttachmentIndex` first, with legacy `meta` JSON fallback.

## Accounting Export Rules

- The accounting export is opened from `Iktatás > Számlák letöltése a könyvelésnek`.
- Month filtering is based on the `refDate` column, not email date or due date.
- The target Drive folder must be empty before copy starts; copying must re-check this server-side.
- Eligible rows require `seq`, `partner`, `type`, `googleDriveId`, and valid `refDate`.
- Target file names use `partner_seq_type_YYYYMM_originalFileName`.
- File-name parts must be normalized for Drive safety: remove accents, replace spaces and unsafe characters with `_`, collapse repeated `_`, and trim separators.
- Copy progress is stored in user cache via `CacheService`; keep progress data small and temporary.

## OpenAI And Security

- OpenAI API keys are stored in Script Properties under `OPENAI_API_KEY`.
- Do not commit real `.clasp.json`, API keys, folder IDs that should be private, or sample data containing personal/business-sensitive information.
- OpenAI calls use `UrlFetchApp` directly and the Responses API with structured JSON output.
- AI-filled registry fields are suggestions and require human review.

## Code Style

- TypeScript strict mode is enabled.
- Prefer existing constants and helpers over duplicating column numbers, sheet names, or property names.
- Keep code compatible with Apps Script V8 and ES2019.
- Use Hungarian UI text consistently for user-facing Sheet/sidebar messages.
- Keep comments sparse and useful; prefer clear function names and small helpers.
- Avoid broad refactors when making focused changes.

## Testing Instructions

- Run `npm run build` before finishing any change.
- For UI/sidebar changes, confirm that the relevant `.html` file appears in `build/` after build.
- For manifest changes, confirm `build/appsscript.json` contains the same scopes/settings as `appsscript.json`.
- Manual Apps Script checks may be needed for Gmail, Drive, Spreadsheet UI, and sidebar behavior because there is no local Apps Script test harness.

## Deployment Notes

- `npm run push` builds first, then runs `clasp push`.
- A new or changed OAuth scope usually requires reauthorization in Google Apps Script.
- Reload the bound Google Sheet after pushing menu or sidebar changes.
- The local `.clasp.json` is intentionally not versioned; use `.clasp.json.example` as the template.
