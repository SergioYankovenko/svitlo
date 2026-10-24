// Fall back as whole blocks when actual font metrics no longer fit two columns.
export function fitHeader(header) {
  if (!header) return () => {};
  const context = document.createElement("canvas").getContext("2d");
  const measure = (selector) => {
    const node = header.querySelector(selector);
    if (!node) return 0;
    const style = getComputedStyle(node);
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return context.measureText(node.textContent).width;
  };
  const update = () => {
    const left = Math.max(measure(".brand"), measure(".header-queue"));
    const right = Math.max(measure(".countdown-label"), measure(".countdown-value"));
    const gap = parseFloat(getComputedStyle(header).columnGap) || 0;
    header.classList.toggle("stacked", right > 0 && left + right + gap + 2 > header.clientWidth);
  };
  const observer = new ResizeObserver(update);
  observer.observe(header);
  update();
  return () => observer.disconnect();
}
