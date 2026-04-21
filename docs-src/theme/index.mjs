import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { renderHome } from './pages/home.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default {
  assets: {
    'assets/webjsx':              '/vendor/webjsx',
    'assets/webjsx-router.js':    '/vendor/webjsx-router.js',
    'assets/rippleui.css':        '/vendor/rippleui.css',
    'assets/fonts.css':           '/vendor/fonts.css',
    'assets/fonts':               '/vendor/fonts',
    'assets/colors_and_type.css': '/vendor/colors_and_type.css',
    'assets/app-shell.css':       '/vendor/app-shell.css',
    'client/app.js':              '/app.js',
  },
  async render(ctx) {
    const home = ctx.read('pages', { where: { slug: { equals: 'home' } } }).docs[0]
    const changelog = ctx.readGlobal('changelog')
    const mcp = ctx.readGlobal('mcp')
    const arch = ctx.readGlobal('architecture')
    const data = { home, changelog, mcp, arch, basePath: ctx.basePath, site: ctx.site }

    return [
      { path: 'index.html', html: renderHome(data) },
    ]
  },
}
