import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfTextResult {
  text: string;
  pages: number;
}

/** Extract text from text-based PDFs. Image-only/scanned PDFs require OCR. */
export async function extractPdfText(file: File): Promise<PdfTextResult> {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages: string[] = [];
  try {
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const items = await page.getTextContent();
      const text = items.items
        .filter((item) => "str" in item)
        .map((item) => (item as { str: string }).str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      pages.push(`[Сторінка ${pageNo}]\n${text}`);
    }
    return { text: pages.join("\n\n").trim(), pages: pdf.numPages };
  } finally {
    await pdf.destroy();
  }
}
