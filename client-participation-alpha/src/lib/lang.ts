/**
 * @file Language detection utilities for both SSR and client contexts.
 *
 * Provides functions to intelligently detect the user's preferred UI language
 * by checking (in order):
 * 1. `ui_lang` query parameter
 * 2. `Accept-Language` HTTP header (SSR only)
 * 3. Browser's navigator.languages (client only)
 *
 * These functions return raw language codes (e.g., "en-US", "pt-BR", "zh-CN")
 * without normalization. For translation module matching, use the normalization
 * functions in strings.ts.
 */

/**
 * Parses an Accept-Language header string and returns an array of language codes
 * ordered by preference (quality values).
 *
 * Example: "en-US,en;q=0.9,es;q=0.8" -> ["en-US", "en", "es"]
 *
 * @param acceptLanguage - The Accept-Language header value
 * @returns Array of language codes ordered by preference
 */
function parseAcceptLanguage(acceptLanguage: string | null): string[] {
  if (!acceptLanguage) {
    return []
  }

  // Parse Accept-Language header: "en-US,en;q=0.9,es;q=0.8"
  const languages: Array<{ lang: string; q: number }> = []

  acceptLanguage.split(',').forEach((part) => {
    const [lang, qValue] = part.trim().split(';q=')
    const langCode = lang.trim()
    const quality = qValue ? parseFloat(qValue) : 1.0

    if (langCode) {
      languages.push({ lang: langCode, q: quality })
    }
  })

  // Sort by quality (higher first), then by order
  languages.sort((a, b) => b.q - a.q)

  return languages.map((l) => l.lang)
}

/**
 * Client-side version: Detects UI language from query parameter or browser settings.
 *
 * Priority:
 * 1. `ui_lang` query parameter (if present and not blank)
 * 2. Browser's navigator.languages
 *
 * @returns Raw language code (e.g., "en-US", "pt-BR", "zh-CN") or null if none found
 */
export function uiLanguage(): string | null {
  if (typeof window === 'undefined') {
    // This function is for client-side only
    // Use uiLanguageSSR() in SSR contexts
    return null
  }

  // 1. Check query parameter first
  const params = new URLSearchParams(window.location.search)
  const queryLang = params.get('ui_lang')
  if (queryLang && queryLang.trim()) {
    return queryLang.trim()
  }

  // 2. Fall back to browser's navigator.languages (return first available)
  const browserLangs = navigator.languages || [navigator.language]
  return browserLangs[0] || null
}

/**
 * SSR version: Detects UI language from query parameter or Accept-Language header.
 *
 * Priority:
 * 1. `ui_lang` query parameter (if present and not blank)
 * 2. `Accept-Language` HTTP header (first preferred language)
 *
 * @param queryParam - The value of the `ui_lang` query parameter (from Astro.url.searchParams.get('ui_lang'))
 * @param acceptLanguageHeader - The value of the Accept-Language header (from Astro.request.headers.get('accept-language'))
 * @returns Raw language code (e.g., "en-US", "pt-BR", "zh-CN") or null if none found
 *
 * @example
 * ```astro
 * // In an Astro page:
 * const lang = uiLanguageSSR(
 *   Astro.url.searchParams.get('ui_lang'),
 *   Astro.request.headers.get('accept-language')
 * )
 * ```
 */
export function uiLanguageSSR(
  queryParam: string | null,
  acceptLanguageHeader: string | null
): string | null {
  // 1. Check query parameter first
  if (queryParam && queryParam.trim()) {
    return queryParam.trim()
  }

  // 2. Fall back to Accept-Language header (return first preferred language)
  if (acceptLanguageHeader) {
    const parsedLangs = parseAcceptLanguage(acceptLanguageHeader)
    return parsedLangs[0] || null
  }

  return null
}

/**
 * Universal version: Automatically detects context and uses appropriate method.
 *
 * In SSR contexts, you must pass the query parameter and Accept-Language header.
 * In client contexts, it will auto-detect from the browser.
 *
 * @param options - Optional SSR context parameters
 * @param options.queryParam - The value of the `ui_lang` query parameter (SSR only)
 * @param options.acceptLanguageHeader - The value of the Accept-Language header (SSR only)
 * @returns Raw language code (e.g., "en-US", "pt-BR", "zh-CN") or null if none found
 *
 * @example
 * ```typescript
 * // Client-side (auto-detects):
 * const lang = uiLanguage()
 *
 * // SSR (pass context):
 * const lang = uiLanguage({
 *   queryParam: Astro.url.searchParams.get('ui_lang'),
 *   acceptLanguageHeader: Astro.request.headers.get('accept-language')
 * })
 * ```
 */
export function uiLanguageUniversal(options?: {
  queryParam?: string | null
  acceptLanguageHeader?: string | null
}): string | null {
  // If options provided, we're in SSR context
  if (options !== undefined) {
    return uiLanguageSSR(options.queryParam ?? null, options.acceptLanguageHeader ?? null)
  }

  // Otherwise, try client-side detection
  return uiLanguage()
}

// Default export for convenience (uses universal version)
export default uiLanguageUniversal
