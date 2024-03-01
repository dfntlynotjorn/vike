export { improveViteLogs }

import { assert, removeEmptyLines, trimWithAnsi, trimWithAnsiTrailOnly } from '../utils.js'
import { logViteError, logViteAny, clearLogs } from './loggerNotProd.js'
import { getHttpRequestAsyncStore } from './getHttpRequestAsyncStore.js'
import { removeSuperfluousViteLog } from './loggerVite/removeSuperfluousViteLog.js'
import type { LogType, ResolvedConfig, LogErrorOptions } from 'vite'
import { isErrorDebug } from './isErrorDebug.js'
import { onRuntimeError } from '../../runtime/renderPage/loggerProd.js'

function improveViteLogs(config: ResolvedConfig) {
  intercept('info', config)
  intercept('warn', config)
  intercept('error', config)
}

function intercept(logType: LogType, config: ResolvedConfig) {
  config.logger[logType] = (msg, options: LogErrorOptions = {}) => {
    assert(!isErrorDebug())

    if (removeSuperfluousViteLog(msg)) return

    if (!!options.timestamp) {
      msg = trimWithAnsi(msg)
    } else {
      // No timestamp => no "[vite]" tag prepended => we don't trim the beginning of the message
      msg = trimWithAnsiTrailOnly(msg)
    }
    msg = cleanFirstViteLog(msg)

    const store = getHttpRequestAsyncStore()

    // Dedupe Vite error messages
    if (options.error && store?.shouldErrorBeSwallowed(options.error)) {
      return
    }
    // Remove this once https://github.com/vitejs/vite/pull/13495 is released and widely used
    if (msg.startsWith('Transform failed with ') && store && logType === 'error') {
      store.markErrorMessageAsLogged(msg)
      return
    }

    if (options.error) {
      // Vite does a poor job of handling errors.
      //  - It doesn't format error code snippets.
      //  - It only shows error.message which means that crucial information such as error.id isn't shown to the user.
      logViteError(options.error)
      // Needs to be called after logging the error.
      onRuntimeError(options.error)
      // We swallow Vite's message: we didn't see it add any value so far.
      //  - It can even be confusing, such as the following:
      //    ```
      //    Error when evaluating SSR module virtual:vike:pageConfigValuesAll:server:/pages/abort: failed to import "/pages/abort/+Page.mdx"
      //    ```
      if (!isErrorDebug()) return
    }

    // Only allow Vite to clear for its first log. All other clearing is controlled by vike.
    if (options.clear) clearLogs({ clearIfFirstLog: true })
    // Vite's default logger preprends the "[vite]" tag if and only if options.timestamp is true
    const prependViteTag = options.timestamp || !!store?.httpRequestId
    logViteAny(msg, logType, store?.httpRequestId ?? null, prependViteTag)
  }
}

function cleanFirstViteLog(msg: string): string {
  const isFirstVitLog = msg.includes('VITE') && msg.includes('ready')
  if (isFirstVitLog) {
    return removeEmptyLines(msg)
  } else {
    return msg
  }
}
