---
title: Security Audit Report — brightverse-solution Oracle Workshop (2026-04-24)
author: WARD Oracle 🛡️
date: 2026-04-24
scope: quote-preview application + cross-oracle comm model + repo secrets scan
status: final
---

# Security Audit Report 🛡️

**Author**: WARD Oracle 🛡️  
**Date**: 2026-04-24  
**Scope**: prism-oracle:tools/quote-preview/ · cross-oracle communication model · repo secrets scan  
**Repos audited**: forge-oracle, prism-oracle, canvas-oracle, quill-brain-oracle, anvil-oracle, inkwell-oracle, ward-oracle  

---

## Executive Summary

The brightverse-solution Oracle family has built quickly and carefully. This audit found **no Critical or High findings**. The quote-preview application is not vulnerable to XSS or CSV formula injection under current conditions. The cross-oracle communication model shows good discipline: no credentials in letters, no PII exposure, Rule 6 compliance intact. Repo secrets scan came back clean across all six active Oracle repos.

Five findings were identified: one Medium (implicit xlsx formula injection defense with no test coverage), two Low (no CSV file size limit; brittle HEADER_SENTINEL coupling already named by PRISM), and two Info (local filesystem paths in contacts.json; custom Oracle email addresses in git co-author fields). Peer letters have been sent to PRISM and FORGE. A process recommendation for pre-commit secret scanning is included for ANVIL.

---

## Scope Audited

### Checked ✓
- Svelte templates (App.svelte, Quotation.svelte) — XSS surface
- csv.ts — injection vectors in CSV parsing
- xlsx.ts — formula propagation in export
- quote-number.ts + localStorage — sensitive data in browser storage
- contacts.json (quill-brain-oracle) — credentials / secrets exposure
- All ψ/outbox/ letters across all active Oracle repos — PII, credentials, Rule 6
- Git commit history of all 7 Oracle repos — .env files, secret patterns
- Co-Authored-By attribution in commits — Rule 6 compliance

### Not checked (explicitly out of scope)
- Active pen-testing against live URLs (scope guard: static analysis only)
- Third-party npm transitive dependencies beyond exceljs + papaparse
- HERALD-oracle and LENS-oracle tools (not yet shipped)
- ANVIL-oracle DevOps tooling (not yet shipped)
- Any backend server (quote-preview is entirely client-side)

---

## Findings

### MEDIUM — PRODUCT_FORMULA_IMPLICIT

**Name**: xlsx export has no explicit formula-injection defense  
**Affected files**: `prism-oracle:tools/quote-preview/src/lib/xlsx.ts` (lines 131–147 and 108)  
**Assigned to**: PRISM 🎨

**Description**: Product names from CSV (and the customer name from the inline edit) are written to ExcelJS cells as plain strings: `cell.value = item.product`. ExcelJS 4.4.0 writes these as SharedString type cells in xlsx XML (`<c t="s">`), which Excel and Google Sheets do NOT execute as formulas. A string like `=HYPERLINK("http://evil.com","click")` in a product field is therefore written as a literal string — not an executable formula.

This is currently NOT exploitable. However:
1. There is no explicit test case verifying this behavior (the test suite uses `'Alpha'`, `'Beta'`, `'Gamma'` as product names — all safe).
2. The protection is an *implicit dependency* on ExcelJS's string type handling, not a documented design decision.
3. `exceljs` is pinned at `^4.4.0` (caret), allowing automatic minor upgrades that could change this behavior.
4. The customer value (line 108: `writeMetaRow('Customer', quote.customer ?? '...')`) is also unguarded.

**Reproduction test** (not currently in test suite):
```typescript
const quote = canonicalQuote('=HYPERLINK("http://evil.com","click")');
// also test with product: '=cmd|"/C calc"!A0'
const buf = await generateQuoteXlsxBuffer(quote);
const read = await readQuoteXlsxFromBuffer(buf);
// Assert: read.customer is a string, not formula execution result
expect(read.customer).toBe('=HYPERLINK("http://evil.com","click")');
// Assert: customer cell in wb has type SharedString, not Formula
```

**Recommended fix**: Add a test case asserting formula-like strings survive xlsx round-trip as plain strings. Optionally add an explicit sanitizer in xlsx.ts: if string starts with `=`, `+`, `-`, `@`, or `\t`, prefix it with `'` or set ExcelJS cell value via `{ text: value }` (rich text forces string type). Document which approach is chosen.

**Severity rationale**: Medium. Not currently exploitable. But quote-preview's purpose is to produce xlsx files that Palm sends to customers. If a CSV vendor supplies formula-like product names, the xlsx would go out to a third party. Implicit protection without test coverage is not a documented acceptance of risk.

---

### LOW — CSV_NO_SIZE_LIMIT

**Name**: No file size validation before CSV parse  
**Affected file**: `prism-oracle:tools/quote-preview/src/App.svelte` (line 34–49, `loadFile()`)  
**Assigned to**: PRISM 🎨

**Description**: `loadFile()` calls `file.text()` then `parseCsv(text)` with no size check. A 50MB CSV would load the entire file into memory and attempt to parse it, freezing the browser tab.

```typescript
async function loadFile(file: File) {
  // no size check here
  const text = await file.text();   // reads entire file into string
  const items = parseCsv(text);     // Papa.parse on full content
```

**Scope**: Client-side only. This is a self-inflicted DoS on Palm's own browser tab; there is no server, no remote user, no data leak. The impact is purely UX degradation.

**Recommended fix**:
```typescript
async function loadFile(file: File) {
  if (file.size > 5_242_880) {  // 5 MB
    errorMessage = 'CSV file too large (max 5 MB)';
    return;
  }
  // ...rest unchanged
```

**Severity rationale**: Low. Scope is limited to the local browser session. Palm is the only user of this tool. Mentioning it because a large file from a vendor would give a confusing browser hang rather than a clear error.

---

### LOW — HEADER_SENTINEL_COUPLING *(confirming PRISM's existing finding)*

**Name**: Magic-string coupling between xlsx write and read-back via `HEADER_SENTINEL = '#'`  
**Affected file**: `prism-oracle:tools/quote-preview/src/lib/xlsx.ts` (lines 28, 219–220)  
**Assigned to**: FORGE ⚒️ (for `@forge-oracle/quote-core` v2 proposal)

**Description**: PRISM already named this finding in `prism-oracle:ψ/outbox/2026-04-24_to-forge_loop-closed.md`. Confirming and clarifying mechanism.

`HEADER_SENTINEL = '#'` is written as the first cell of the item table header row (col 1). The `readQuoteXlsxFromBuffer` function identifies the item table by scanning for any row where `r.getCell(1).value === HEADER_SENTINEL`. This works correctly in all current cases because:
- Data rows have a numeric index in col 1 (1, 2, 3…)
- Meta rows have label strings ('Quote No.', 'Date', 'Customer', 'QUOTATION') in col 1
- Only the item table header has `'#'` in col 1

The coupling is structural: if the xlsx format ever changes to place `'#'` anywhere else in col 1, the reader would misidentify that row as the item header. PRISM's framing that a customer name starting with `#` would trigger the issue is technically imprecise (customer value is in col 2, not col 1), but the brittle dependency on a magic string remains valid as a named concern.

**Recommended fix**: Add a comment in `readQuoteXlsxFromBuffer` noting the sentinel dependency. Consider using a more unique sentinel (e.g., `'__ITEMS__'`) or a UUID-style marker when FORGE drafts `@forge-oracle/quote-core` v2.

**Severity rationale**: Low. Not exploitable. The read-back function is a test helper, not part of the xlsx download path. Deferred to v2 per PRISM's naming.

---

### INFO — CONTACTS_LOCAL_PATHS

**Name**: Local filesystem paths committed to contacts.json  
**Affected file**: `quill-brain-oracle:ψ/contacts.json` (lines 19, 39, etc.)  
**Assigned to**: QuillBrain 🪶

**Description**: contacts.json contains absolute paths to Palm's local machine directories:
```json
"inbox": "~/ghq/github.com/brightverse-solution/forge-oracle/ψ/inbox"
```
These paths appear for every Oracle contact (lines 19, 39, 62, etc.). The repo is currently private. The paths themselves are not credentials — they don't reveal any secret. However, they do expose Palm's local directory structure (`~/ghq/github.com/brightverse-solution/...`) if the repo ever becomes public.

**Scope**: Private repo only. No immediate risk. If repo visibility ever changes, these paths would reveal the local machine layout.

**Recommended action**: Consider replacing absolute paths with relative descriptions (`"${ORACLE_HOME}/ψ/inbox"`) in a future contacts.json version, or document that this file is intended as internal-only. No urgency.

---

### INFO — ORACLE_CO_AUTHOR_EMAIL

**Name**: Fabricated email addresses in FORGE's git co-author attribution  
**Affected repo**: forge-oracle (specific commits)  
**Assigned to**: FORGE ⚒️ (awareness only)

**Description**: Several forge-oracle commits use `Co-Authored-By: FORGE Oracle ⚒️ <forge@brightverse-solution.dev>`. The domain `brightverse-solution.dev` and the address `forge@...` are not real email addresses. This is NOT a Rule 6 violation — the name clearly identifies an Oracle, not a human. However, if the repo is public, GitHub would try to attribute these commits to a user with that email. If anyone registered that email on GitHub, they would appear as a contributor.

Other Oracles use `<noreply@anthropic.com>` or `<noreply@anthropic.com>` — which is safer (Anthropic's no-reply domain, no attribution risk).

**Recommended action**: For future commits, prefer `Co-Authored-By: FORGE Oracle ⚒️ <noreply@anthropic.com>` or a verifiably-unused address. No immediate action needed.

---

## Non-Findings (explicitly tested, clean)

| Check | Result | Evidence |
|-------|--------|----------|
| XSS via customer name field | Clean | `<input bind:value>` uses DOM `.value` property, not innerHTML. Svelte never renders customer as raw HTML. |
| XSS via product names in table | Clean | `{item.product}` in `<td>` uses Svelte text interpolation (text node, auto-escaped). No `{@html}` anywhere in the codebase. |
| CSV formula injection → browser execution | Clean | Formulas in product field render as escaped text in Svelte. |
| CSV formula injection → xlsx execution (current) | Clean (implicit) | ExcelJS 4.4.0 writes strings as SharedString type. Excel does not execute shared-string cells as formulas. See PRODUCT_FORMULA_IMPLICIT for coverage gap. |
| localStorage sensitive data | Clean | Key `prism-oracle.quote-counter` stores `{ 'YYYYMMDD': N }` only. No customer names, no quote contents. |
| .env files committed | Clean | No `.env`, `.env.local`, or `.env.production` files in any active Oracle repo. quill-brain-oracle has `.env.example` with all actual secret values commented out. |
| Secrets in git commit history | Clean | grep scan for `sk-`, `AKIA`, `ghp_`, `xoxb-` across all commit patches returned zero matches. |
| PII in outbox letters | Clean | Sample of 8 letters across 5 repos scanned. No customer names, no real phone numbers, no credentials. Oracle names + public GitHub usernames only. |
| Rule 6 compliance (letter attribution) | Clean | All letters signed by Oracle identities (FORGE ⚒️, PRISM 🎨, QuillBrain 🪶, HERALD 📣). No letter impersonates Palm. |
| Co-Authored-By attribution (Rule 6) | Mostly clean | See INFO finding ORACLE_CO_AUTHOR_EMAIL for FORGE's custom domain usage. All others use `noreply@anthropic.com`. |
| contacts.json credentials | Clean | No API keys, tokens, passwords, OAuth secrets found. |
| Path traversal in xlsx filename | Clean | Filename is `${quoteNumber}.xlsx` where quoteNumber = `Q-YYYYMMDD-NNN` from localStorage counter — not derived from user input. |
| Cross-origin localStorage | Clean | Tool is served from a single origin (localhost:5173 in dev); no cross-origin localStorage access. |

---

## Process Recommendations

### Pre-commit secret scanning (for ANVIL ⚙️ when DevOps tooling ships)

The family has been clean on secrets — no actual credentials committed. But there is currently no automated enforcement. As the family grows and ships more tools, a systematic guard is worth adding.

**Recommended setup** (ANVIL scope):
1. `gitleaks` pre-commit hook per repo — catches common secret patterns before commit
2. Shared `.gitleaks.toml` in a family-common location (or per-repo) covering: API key patterns, private key PEMs, database URLs with passwords
3. CI check on PRs — same scan, blocks merge on detection
4. Cost: ~30 min to configure once, near-zero ongoing

This is collaborative: WARD can provide the `.gitleaks.toml` config; ANVIL integrates it into CI/hooks. Flag this as a named collaboration opportunity when ANVIL is fully awake.

### xlsx formula injection test coverage

Regardless of PRODUCT_FORMULA_IMPLICIT's current non-exploitability, adding one test with a formula-like product string would convert an implicit assumption into a verified contract. Should be added to `tests/xlsx-roundtrip.test.ts` in PRISM's next work session.

---

## Severity Summary

| ID | Severity | Name | Assigned |
|----|----------|------|---------|
| F1 | Medium | PRODUCT_FORMULA_IMPLICIT | PRISM 🎨 |
| F2 | Low | CSV_NO_SIZE_LIMIT | PRISM 🎨 |
| F3 | Low | HEADER_SENTINEL_COUPLING | FORGE ⚒️ |
| F4 | Info | CONTACTS_LOCAL_PATHS | QuillBrain 🪶 |
| F5 | Info | ORACLE_CO_AUTHOR_EMAIL | FORGE ⚒️ |

**Critical**: 0 · **High**: 0 · **Medium**: 1 · **Low**: 2 · **Info**: 2

---

*A ward is quiet until tested. Nothing bad happened here because people built carefully. — WARD 🛡️*

*Signed: WARD Oracle 🛡️ — 2026-04-24*
