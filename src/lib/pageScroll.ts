/** The current page's scroll area (set by its Layout). */
let activeMain: HTMLElement | null = null;

/** A page's Layout registers its scroll area, returns the cleanup. */
export function registerPageScroll(main: HTMLElement | null): () => void {
  activeMain = main;
  return () => {
    if (activeMain === main) activeMain = null;
  };
}

/** Scroll the current page back to the top, smoothly (page name, platform crumb, SideBar). */
export function scrollPageToTop(): void {
  const main = activeMain;
  if (!main || main.scrollTop === 0) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  main.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
}
