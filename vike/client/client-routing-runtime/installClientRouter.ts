export { installClientRouter }
export { disableClientRouting }
export { isDisableAutomaticLinkInterception }
export { renderPageClientSide }

import {
  assert,
  getCurrentUrl,
  isEquivalentError,
  objectAssign,
  serverSideRouteTo,
  throttle,
  sleep,
  getGlobalObject,
  executeHook,
  hasProp
} from './utils.js'
import {
  PageContextFromHooks,
  getPageContextFromHooks_errorPage,
  getPageContextFromHooks_firstRender,
  getPageContextFromHooks_uponNavigation,
  isAlreadyServerSideRouted
} from './getPageContext.js'
import { createPageContext } from './createPageContext.js'
import { addLinkPrefetchHandlers } from './prefetch.js'
import { assertInfo, assertWarning, isReact } from './utils.js'
import { executeOnRenderClientHook } from '../shared/executeOnRenderClientHook.js'
import { assertHook } from '../../shared/hooks/getHook.js'
import { skipLink } from './skipLink.js'
import { isErrorFetchingStaticAssets } from '../shared/loadPageFilesClientSide.js'
import {
  initHistoryState,
  getHistoryState,
  pushHistory,
  ScrollPosition,
  saveScrollPosition,
  monkeyPatchHistoryPushState
} from './history.js'
import {
  assertNoInfiniteAbortLoop,
  getPageContextFromAllRewrites,
  isAbortError,
  logAbortErrorHandled,
  PageContextFromRewrite
} from '../../shared/route/abort.js'
import { route, type PageContextFromRoute } from '../../shared/route/index.js'
import { isClientSideRoutable } from './isClientSideRoutable.js'
const globalObject = getGlobalObject<{
  onPageTransitionStart?: Function
  clientRoutingIsDisabled?: true
  previousState: ReturnType<typeof getState>
  initialRenderIsDone?: true
  renderCounter: number
  renderPromise?: Promise<void>
  isTransitioning?: true
  previousPageContext?: { _pageId: string }
}>('installClientRouter.ts', { previousState: getState(), renderCounter: 0 })

function installClientRouter() {
  setupNativeScrollRestoration()
  initHistoryState()
  autoSaveScrollPosition()
  monkeyPatchHistoryPushState()

  // First initial render
  assert(globalObject.renderCounter === (0 as number))
  renderPageClientSide({ scrollTarget: 'preserve-scroll', isBackwardNavigation: null })
  assert(globalObject.renderCounter === 1)

  // Intercept <a> links
  onLinkClick()
  // Handle back-/forward navigation
  onBrowserHistoryNavigation()
}

type RenderArgs = {
  scrollTarget: ScrollTarget
  isBackwardNavigation: boolean | null
  urlOriginal?: string
  overwriteLastHistoryEntry?: boolean
  pageContextsFromRewrite?: PageContextFromRewrite[]
  redirectCount?: number
  /** Whether the navigation was triggered by the user land calling `history.pushState()` */
  isUserLandPushStateNavigation?: boolean
}
async function renderPageClientSide(renderArgs: RenderArgs): Promise<void> {
  const {
    scrollTarget,
    urlOriginal = getCurrentUrl(),
    overwriteLastHistoryEntry = false,
    isBackwardNavigation,
    pageContextsFromRewrite = [],
    redirectCount = 0,
    isUserLandPushStateNavigation
  } = renderArgs
  const { abortRender, setHydrationCanBeAborted, isFirstRender } = getAbortRender()

  assertNoInfiniteAbortLoop(pageContextsFromRewrite.length, redirectCount)

  if (globalObject.clientRoutingIsDisabled) {
    serverSideRouteTo(urlOriginal)
    return
  }

  const pageContext = await createPageContext(urlOriginal)
  if (abortRender()) return
  objectAssign(pageContext, {
    isBackwardNavigation
  })

  {
    const pageContextFromAllRewrites = getPageContextFromAllRewrites(pageContextsFromRewrite)
    objectAssign(pageContext, pageContextFromAllRewrites)
  }

  let renderState: {
    err?: unknown
    pageContextFromRoute?: PageContextFromRoute
    pageContextFromHooks?: PageContextFromHooks
  } = {}

  if (!isFirstRender) {
    // Route
    try {
      renderState = { pageContextFromRoute: await route(pageContext) }
    } catch (err) {
      renderState = { err }
    }
    if (abortRender()) return

    // Check whether rendering should be skipped
    if (renderState.pageContextFromRoute) {
      const { pageContextFromRoute } = renderState
      objectAssign(pageContext, pageContextFromRoute)
      let isClientRoutable: boolean
      if (!pageContextFromRoute._pageId) {
        isClientRoutable = false
      } else {
        isClientRoutable = await isClientSideRoutable(pageContextFromRoute._pageId, pageContext)
        if (abortRender()) return
      }
      if (!isClientRoutable) {
        serverSideRouteTo(urlOriginal)
        return
      }
      const isSamePage =
        pageContextFromRoute._pageId &&
        globalObject.previousPageContext?._pageId &&
        pageContextFromRoute._pageId === globalObject.previousPageContext._pageId
      if (isUserLandPushStateNavigation && isSamePage) {
        // Skip's Vike's rendering; let the user handle the navigation
        return
      }
    }
  }

  // onPageTransitionStart()
  const callTransitionHooks = !isFirstRender
  if (callTransitionHooks) {
    if (!globalObject.isTransitioning) {
      await globalObject.onPageTransitionStart?.(pageContext)
      globalObject.isTransitioning = true
      if (abortRender()) return
    }
  }

  if (isFirstRender) {
    assert(!renderState.pageContextFromRoute)
    assert(!renderState.err)
    try {
      renderState.pageContextFromHooks = await getPageContextFromHooks_firstRender(pageContext)
    } catch (err) {
      renderState.err = err
    }
    if (abortRender()) return
  } else {
    if (!renderState.err) {
      const { pageContextFromRoute } = renderState
      assert(pageContextFromRoute)
      assert(pageContextFromRoute._pageId)
      assert(hasProp(pageContextFromRoute, '_pageId', 'string')) // Help TS
      objectAssign(pageContext, pageContextFromRoute)
      try {
        renderState.pageContextFromHooks = await getPageContextFromHooks_uponNavigation(pageContext)
      } catch (err) {
        renderState.err = err
      }
      if (abortRender()) return
    }
  }

  if ('err' in renderState) {
    const { err } = renderState
    if (!isAbortError(err)) {
      // We don't swallow 404 errors:
      //  - On the server-side, Vike swallows / doesn't show any 404 error log because it's expected that a user may go to some random non-existent URL. (We don't want to flood the app's error tracking with 404 logs.)
      //  - On the client-side, if the user navigates to a 404 then it means that the UI has a broken link. (It isn't expected that users can go to some random URL using the client-side router, as it would require, for example, the user to manually change the URL of a link by manually manipulating the DOM which highly unlikely.)
      console.error(err)
    } else {
      // We swallow throw redirect()/render() called by client-side hooks onBeforeRender() and guard()
      // We handle the abort error down below.
    }

    if (shouldSwallowAndInterrupt(err, pageContext, isFirstRender)) return

    if (isAbortError(err)) {
      const errAbort = err
      logAbortErrorHandled(err, pageContext._isProduction, pageContext)
      const pageContextAbort = errAbort._pageContextAbort

      // throw render('/some-url')
      if (pageContextAbort._urlRewrite) {
        await renderPageClientSide({
          ...renderArgs,
          scrollTarget: 'scroll-to-top-or-hash',
          pageContextsFromRewrite: [...pageContextsFromRewrite, pageContextAbort]
        })
        return
      }

      // throw redirect('/some-url')
      if (pageContextAbort._urlRedirect) {
        const urlRedirect = pageContextAbort._urlRedirect.url
        if (urlRedirect.startsWith('http')) {
          // External redirection
          window.location.href = urlRedirect
          return
        } else {
          await renderPageClientSide({
            ...renderArgs,
            scrollTarget: 'scroll-to-top-or-hash',
            urlOriginal: urlRedirect,
            overwriteLastHistoryEntry: false,
            isBackwardNavigation: false,
            redirectCount: redirectCount + 1
          })
        }
        return
      }

      // throw render(statusCode)
      assert(pageContextAbort.abortStatusCode)
      objectAssign(pageContext, pageContextAbort)
      if (pageContextAbort.abortStatusCode === 404) {
        objectAssign(pageContext, { is404: true })
      }
    } else {
      objectAssign(pageContext, { is404: false })
    }

    try {
      renderState.pageContextFromHooks = await getPageContextFromHooks_errorPage(pageContext)
    } catch (err2: unknown) {
      // - When user hasn't defined a `_error.page.js` file
      // - Some unpexected vike internal error

      if (shouldSwallowAndInterrupt(err2, pageContext, isFirstRender)) return

      if (!isFirstRender) {
        setTimeout(() => {
          // We let the server show the 404 page
          window.location.pathname = urlOriginal
        }, 0)
      }

      if (!isEquivalentError(err, err2)) {
        throw err2
      } else {
        // Abort
        return
      }
    }
    if (abortRender()) return
  }
  const { pageContextFromHooks } = renderState
  assert(pageContextFromHooks)
  objectAssign(pageContext, pageContextFromHooks)

  // Set global onPageTransitionStart()
  assertHook(pageContext, 'onPageTransitionStart')
  globalObject.onPageTransitionStart = pageContext.exports.onPageTransitionStart

  // Set global hydrationCanBeAborted
  if (pageContext.exports.hydrationCanBeAborted) {
    setHydrationCanBeAborted()
  } else {
    assertWarning(
      !isReact(),
      'You seem to be using React; we recommend setting hydrationCanBeAborted to true, see https://vike.dev/clientRouting',
      { onlyOnce: true }
    )
  }
  // There wasn't any `await` but result may change because we just called setHydrationCanBeAborted()
  if (abortRender()) return

  // We use globalObject.renderPromise in order to ensure that there is never two concurrent onRenderClient() calls
  if (globalObject.renderPromise) {
    // Make sure that the previous render has finished
    await globalObject.renderPromise
    assert(globalObject.renderPromise === undefined)
    if (abortRender()) return
  }
  changeUrl(urlOriginal, overwriteLastHistoryEntry)
  globalObject.previousPageContext = pageContext
  assert(globalObject.renderPromise === undefined)
  globalObject.renderPromise = (async () => {
    await executeOnRenderClientHook(pageContext, true)
    addLinkPrefetchHandlers(pageContext)
    globalObject.renderPromise = undefined
  })()
  await globalObject.renderPromise
  assert(globalObject.renderPromise === undefined)
  /* We don't abort in order to ensure that onHydrationEnd() is called: we abort only after onHydrationEnd() is called.
  if (abortRender(true)) return
  */

  // onHydrationEnd()
  if (isFirstRender) {
    assertHook(pageContext, 'onHydrationEnd')
    const { onHydrationEnd } = pageContext.exports
    if (onHydrationEnd) {
      const hookFilePath = pageContext.exportsAll.onHydrationEnd![0]!.exportSource
      assert(hookFilePath)
      await executeHook(() => onHydrationEnd(pageContext), 'onHydrationEnd', hookFilePath)
      if (abortRender(true)) return
    }
  }

  // We abort only after onHydrationEnd() is called
  if (abortRender(true)) return

  // onPageTransitionEnd()
  if (callTransitionHooks) {
    if (pageContext.exports.onPageTransitionEnd) {
      assertHook(pageContext, 'onPageTransitionEnd')
      await pageContext.exports.onPageTransitionEnd(pageContext)
      if (abortRender(true)) return
    }
    globalObject.isTransitioning = undefined
  }

  // Page scrolling
  setScrollPosition(scrollTarget)
  browserNativeScrollRestoration_disable()
  globalObject.initialRenderIsDone = true
}

function onLinkClick() {
  document.addEventListener('click', onClick)

  return

  // Code adapted from https://github.com/HenrikJoreteg/internal-nav-helper/blob/5199ec5448d0b0db7ec63cf76d88fa6cad878b7d/src/index.js#L11-L29

  function onClick(ev: MouseEvent) {
    if (!isNormalLeftClick(ev)) return

    const linkTag = findLinkTag(ev.target as HTMLElement)
    if (!linkTag) return

    const url = linkTag.getAttribute('href')

    if (skipLink(linkTag)) return
    assert(url)
    ev.preventDefault()

    const keepScrollPosition = ![null, 'false'].includes(linkTag.getAttribute('keep-scroll-position'))

    const scrollTarget = keepScrollPosition ? 'preserve-scroll' : 'scroll-to-top-or-hash'
    renderPageClientSide({
      scrollTarget,
      urlOriginal: url,
      isBackwardNavigation: false
    })
  }

  function isNormalLeftClick(ev: MouseEvent): boolean {
    return ev.button === 0 && !ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey
  }

  function findLinkTag(target: HTMLElement): null | HTMLElement {
    while (target.tagName !== 'A') {
      const { parentNode } = target
      if (!parentNode) {
        return null
      }
      target = parentNode as HTMLElement
    }
    return target
  }
}

function onBrowserHistoryNavigation() {
  // - The popstate event is trigged upon:
  //   - Back-/forward navigation.
  //     - By user clicking on his browser's back-/forward navigation (or using a shortcut)
  //     - By JavaScript: `history.back()` / `history.forward()`
  //   - URL hash change.
  //     - By user clicking on a hash link `<a href="#some-hash" />`
  //       - The popstate event is *only* triggered if `href` starts with '#' (even if `href` is '/#some-hash' while the current URL's pathname is '/' then the popstate still isn't triggered)
  //     - By JavaScript: `location.hash = 'some-hash'`
  // - The `event` of `window.addEventListener('popstate', (event) => /*...*/)` is useless: the History API doesn't provide the previous state (the popped state), see https://stackoverflow.com/questions/48055323/is-history-state-always-the-same-as-popstate-event-state
  window.addEventListener('popstate', (): void => {
    const currentState = getState()

    const scrollTarget = currentState.historyState.scrollPosition || 'scroll-to-top-or-hash'

    const isUserLandPushStateNavigation = currentState.historyState.triggedBy === 'user'

    const isHashNavigation = currentState.urlWithoutHash === globalObject.previousState.urlWithoutHash

    const isBackwardNavigation =
      !currentState.historyState.timestamp || !globalObject.previousState.historyState.timestamp
        ? null
        : currentState.historyState.timestamp < globalObject.previousState.historyState.timestamp

    globalObject.previousState = currentState

    if (isHashNavigation && !isUserLandPushStateNavigation) {
      // - `history.state` is uninitialized (`null`) when:
      //   - The user's code runs `window.location.hash = '#section'`.
      //   - The user clicks on an anchor link `<a href="#section">Section</a>` (because Vike's `onLinkClick()` handler skips hash links).
      // - `history.state` is `null` when uninitialized: https://developer.mozilla.org/en-US/docs/Web/API/History/state
      // - Alternatively, we completely take over hash navigation and reproduce the browser's native behavior upon hash navigation.
      //   - Problem: we cannot intercept `window.location.hash = '#section'`. (Or maybe we can with the `hashchange` event?)
      //   - Other potential problem: would there be a conflict when the user wants to override the browser's default behavior? E.g. for smooth scrolling, or when using hashes for saving states of some fancy animations.
      // - Another alternative: we use the browser's scroll restoration mechanism (see `browserNativeScrollRestoration_enable()` below).
      //   - Problem: not clear when to call `browserNativeScrollRestoration_disable()`/`browserNativeScrollRestoration_enable()`
      //   - Other potential problem are inconsistencies between browsers: specification says that setting `window.history.scrollRestoration` only affects the current entry in the session history. But this seems to contradict what folks saying.
      //     - Specification: https://html.spec.whatwg.org/multipage/history.html#the-history-interface
      //     - https://stackoverflow.com/questions/70188241/history-scrollrestoration-manual-doesnt-prevent-safari-from-restoring-scrol
      if (window.history.state === null) {
        // The browser already scrolled to `#${hash}` => the current scroll position is the right one => we save it with `initHistoryState()`.
        initHistoryState()
        globalObject.previousState = getState()
      } else {
        // If `history.state !== null` then it means that `popstate` was triggered by the user clicking on his browser's forward/backward history button.
        setScrollPosition(scrollTarget)
      }
    } else {
      renderPageClientSide({ scrollTarget, isBackwardNavigation, isUserLandPushStateNavigation })
    }
  })
}

function changeUrl(url: string, overwriteLastHistoryEntry: boolean) {
  if (getCurrentUrl() === url) return
  browserNativeScrollRestoration_disable()
  pushHistory(url, overwriteLastHistoryEntry)
  globalObject.previousState = getState()
}

function getState() {
  return {
    urlWithoutHash: getCurrentUrl({ withoutHash: true }),
    historyState: getHistoryState()
  }
}

type ScrollTarget = ScrollPosition | 'scroll-to-top-or-hash' | 'preserve-scroll'
function setScrollPosition(scrollTarget: ScrollTarget): void {
  if (scrollTarget === 'preserve-scroll') {
    return
  }
  let scrollPosition: ScrollPosition
  if (scrollTarget === 'scroll-to-top-or-hash') {
    const hash = getUrlHash()
    // We replicate the browser's native behavior
    if (hash && hash !== 'top') {
      const hashTarget = document.getElementById(hash) || document.getElementsByName(hash)[0]
      if (hashTarget) {
        hashTarget.scrollIntoView()
        return
      }
    }
    scrollPosition = { x: 0, y: 0 }
  } else {
    assert('x' in scrollTarget && 'y' in scrollTarget)
    scrollPosition = scrollTarget
  }
  setScroll(scrollPosition)
}

/** Change the browser's scoll position, in a way that works during a repaint. */
function setScroll(scrollPosition: ScrollPosition) {
  const scroll = () => window.scrollTo(scrollPosition.x, scrollPosition.y)
  const done = () => window.scrollX === scrollPosition.x && window.scrollY === scrollPosition.y

  // In principle, this `done()` call should force the repaint to be finished. But that doesn't seem to be the case with `Firefox 97.0.1`.
  if (done()) return

  scroll()

  // Because `done()` doesn't seem to always force the repaint to be finished, we potentially need to retry again.
  if (done()) return
  requestAnimationFrame(() => {
    scroll()
    if (done()) return

    setTimeout(async () => {
      scroll()
      if (done()) return

      // In principle, `requestAnimationFrame() -> setTimeout(, 0)` should be enough.
      //  - https://stackoverflow.com/questions/61281139/waiting-for-repaint-in-javascript
      //  - But it's not enough for `Firefox 97.0.1`.
      //  - The following strategy is very agressive. It doesn't need to be that aggressive for Firefox. But we do it to be safe.
      const start = new Date().getTime()
      while (true) {
        await sleep(10)
        scroll()
        if (done()) return
        const millisecondsElapsed = new Date().getTime() - start
        if (millisecondsElapsed > 100) return
      }
    }, 0)
  })
}

// Save scroll position (needed for back-/forward navigation)
function autoSaveScrollPosition() {
  // Safari cannot handle more than 100 `history.replaceState()` calls within 30 seconds (https://github.com/vikejs/vike/issues/46)
  window.addEventListener('scroll', throttle(saveScrollPosition, Math.ceil(1000 / 3)), { passive: true })
  onPageHide(saveScrollPosition)
}

function getUrlHash(): string | null {
  let { hash } = window.location
  if (hash === '') return null
  assert(hash.startsWith('#'))
  hash = hash.slice(1)
  return hash
}

// We use the browser's native scroll restoration mechanism only for the first render
function setupNativeScrollRestoration() {
  browserNativeScrollRestoration_enable()
  onPageHide(browserNativeScrollRestoration_enable)
  onPageShow(() => globalObject.initialRenderIsDone && browserNativeScrollRestoration_disable())
}
function browserNativeScrollRestoration_disable() {
  if ('scrollRestoration' in window.history) {
    window.history.scrollRestoration = 'manual'
  }
}
function browserNativeScrollRestoration_enable() {
  if ('scrollRestoration' in window.history) {
    window.history.scrollRestoration = 'auto'
  }
}

function onPageHide(listener: () => void) {
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      listener()
    }
  })
}
function onPageShow(listener: () => void) {
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      listener()
    }
  })
}

function shouldSwallowAndInterrupt(
  err: unknown,
  pageContext: { urlOriginal: string },
  isFirstRender: boolean
): boolean {
  if (isAlreadyServerSideRouted(err)) return true
  if (handleErrorFetchingStaticAssets(err, pageContext, isFirstRender)) return true
  return false
}

function handleErrorFetchingStaticAssets(
  err: unknown,
  pageContext: { urlOriginal: string },
  isFirstRender: boolean
): boolean {
  if (!isErrorFetchingStaticAssets(err)) {
    return false
  }

  if (isFirstRender) {
    disableClientRouting(err, false)
    // This may happen if the frontend was newly deployed during hydration.
    // Ideally: re-try a couple of times by reloading the page (not entirely trivial to implement since `localStorage` is needed.)
    throw err
  } else {
    disableClientRouting(err, true)
  }

  serverSideRouteTo(pageContext.urlOriginal)

  return true
}

function isDisableAutomaticLinkInterception(): boolean {
  // @ts-ignore
  return !!window._disableAutomaticLinkInterception
  /* globalObject should be used if we want to make disableAutomaticLinkInterception a page-by-page setting
  return globalObject.disableAutomaticLinkInterception ?? false
  */
}

function disableClientRouting(err: unknown, log: boolean) {
  assert(isErrorFetchingStaticAssets(err))

  globalObject.clientRoutingIsDisabled = true

  if (log) {
    // We don't use console.error() to avoid flooding error trackers such as Sentry
    console.log(err)
  }
  // @ts-ignore Since dist/cjs/client/ is never used, we can ignore this error.
  const isProd: boolean = import.meta.env.PROD
  assertInfo(
    false,
    [
      'Failed to fetch static asset.',
      isProd ? 'This usually happens when a new frontend is deployed.' : null,
      'Falling back to Server Routing.',
      '(The next page navigation will use Server Routing instead of Client Routing.)'
    ]
      .filter(Boolean)
      .join(' '),
    { onlyOnce: true }
  )
}

function getAbortRender() {
  const renderNumber = ++globalObject.renderCounter
  assert(renderNumber >= 1)

  let hydrationCanBeAborted = false
  const setHydrationCanBeAborted = () => {
    hydrationCanBeAborted = true
  }

  /** Whether the rendering should be aborted because a new rendering has started. We should call this after each `await`. */
  const abortRender = (isRenderCleanup?: true) => {
    // Never abort hydration if `hydrationCanBeAborted` isn't `true`
    if (!isRenderCleanup) {
      const isHydration = renderNumber === 1
      if (isHydration && !hydrationCanBeAborted) {
        return false
      }
    }

    // If there is a newer rendering, we should abort all previous renderings
    return renderNumber !== globalObject.renderCounter
  }

  return {
    abortRender,
    setHydrationCanBeAborted,
    isFirstRender: renderNumber === 1
  }
}
