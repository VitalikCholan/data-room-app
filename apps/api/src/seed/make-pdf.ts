import { PDFDocument, StandardFonts } from 'pdf-lib'

/**
 * Real PDFs, not placeholder bytes. The viewer streams these straight out of the
 * bucket into pdf.js, so seed files have to be structurally valid documents — a
 * text file named `.pdf` would pass every check in the API and then fail to render.
 */
export async function makePdf(title: string, lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const page = doc.addPage([595, 842])

  page.drawText(sanitize(title), { x: 56, y: 760, size: 20, font: bold })
  page.drawText('Project Titan - confidential due diligence material', {
    x: 56,
    y: 736,
    size: 10,
    font,
  })

  lines.forEach((line, index) => {
    page.drawText(sanitize(line), {
      x: 56,
      y: 690 - index * 18,
      size: 11,
      font,
    })
  })

  return Buffer.from(await doc.save())
}

/**
 * The standard 14 fonts are WinAnsi-encoded, and pdf-lib throws rather than
 * substituting when a glyph is missing — an em dash in a document name would fail
 * the whole seed. Folding to ASCII keeps names like "Reseller Agreement — EMEA"
 * usable as titles while the node name itself keeps its real characters.
 */
function sanitize(text: string): string {
  return text
    .replace(/[‐-―]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7e]/g, '')
}
