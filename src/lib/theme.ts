import { useCallback, useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * Runs in <head> before first paint so a stored dark theme never flashes light.
 * Mirrors storedTheme() and applyTheme() below.
 */
export const themeInitScript = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}');var d=t==='dark'||(t!=='light'&&matchMedia('${DARK_QUERY}').matches);var r=document.documentElement;r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light'}catch(e){}})()`

// Used when storage is blocked, so a choice still holds until the page reloads.
let unsavedTheme: Theme = 'system'

function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return unsavedTheme
  }
}

function systemPrefersDark() {
  return window.matchMedia(DARK_QUERY).matches
}

/**
 * Applied imperatively rather than from a render effect: during hydration React
 * renders with the server snapshot ('system', light), and an effect would undo
 * what themeInitScript set before the real values come in.
 */
function applyTheme() {
  const theme = storedTheme()
  const dark = theme === 'dark' || (theme === 'system' && systemPrefersDark())
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
}

const listeners = new Set<() => void>()

function emit() {
  applyTheme()
  for (const listener of listeners) listener()
}

// Another tab picked a theme.
function onStorage(event: StorageEvent) {
  if (event.key === STORAGE_KEY) emit()
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    window.addEventListener('storage', onStorage)
    window.matchMedia(DARK_QUERY).addEventListener('change', emit)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      window.removeEventListener('storage', onStorage)
      window.matchMedia(DARK_QUERY).removeEventListener('change', emit)
    }
  }
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, storedTheme, (): Theme => 'system')
  const systemDark = useSyncExternalStore(subscribe, systemPrefersDark, () => false)
  const resolvedTheme: 'light' | 'dark' = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme

  const setTheme = useCallback((next: Theme) => {
    unsavedTheme = next
    try {
      if (next === 'system') localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Storage blocked: storedTheme() falls back to unsavedTheme.
    }
    emit()
  }, [])

  return { theme, resolvedTheme, setTheme }
}
