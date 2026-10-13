// The admin pages load no code, styles, fonts or images from a third-party
// host: the theme font and the emoji images are served from this client's
// own build.
import fs from 'fs'
import path from 'path'
import { render } from '@testing-library/react'
import emoji, { TWEMOJI_BASE_URL } from './util/emoji'

const root = path.join(__dirname, '..')
const publicDir = path.join(root, 'public')

// Deliberate third parties, kept until the project rules on them.
const DELIBERATE_HOSTS = ['scripts.simpleanalyticscdn.com', 'queue.simpleanalyticscdn.com']

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(file)
    return /\.js$/.test(entry.name) && !/\.test\.js$/.test(entry.name) ? [file] : []
  })
}

function emojiSrcs(text) {
  const { container } = render(<span>{emoji(text)}</span>)
  return Array.from(container.querySelectorAll('img'), (img) => img.getAttribute('src'))
}

describe('self-contained admin client', () => {
  it('index.html loads nothing from a third-party host except the deliberate ones', () => {
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
    const urls = Array.from(html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g), (m) => m[1])
    const hosts = urls
      .filter((u) => /^(https?:)?\/\//.test(u))
      .map((u) => new URL(u, 'https://example.invalid').hostname)
    expect(urls).toContain('/favicon.ico')
    expect(hosts.filter((h) => !DELIBERATE_HOSTS.includes(h))).toEqual([])
    expect(html).toContain('htmlWebpackPlugin.options.fontStylesheets')
  })

  it('draws emoji from the client assets', () => {
    expect(emojiSrcs('💾')).toEqual([`${TWEMOJI_BASE_URL}72x72/1f4be.png`])
  })

  it('ships an image for every emoji the app renders', () => {
    const used = new Set()
    for (const file of sourceFiles(path.join(root, 'src'))) {
      const text = fs.readFileSync(file, 'utf8')
      Array.from(text.matchAll(/\bemoji\('([^']+)'\)/g), (m) => used.add(m[1]))
      Array.from(text.matchAll(/<KnowledgeBase[^>]*\be="([^"]+)"/g), (m) => used.add(m[1]))
    }
    expect(used.size).toBeGreaterThan(10)
    const missing = Array.from(used)
      .flatMap((text) => emojiSrcs(text))
      .filter((src) => !fs.existsSync(path.join(publicDir, src)))
    expect(missing).toEqual([])
  })
})
