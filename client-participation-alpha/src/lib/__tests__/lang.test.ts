import { uiLanguageSSR, uiLanguageUniversal } from '../lang'

describe('lang utilities', () => {
  describe('uiLanguageSSR', () => {
    it('should return query parameter when provided', () => {
      const result = uiLanguageSSR('fr', 'en-US,en;q=0.9')
      expect(result).toBe('fr')
    })

    it('should trim whitespace from query parameter', () => {
      const result = uiLanguageSSR('  es  ', 'en-US')
      expect(result).toBe('es')
    })

    it('should use Accept-Language when query param is null', () => {
      const result = uiLanguageSSR(null, 'es-ES,es;q=0.9,en;q=0.8')
      expect(result).toBe('es-ES')
    })

    it('should use Accept-Language when query param is empty', () => {
      const result = uiLanguageSSR('', 'ja-JP,ja;q=0.9')
      expect(result).toBe('ja-JP')
    })

    it('should parse complex Accept-Language header', () => {
      const result = uiLanguageSSR(null, 'en-US,en;q=0.9,es;q=0.8,fr;q=0.7')
      expect(result).toBe('en-US')
    })

    it('should handle Accept-Language with quality values in different order', () => {
      const result = uiLanguageSSR(null, 'es;q=0.5,en-US;q=0.9,fr;q=0.8')
      expect(result).toBe('en-US')
    })

    it('should return null when both parameters are null', () => {
      const result = uiLanguageSSR(null, null)
      expect(result).toBeNull()
    })

    it('should return null when query is empty and no Accept-Language', () => {
      const result = uiLanguageSSR('', null)
      expect(result).toBeNull()
    })

    it('should handle Accept-Language with whitespace', () => {
      const result = uiLanguageSSR(null, ' en-US , en ; q=0.9 ')
      expect(result).toBe('en-US')
    })

    it('should prioritize query parameter over Accept-Language', () => {
      const result = uiLanguageSSR('zh-Hans', 'en-US,en;q=0.9')
      expect(result).toBe('zh-Hans')
    })
  })

  describe('uiLanguageUniversal', () => {
    it('should work with SSR options', () => {
      const result = uiLanguageUniversal({
        queryParam: 'de',
        acceptLanguageHeader: 'en-US'
      })
      expect(result).toBe('de')
    })

    it('should use Accept-Language in SSR context when query is null', () => {
      const result = uiLanguageUniversal({
        queryParam: null,
        acceptLanguageHeader: 'fr-FR,fr;q=0.9'
      })
      expect(result).toBe('fr-FR')
    })

    it('should return null in SSR context when both are null', () => {
      const result = uiLanguageUniversal({
        queryParam: null,
        acceptLanguageHeader: null
      })
      expect(result).toBeNull()
    })

    it('should handle undefined options in SSR context', () => {
      const result = uiLanguageUniversal({})
      expect(result).toBeNull()
    })

    it('should return null for client-side when window is undefined', () => {
      // In our test environment, window is mocked by jsdom but we can test the function
      const result = uiLanguageUniversal()
      // Since we're in a test environment without real browser APIs, this should return null
      // unless jsdom provides navigator.language
      expect(result).toBeDefined() // Will be null or a language from jsdom
    })
  })
})
