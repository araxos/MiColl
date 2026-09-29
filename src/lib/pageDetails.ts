/**
 * "Details" for the current page, opened from the background context menu.
 * The menu fires an event and whatever page is mounted opens its own panel.
 */

export const PAGE_DETAILS_EVENT = "micoll:page-details";

export function askForPageDetails(): void {
  window.dispatchEvent(new CustomEvent(PAGE_DETAILS_EVENT));
}

/** Use it in a page: usePageDetails(() => setPanelOpen(true)). */
export function onPageDetails(fn: () => void): () => void {
  window.addEventListener(PAGE_DETAILS_EVENT, fn);
  return () => window.removeEventListener(PAGE_DETAILS_EVENT, fn);
}
