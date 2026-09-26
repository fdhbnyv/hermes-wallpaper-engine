/**
 * Wallpaper Engine Background Plugin for Hermes Desktop
 *
 * Renders the current Wallpaper Engine wallpaper behind the Hermes window:
 *
 *   - real media: video -> looping <video>; web -> <iframe>;
 *     gif / image -> background-image layer
 *   - if the real media is missing or fails to render (or the wallpaper only
 *     has a static preview, e.g. scene wallpapers), the plugin does NOT paint
 *     the preview — it switches to live-through mode and makes the window
 *     fully transparent, so the real WE scene running on the desktop shows
 *     through (same effect as Clear translucency).
 *   - only when no wallpaper is configured at all (WE off / empty config) the
 *     built-in default wallpaper is shown, so the window is never black.
 *
 * Clear-translucency aware: in Clear mode (`html[data-hermes-clear]`) the
 * plugin paints NOTHING so the real WE scene shows through the window.
 */

import { createElement as h, useState, useEffect } from 'react'
import { host } from '@hermes/plugin-sdk'

const ID = 'wallpaper-engine'

// Content-layer opacity cycle: lower = wallpaper shows more.
const OPACITY_STEPS = ['55%', '35%', '70%', '85%']

// Built-in fallback wallpaper: dusk sky + sakura petals, 16:9. Encoded at
// load time so the source stays readable.
const DEFAULT_WALLPAPER =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 900'>
      <defs>
        <linearGradient id='sky' x1='0' y1='0' x2='0' y2='1'>
          <stop offset='0' stop-color='#262b4a'/>
          <stop offset='0.55' stop-color='#774a6e'/>
          <stop offset='1' stop-color='#e59a9f'/>
        </linearGradient>
        <radialGradient id='sun' cx='0.5' cy='0.5' r='0.5'>
          <stop offset='0' stop-color='#ffe9c9' stop-opacity='0.9'/>
          <stop offset='1' stop-color='#ffe9c9' stop-opacity='0'/>
        </radialGradient>
      </defs>
      <rect width='1600' height='900' fill='url(#sky)'/>
      <circle cx='800' cy='580' r='280' fill='url(#sun)'/>
      <g fill='#f6c7d4'>
        <ellipse cx='180' cy='210' rx='34' ry='16' transform='rotate(28 180 210)' opacity='0.85'/>
        <ellipse cx='1320' cy='170' rx='40' ry='18' transform='rotate(-16 1320 170)' opacity='0.7'/>
        <ellipse cx='960' cy='120' rx='26' ry='12' transform='rotate(50 960 120)' opacity='0.6'/>
        <ellipse cx='420' cy='640' rx='30' ry='14' transform='rotate(-30 420 640)' opacity='0.75'/>
        <ellipse cx='1120' cy='700' rx='36' ry='17' transform='rotate(24 1120 700)' opacity='0.8'/>
        <ellipse cx='720' cy='250' rx='22' ry='10' transform='rotate(-42 720 250)' opacity='0.55'/>
        <ellipse cx='1500' cy='480' rx='28' ry='13' transform='rotate(38 1500 480)' opacity='0.65'/>
        <ellipse cx='90' cy='520' rx='24' ry='11' transform='rotate(12 90 520)' opacity='0.7'/>
      </g>
      <path d='M0 900 Q 400 780 800 900 T 1600 900 V900 H0 Z' fill='#3a2f4a' opacity='0.35'/>
    </svg>`
  )

export default {
  id: ID,
  name: 'Wallpaper Engine',
  defaultEnabled: true,

  register(ctx) {
    // 1. Inject a <style> tag: media layer behind everything, content layer
    //    above it with a tunable translucency.
    const style = document.createElement('style')
    style.id = 'we-bg-style'
    style.textContent = `
      body {
        background-color: var(--ui-bg, #000);
      }
      #we-media-host {
        position: fixed;
        inset: 0;
        z-index: 0;
        overflow: hidden;
        pointer-events: none;
        background-color: #000;
        background-size: cover;
        background-position: center;
        background-repeat: no-repeat;
        filter: brightness(1.3) saturate(1.05);
      }
      #we-media-host > video {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        border: 0;
      }
      #we-media-host > iframe {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        border: 0;
      }
      #root {
        position: relative;
        z-index: 1;
        background-color: color-mix(in srgb, var(--ui-bg, #000) var(--we-opacity, 55%), transparent);
      }
      /* Clear translucency: let the real desktop wallpaper show through */
      html[data-hermes-clear] body,
      html[data-we-live] body {
        background-color: transparent;
      }
      html[data-hermes-clear] #we-media-host,
      html[data-we-live] #we-media-host {
        display: none;
      }
      html[data-hermes-clear] #root,
      html[data-we-live] #root {
        background-color: transparent;
      }
    `
    document.head.appendChild(style)

    const mediaHost = document.createElement('div')
    mediaHost.id = 'we-media-host'
    ;(document.body || document.documentElement).appendChild(mediaHost)

    // ---- helpers ---------------------------------------------------------

    // ---- Hermes window translucency (auto Clear for scene wallpapers) ----
    // Hermes persists its translucency book in localStorage and re-reads it on
    // a `storage` event, so writing the book + dispatching the event makes the
    // app switch the native window opacity live. Scene wallpapers (no real
    // media) thus show the desktop's WE-rendered scene through the window —
    // the only way to "render" scene.pkg outside WE. The original book is
    // remembered and restored once real media plays again.
    const TRANSLUCENCY_KEY = 'hermes.desktop.translucency.v2'
    const AUTO_CLEAR_KEY = 'we.auto-clear'
    let originalBook = null
    let originalCaptured = false
    let autoClearOn = (() => {
      try {
        return localStorage.getItem(AUTO_CLEAR_KEY) !== 'off'
      } catch {
        return true
      }
    })()

    // Capture the user's book once at startup. If it is EXACTLY our auto-clear
    // value, it is leftover from a previous session of this plugin: remember
    // "no original", so restoring returns the window to the default.
    try {
      const startupBook = readBook()
      originalCaptured = true
      if (isOurClearBook(startupBook)) {
        originalBook = null
      } else {
        originalBook = localStorage.getItem(TRANSLUCENCY_KEY)
      }
    } catch {
      originalBook = null
    }

    function readBook() {
      try {
        return JSON.parse(localStorage.getItem(TRANSLUCENCY_KEY) || 'null')
      } catch {
        return null
      }
    }

    function isOurClearBook(b) {
      return !!b && b.mode === 'clear' && b.base && b.base.intensity === 100 && b.base.fade === 0
    }

    function dispatchBookChange(json) {
      try {
        window.dispatchEvent(new StorageEvent('storage', { key: TRANSLUCENCY_KEY, newValue: json }))
      } catch {
        /* StorageEvent may be unavailable in odd shells — the book is already
           written, so a reload still applies it. */
      }
    }

    function enableClear() {
      if (!autoClearOn) return
      const cur = readBook()
      if (isOurClearBook(cur)) return
      const book = { mode: 'clear', base: { intensity: 100, fade: 0 }, light: {}, dark: {} }
      const json = JSON.stringify(book)
      try {
        localStorage.setItem(TRANSLUCENCY_KEY, json)
      } catch {
        return
      }
      dispatchBookChange(json)
    }

    function restoreTranslucency() {
      if (!originalCaptured) return
      const cur = readBook()
      // Only restore when the current value is exactly the one we set — if the
      // user tuned translucency meanwhile, leave their choice alone.
      if (isOurClearBook(cur)) {
        const prev = originalBook
        originalCaptured = false
        originalBook = null
        try {
          if (prev === null) localStorage.removeItem(TRANSLUCENCY_KEY)
          else localStorage.setItem(TRANSLUCENCY_KEY, prev)
        } catch {
          return
        }
        dispatchBookChange(prev)
      } else {
        originalCaptured = false
        originalBook = null
      }
    }

    function resetLayer() {
      mediaHost.replaceChildren()
      mediaHost.style.backgroundImage = 'none'
    }

    function showImage(url) {
      mediaHost.style.backgroundImage = 'url("' + url + '")'
    }

    function probeImage(url) {
      return new Promise(resolve => {
        const probe = new Image()
        probe.onload = () => resolve(true)
        probe.onerror = () => resolve(false)
        probe.src = url
      })
    }

    function probeVideo(url) {
      return new Promise(resolve => {
        const el = document.createElement('video')
        el.muted = true
        el.preload = 'auto'
        const done = ok => {
          el.removeEventListener('error', onErr)
          clearTimeout(timer)
          resolve(ok)
        }
        const onErr = () => done(false)
        el.addEventListener('canplay', () => done(true), { once: true })
        el.addEventListener('error', onErr, { once: true })
        const timer = setTimeout(() => done(el.readyState >= 2), 8000)
        el.src = url
        el.load()
      })
    }

    function probeWeb(url) {
      return new Promise(resolve => {
        const el = document.createElement('iframe')
        const done = ok => {
          el.removeEventListener('error', onErr)
          clearTimeout(timer)
          resolve(ok)
        }
        const onErr = () => done(false)
        el.addEventListener('load', () => done(true), { once: true })
        el.addEventListener('error', onErr, { once: true })
        const timer = setTimeout(() => done(false), 8000)
        el.src = url
      })
    }

    // Live-through mode: paint nothing so the desktop's real WE scene shows
    // through a CLEAR (truly transparent) window. In glass mode the window is
    // opaque and this state must NOT be used — applyMode decides instead.
    let liveThrough = false
    function setLiveThrough(on) {
      if (liveThrough === on) return
      liveThrough = on
      if (on) {
        resetLayer()
        document.documentElement.setAttribute('data-we-live', '')
        host.notify({
          kind: 'info',
          message: 'WE 场景无法在窗口内渲染，已切换到透出模式（Clear 透明窗口下，桌面实时场景直接可见）'
        })
      } else {
        document.documentElement.removeAttribute('data-we-live')
      }
    }

    // Try candidates in order; mount the first that works. Returns true when
    // a real wallpaper was mounted, false when nothing could be mounted
    // (the caller decides what to show then).
    async function renderCandidates(candidates) {
      for (const c of candidates) {
        if (c.kind === 'video') {
          const ok = await probeVideo(c.url)
          if (!ok) continue
          resetLayer()
          const el = document.createElement('video')
          el.src = c.url
          el.autoplay = true
          el.muted = true
          el.loop = true
          el.playsInline = true
          el.setAttribute('playsinline', '')
          mediaHost.appendChild(el)
          el.play().catch(() => {})
          return true
        }
        if (c.kind === 'web') {
          const ok = await probeWeb(c.url)
          if (!ok) continue
          resetLayer()
          const el = document.createElement('iframe')
          el.src = c.url
          el.setAttribute('allow', 'autoplay')
          el.setAttribute('tabindex', '-1')
          mediaHost.appendChild(el)
          return true
        }
        // image / gif
        const ok = await probeImage(c.url)
        if (!ok) continue
        resetLayer()
        showImage(c.url)
        return true
      }
      return false
    }

    // Only real media counts as a wallpaper. Static previews are NOT rendered
    // (the user finds them ugly) — a wallpaper with only a preview goes
    // straight to live-through mode.
    function candidatesFor(wp) {
      const fileUrl = p => 'file://' + p.replace(/\\/g, '/')
      if (wp.media && wp.type) {
        if (wp.type === 'video') return [{ kind: 'video', url: fileUrl(wp.media) }]
        if (wp.type === 'web') return [{ kind: 'web', url: fileUrl(wp.media) }]
        return [{ kind: 'image', url: fileUrl(wp.media) }]
      }
      return []
    }

    // ---- unified paint decision ------------------------------------------
    // What to render depends BOTH on the wallpaper AND on Hermes' current
    // window state: Clear (truly transparent) can show the desktop through;
    // Glass keeps the window opaque, so transparency is useless there and we
    // must paint real content instead of leaving the window blank.
    let lastWp = null
    let lastKey = ''

    function windowIsClear() {
      return document.documentElement.hasAttribute('data-hermes-clear')
    }

    function renderSceneFallback(clear) {
      if (clear) {
        // Truly transparent window: the desktop's WE scene shows through.
        setLiveThrough(true)
        return
      }
      const mode = (readBook() || {}).mode
      if (mode === 'glass') {
        // User picked Glass: the window is opaque, so transparency cannot
        // show the desktop through — paint the built-in wallpaper instead
        // of leaving nothing (and do NOT fight the user's choice).
        setLiveThrough(false)
        resetLayer()
        showImage(DEFAULT_WALLPAPER)
      } else if (autoClearOn) {
        // Opaque + auto-clear enabled: open Clear so the scene shows through.
        setLiveThrough(true)
        enableClear()
      } else {
        // Auto-clear disabled and window not transparent: built-in wallpaper.
        setLiveThrough(false)
        resetLayer()
        showImage(DEFAULT_WALLPAPER)
      }
    }

    async function applyMode() {
      const wp = lastWp
      if (!wp) return
      const hasMedia = !!(wp.media && wp.type)
      const clear = windowIsClear()

      if (hasMedia) {
        const key = (wp.id || '') + '|' + (wp.media || '') + '|' + (wp.preview || '') + '|' + (wp.type || '')
        if (key !== lastKey) {
          lastKey = key
          const mounted = await renderCandidates(candidatesFor(wp))
          if (mounted) {
            setLiveThrough(false)
            // If we auto-opened Clear for a previous scene wallpaper, restore
            // the user's original window so the video plays in-window.
            restoreTranslucency()
          } else {
            // Real media failed — degrade like a scene wallpaper.
            lastKey = ''
            renderSceneFallback(clear)
          }
        } else {
          setLiveThrough(false)
        }
        return
      }

      // Scene wallpaper: no real media to play.
      lastKey = ''
      renderSceneFallback(clear)
    }

    async function refreshBg() {
      try {
        const r = await ctx.rest('/we-status', { method: 'GET' })
        const wp = r && r.wallpaper
        if (wp && (wp.media || wp.preview)) {
          lastWp = wp
          document.documentElement.setAttribute('data-we-title', wp.title || '')
          await applyMode()
        } else {
          // Backend up but no wallpaper configured — show the built-in
          // default so the window is never black.
          lastWp = null
          lastKey = ''
          setLiveThrough(false)
          resetLayer()
          showImage(DEFAULT_WALLPAPER)
          document.documentElement.removeAttribute('data-we-title')
        }
      } catch (e) {
        // Backend not loaded yet — keep whatever is on screen.
      }
    }

    // Never start black: render the default immediately, then swap in real
    // wallpaper when the backend answers.
    resetLayer()
    showImage(DEFAULT_WALLPAPER)
    refreshBg()
    const timer = setInterval(refreshBg, 15000)

    // React when Hermes switches Clear <-> Glass: re-decide what to paint.
    let applyTimer = null
    const clearObserver = new MutationObserver(() => {
      clearTimeout(applyTimer)
      applyTimer = setTimeout(() => applyMode(), 250)
    })
    clearObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-hermes-clear']
    })

    // 2. Status bar chip
    ctx.register({
      id: 'we-chip',
      area: 'statusBar.right',
      order: 150,
      render: () => h(WEChip, { ctx })
    })

    // 3. Palette command to cycle the content opacity
    ctx.register({
      id: 'we-cycle-opacity',
      area: 'palette',
      data: {
        id: 'we.cycle-opacity',
        label: 'WE: Cycle Background Opacity',
        keywords: ['wallpaper', 'background', 'opacity', 'we', '透明'],
        run: () => {
          const root = document.documentElement
          const current = root.style.getPropertyValue('--we-opacity') || '55%'
          const idx = OPACITY_STEPS.indexOf(current)
          const next = OPACITY_STEPS[(idx + 1) % OPACITY_STEPS.length]
          root.style.setProperty('--we-opacity', next)
          host.notify({ kind: 'info', message: 'WE 背景不透明度: ' + next })
        }
      }
    })

    // 4. Palette helper: how to switch to live-through mode
    ctx.register({
      id: 'we-live-mode',
      area: 'palette',
      data: {
        id: 'we.live-mode',
        label: 'WE: Live Wallpaper Mode (Window Translucency → Clear)',
        keywords: ['wallpaper', 'live', 'clear', 'transparent', '真实壁纸', '透明'],
        run: () => {
          host.notify({ kind: 'info', message: '设置 → 外观 → Window Translucency 选择 Clear，真实壁纸即会透过窗口显示' })
        }
      }
    })

    // 5. Palette toggle: auto Clear for scene wallpapers
    ctx.register({
      id: 'we-auto-clear',
      area: 'palette',
      data: {
        id: 'we.auto-clear',
        label: 'WE: 场景壁纸自动透出 (Auto Clear)',
        keywords: ['wallpaper', 'scene', 'auto', 'clear', '透出', '场景'],
        run: () => {
          autoClearOn = !autoClearOn
          try {
            if (autoClearOn) localStorage.removeItem(AUTO_CLEAR_KEY)
            else localStorage.setItem(AUTO_CLEAR_KEY, 'off')
          } catch {
            /* best-effort */
          }
          host.notify({ kind: 'info', message: autoClearOn ? 'WE 场景壁纸：自动透出已开启' : 'WE 场景壁纸：自动透出已关闭' })
        }
      }
    })

    // Cleanup when the plugin unloads/disables
    ctx.onDispose(() => {
      clearInterval(timer)
      clearTimeout(applyTimer)
      clearObserver.disconnect()
      style.remove()
      mediaHost.remove()
      restoreTranslucency()
      document.documentElement.style.removeProperty('--we-opacity')
      document.documentElement.removeAttribute('data-we-title')
      document.documentElement.removeAttribute('data-we-live')
    })
  }
}

function WEChip({ ctx }) {
  const [ok, setOk] = useState(false)
  const [title, setTitle] = useState('')

  useEffect(() => {
    const check = async () => {
      try {
        const r = await ctx.rest('/we-status', { method: 'GET' })
        setOk(r && r.success === true)
        setTitle(r && r.wallpaper ? r.wallpaper.title || '' : '')
      } catch {
        setOk(false)
      }
    }
    check()
    const t = setInterval(check, 30000)
    return () => clearInterval(t)
  }, [])

  // Read the live DOM instead of React state so the label tracks the
  // plugin's real-time mode without extra polling.
  const live = typeof document !== 'undefined' && document.documentElement.hasAttribute('data-we-live')
  const name = title || 'Wallpaper Engine'
  const label = !ok ? '🎨 WE ✗' : live ? '🎨 WE 透出' : '🎨 WE 壁纸'

  return h(
    'span',
    {
      className: 'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] text-(--ui-text-tertiary)',
      title: name
    },
    label
  )
}
