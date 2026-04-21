import * as webjsx from 'webjsx'

const debug = (window.__debug = window.__debug || {})

function wireCopy() {
  const state = { copiedKey: null }
  debug.copy = state
  for (const el of document.querySelectorAll('[data-copy]')) {
    el.addEventListener('click', async () => {
      const val = el.getAttribute('data-copy')
      try {
        await navigator.clipboard?.writeText(val)
        state.copiedKey = val
        const prev = el.textContent
        el.textContent = 'copied'
        setTimeout(() => { el.textContent = prev; state.copiedKey = null }, 1200)
      } catch (e) { state.error = e.message }
    })
  }
}

function wireScrollSpy() {
  const state = { active: null }
  debug.scrollspy = state
  const links = Array.from(document.querySelectorAll('.app-side a[href^="#"]'))
  const ids = links.map(a => a.getAttribute('href').slice(1)).filter(Boolean)
  const sections = ids.map(id => document.getElementById(id)).filter(Boolean)
  if (!sections.length) return
  const activate = (id) => {
    state.active = id
    for (const a of links) a.classList.toggle('active', a.getAttribute('href') === '#' + id)
  }
  const io = new IntersectionObserver((entries) => {
    const visible = entries.filter(e => e.isIntersecting).sort((a,b) => a.boundingClientRect.top - b.boundingClientRect.top)
    if (visible[0]) activate(visible[0].target.id)
  }, { rootMargin: '-20% 0px -70% 0px', threshold: 0 })
  for (const s of sections) io.observe(s)
}

function wireWebjsx() {
  debug.webjsx = { loaded: typeof webjsx.applyDiff === 'function', ts: Date.now() }
}

wireWebjsx()
wireCopy()
wireScrollSpy()
