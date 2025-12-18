# Translation System Documentation

This document outlines how translations are handled in the `client-participation` codebase, covering static UI text, dynamic content (comments), and conversation metadata.

## Overview

The application uses a hybrid approach for translations:

1. **Static UI Strings**: Client-side localized files for interface elements.
2. **Dynamic Content**: Server-provided translations for user-generated content (comments) and conversation metadata.
3. **Language Detection**: Combination of browser headers, query parameters, and server-side detection.

## 1. Static UI Translations

Static text (buttons, labels, messages) is handled in `js/strings.js`.

* **Source Files**: Translation files are located in `js/strings/` (e.g., `ar.js`, `en_us.js`).
* **Loading Mechanism**:
  * The system defaults to `en_us`.
  * It determines the user's preferred language via `preloadHelper.acceptLanguagePromise` (server-detected) or the `ui_lang` query parameter.
  * It iterates through the prioritized language list and extends the base `strings` object with the matching translation file.
* **Usage**: Imported as `Strings` in views (e.g., `js/views/vote-view.js`) and used like `Strings.agree`.
* **Debugging**: `window.missingTranslations()` is available in the console to identify missing keys compared to `en_us`.

## 2. Dynamic Content (Comments/Statements)

User-generated comments are translated using a more complex logic involving "Official" (Human) and "Unofficial" (Machine) translations. This logic is primarily found in `js/views/vote-view.js` and `js/util/utils.js`.

* **Data Source**: The server returns a `translations` array attached to comment objects (fetched via `api/v3/nextComment` or `api/v3/comments`).
* **Language Matching**: `Utils.getBestTranslation(translations, lang)` filters translations matching the UI language, prioritizing exact matches and "Official" sources.

### Translation Types

1. **Official Translations (`src > 0`)**:
    * Likely human-curated or admin-approved.
    * **Behavior**: If a matching official translation exists, it **automatically replaces** the original text in the view (`ctx.txt`). The user sees the translation as if it were the original.
    * Logic: `getMatchingOfficialTranslation` in `vote-view.js`.

2. **Unofficial/Machine Translations**:
    * **Behavior**: If no official translation replaces the text, but a translation exists for the user's language, a **"Show Translation" button** appears.
    * Clicking the button renders the translation (`ctx.translationTxt`) *below* the original text with a disclaimer (`ctx.thirdPartyTranslationDisclaimer`).
    * **Persistence**: The user's preference to see translations is saved via `put_participants_extended({ show_translation_activated: true })`.

### Button Visibility Logic (`js/views/vote-view.js`)

The visibility of "Show/Hide Translation" buttons follows strict conditionals to ensure a seamless experience.

**The Core Rule**: Buttons are *only* offered if the content language (`ctx.lang`) **does not match** the user's UI language (`Utils.matchesUiLang`).

1. **The "Magic Swap" (Official Translations)**:
    * If an Official Translation exists for the user's language, the app swaps `ctx.txt` with the translated text and updates `ctx.lang` to the user's language.
    * **Result**: The "Core Rule" sees a language match, so **no buttons are shown**. The user sees the translated text immediately.

2. **"Show Translation" Button**:
    * Appears ONLY if:
        1. User has NOT clicked "Show" yet (`!ctx.showTranslation`).
        2. Translations exist (`ctx.translations.length > 0`).
        3. Language mismatch (`!Utils.matchesUiLang(ctx.lang)`).

3. **"Hide Translation" Button**:
    * Appears ONLY if:
        1. User HAS clicked "Show" (`ctx.showTranslation`).
        2. Translation text is loaded.
        3. Language mismatch (`!Utils.matchesUiLang(ctx.lang)`).

4. **Cleanup / Override**:
    * If `Utils.matchesUiLang(ctx.lang)` is true (either naturally or due to the "Magic Swap"), all translation buttons are forcibly removed/hidden.

## 3. Conversation Metadata (Topic/Description)

Conversation metadata (Topic and Description) handling is located in `public/index.ejs`.

* **Logic**: The `fixupConversation` function checks for `c.translations`.
* **Behavior**: It naively uses the **first** translation in the array (`t[0]`) to overwrite `c.topic` and `c.description`.
* **Dependency**: This implies the server must pre-filter or sort the `translations` array based on the requested language (sent via `participationInit` with `lang` param) before returning the conversation object.

## 4. Language Detection

The system determines the target language (`ui_lang`) through the following precedence:

1. **Query Parameter**: `?ui_lang=fr` (checked in `Utils.uiLanguage()`).
2. **Preload Data**: `window.preload.acceptLanguage` (derived from the HTTP `Accept-Language` header by the server).
3. **Browser defaults**: `navigator.language` is used in some specific API calls (e.g., `getFancyComments`).

## 5. Server Interactions

The client explicitly requests content in the user's language for several endpoints:

* `api/v3/participationInit` (via `index.ejs`)
* `api/v3/nextComment` (via `stores/polis.js`)
* `api/v3/votes` (via `stores/polis.js`)
* `api/v3/comments` (via `stores/polis.js`)

These endpoints receive a `lang` parameter, allowing the server to return appropriate localized content or filtered translation lists.
