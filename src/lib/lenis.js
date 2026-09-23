/** Singleton access to the Lenis instance (transition / scroll managers). */
let instance = null;

export function setLenis(lenis) {
  instance = lenis;
}

export function getLenis() {
  return instance;
}

export function stopScroll() {
  instance?.stop();
}

export function startScroll() {
  instance?.start();
}

/**
 * Scroll to the top of the document.
 * `force: true` is required: Lenis silently ignores scrollTo() while
 * stopped (see `if ((isStopped || isLocked) && !force) return`), and the
 * route transitions stop scroll *before* navigating — without force the
 * reset no-ops and the new, shorter page clamps the old scroll offset,
 * landing the user at the bottom of the destination.
 */
export function scrollToTop(immediate = true) {
  if (instance) {
    instance.scrollTo(0, { immediate, force: true });
  } else {
    window.scrollTo({ top: 0, behavior: immediate ? "auto" : "smooth" });
  }
}
