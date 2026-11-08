/**
 * Whether this device needs the board's memory kept down: iOS and iPadOS (Safari gives a tab a fixed memory limit,
 * graphics included, and kills the tab past it -- every browser there is Safari underneath), or a device reporting
 * 4 GB or less (`navigator.deviceMemory`, which Chrome gives in steps). Where it applies, animated terrain keeps
 * every third frame (`thinAnimations`) and one image worker runs (`defaultPoolSize`). Reported: an iPhone 12 mini
 * crashed starting The South Guard 3, its water-heavy map.
 */
export function memoryConstrained(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent ?? ''
  // iPadOS presents itself as a Mac, with a touch screen.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1)
  const memory = (navigator as { deviceMemory?: number }).deviceMemory
  return ios || (typeof memory === 'number' && memory <= 4)
}
