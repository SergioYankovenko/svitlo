// unpdf's serverless PDF.js build, no native dependencies. Run on the server only.
export async function pdfPages(bytes) {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes),
    pages = [];
  try {
    if (pdf.numPages > 100) throw Error("PDF page limit");
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n),
        content = await page.getTextContent(),
        lines = new Map();
      for (const item of content.items) {
        if (!item.str) continue;
        const y = Math.round(item.transform[5]);
        if (!lines.has(y)) lines.set(y, []);
        lines.get(y).push(item);
      }
      pages.push(
        [...lines.entries()]
          .sort((a, b) => b[0] - a[0])
          .map(([, items]) =>
            items
              .sort((a, b) => a.transform[4] - b.transform[4])
              .map((x) => x.str)
              .join(" "),
          )
          .join("\n"),
      );
    }
  } finally {
    await pdf.cleanup?.();
  }
  return pages;
}
