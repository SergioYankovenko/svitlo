// Navigation commits synchronously. Animation never schedules a later date change.
export function slideDay(grid, direction, change) {
  const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const canAnimate = grid?.animate && !reduced;
  const oldHeight = grid?.parentElement.getBoundingClientRect().height;
  const previous = canAnimate ? grid.cloneNode(true) : null;
  // Read the visible position before render() cancels an interrupted transition.
  const indicator = grid?.closest?.(".schedule")?.querySelector(".day-indicator");
  const oldIndicator = canAnimate ? indicator?.getBoundingClientRect() : null;
  const next = change();
  if (!previous || !next?.animate || !next.isConnected) return () => {};

  const viewport = next.parentElement;
  const newHeight = viewport.getBoundingClientRect().height;
  previous.classList.add("hours-exiting");
  previous.setAttribute("aria-hidden", "true");
  previous.inert = true;
  viewport.append(previous);

  const options = { duration: 260, easing: "cubic-bezier(.22,.61,.36,1)" };
  const animations = [
    previous.animate([
      { transform: "translateX(0)" },
      { transform: `translateX(${-direction * 100}%)` },
    ], options),
    next.animate([
      { transform: `translateX(${direction * 100}%)` },
      { transform: "translateX(0)" },
    ], options),
    viewport.animate([
      { height: oldHeight + "px" },
      { height: newHeight + "px" },
    ], options),
  ];
  const nextIndicator = next.closest?.(".schedule")?.querySelector(".day-indicator");
  if (oldIndicator && nextIndicator?.animate) {
    const target = nextIndicator.getBoundingClientRect();
    animations.push(nextIndicator.animate([
      { transform: `translateX(${oldIndicator.left - target.left}px)` },
      { transform: "translateX(0)" },
    ], options));
  }
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    previous.remove();
    for (const animation of animations) animation.cancel();
  };
  Promise.all(animations.map((animation) => animation.finished)).then(cleanup, cleanup);
  return cleanup;
}
