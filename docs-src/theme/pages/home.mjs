const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]))

const receiptRows = (rows) => rows.map(([k,v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')

const changelogRows = (entries) => entries.map(e => `
  <div class="row" style="grid-template-columns:110px 70px 1fr">
    <span class="code">${esc(e.date)}</span>
    <span style="color:var(--panel-accent);font-family:var(--ff-mono);font-size:12px">${esc(e.ver)}</span>
    <span class="title">${esc(e.msg)}</span>
  </div>`).join('')

const mcpGroups = (groups) => groups.map(g => `
  <div class="row" style="grid-template-columns:140px 1fr">
    <span style="color:var(--panel-accent);font-family:var(--ff-mono);font-size:12px">${esc(g.label)}</span>
    <span><code>${g.tools.map(esc).join('</code> <code>')}</code>${g.note ? ` — <span style="color:var(--panel-muted)">${esc(g.note)}</span>` : ''}</span>
  </div>`).join('')

const archTable = (rows) => {
  const [head, ...body] = rows
  return `<table class="kv" style="width:100%">
    <thead><tr>${head.map(c => `<th style="text-align:left;font-family:var(--ff-mono);font-size:11px;color:var(--panel-muted);padding:6px 8px">${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${body.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>`
}

const modeBlock = (m) => `
  <div class="panel" style="margin-bottom:12px">
    <div class="panel-body">
      <div style="display:flex;gap:12px;align-items:baseline;margin-bottom:6px">
        <span style="color:var(--panel-accent);font-family:var(--ff-mono);font-size:12px">${esc(m.name)}</span>
        <span style="color:var(--panel-muted);font-size:12px">${esc(m.blurb)}</span>
      </div>
      <div class="cli"><span class="prompt">$</span><span class="cmd">${esc(m.cmd)}</span></div>
    </div>
  </div>`

const featureList = (features) => features.map(f => `<li>${esc(f)}</li>`).join('')

export function renderHome({ home, changelog, mcp, arch, basePath, site }) {
  const bp = basePath || ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#EFE9DD" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0B0B09" media="(prefers-color-scheme: dark)">
<meta name="color-scheme" content="light dark">
<title>${esc(home.title)} — ${esc(site.title || 'bungraph')}</title>
<meta name="description" content="${esc(home.tagline)}">
<link rel="stylesheet" href="${bp}/vendor/rippleui.css">
<link rel="stylesheet" href="${bp}/vendor/fonts.css">
<link rel="stylesheet" href="${bp}/vendor/colors_and_type.css">
<link rel="stylesheet" href="${bp}/vendor/app-shell.css">
<script type="importmap">
{ "imports": {
  "webjsx": "${bp}/vendor/webjsx/index.js",
  "webjsx/": "${bp}/vendor/webjsx/",
  "webjsx/jsx-runtime": "${bp}/vendor/webjsx/jsx-runtime.js",
  "webjsx-router": "${bp}/vendor/webjsx-router.js"
} }
</script>
</head>
<body>
<div class="app">
  <header class="app-topbar">
    <span class="brand">247420<span class="slash"> / </span>bungraph</span>
    <nav>
      <a href="#overview" class="active">overview</a>
      <a href="#mcp">mcp tools</a>
      <a href="#architecture">architecture</a>
      <a href="#changelog">changelog</a>
      <a href="https://github.com/AnEntrypoint/bungraph" target="_blank" rel="noopener">source ↗</a>
    </nav>
  </header>

  <div class="app-crumb">
    <span>247420</span><span class="sep">›</span>
    <span>bungraph</span><span class="sep">›</span>
    <span class="leaf">overview</span>
    <span style="margin-left:auto;display:flex;gap:10px;align-items:center">
      <span class="chip accent">● live</span>
      <span class="chip dim">v${esc(home.receipt.find(r => r[0]==='version')?.[1] || '')}</span>
    </span>
  </div>

  <div class="app-body">
    <aside class="app-side">
      <div class="group">project</div>
      <a href="#overview" class="active"><span class="glyph">◆</span><span>overview</span></a>
      <a href="#install"><span class="glyph">§</span><span>install</span></a>
      <a href="#features"><span class="glyph">§</span><span>features</span></a>
      <div class="group">reference</div>
      <a href="#mcp"><span class="glyph">›</span><span>mcp tools</span></a>
      <a href="#architecture"><span class="glyph">›</span><span>architecture</span></a>
      <a href="#changelog"><span class="glyph">›</span><span>changelog</span></a>
      <div class="group">links</div>
      <a href="https://github.com/AnEntrypoint/bungraph" target="_blank" rel="noopener"><span class="glyph">↗</span><span>source</span></a>
      <a href="https://www.npmjs.com/package/bungraph" target="_blank" rel="noopener"><span class="glyph">↗</span><span>npm</span></a>
      <a href="https://github.com/AnEntrypoint/bungraph/releases" target="_blank" rel="noopener"><span class="glyph">↗</span><span>releases</span></a>
    </aside>

    <main class="app-main narrow">
      <h1 id="overview">${esc(home.title)}</h1>
      <p class="lede">${esc(home.tagline)}</p>

      <h3 id="install">install</h3>
      <div class="cli" data-install>
        <span class="prompt">$</span>
        <span class="cmd" id="install-cmd">${esc(home.install)}</span>
        <span class="copy" data-copy="${esc(home.install)}">copy</span>
      </div>

      <h3>modes</h3>
      ${home.modes.map(modeBlock).join('')}

      <h3 id="features">features</h3>
      <ul style="margin:0 0 24px 20px;line-height:1.7">${featureList(home.features)}</ul>

      <h3>receipt</h3>
      <table class="kv"><tbody>${receiptRows(home.receipt)}</tbody></table>

      <h3 id="mcp">mcp tools (${mcp.groups.reduce((n,g)=>n+g.tools.length,0)})</h3>
      <div class="panel"><div class="panel-body">${mcpGroups(mcp.groups)}</div></div>

      <h3 id="architecture">architecture — vs upstream graphiti</h3>
      ${archTable(arch.rows)}

      <h3 id="changelog">changelog</h3>
      <div class="panel" style="max-width:900px"><div class="panel-body">${changelogRows(changelog.entries)}</div></div>
    </main>
  </div>

  <footer class="app-status">
    <span class="item">main</span>
    <span class="item">• javascript</span>
    <span class="item">• ${esc(home.receipt.find(r => r[0]==='deps')?.[1] || '')}</span>
    <span class="spread"></span>
    <span class="item">v${esc(home.receipt.find(r => r[0]==='version')?.[1] || '')}</span>
    <span class="item">• ${esc(home.receipt.find(r => r[0]==='license')?.[1] || '')}</span>
  </footer>
</div>
<script type="module" src="${bp}/app.js"></script>
</body>
</html>`
}
