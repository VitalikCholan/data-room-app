import { PDFDocument } from 'pdf-lib'
import { makePdf } from './make-pdf'

describe('makePdf', () => {
  it('produces bytes a PDF parser accepts', async () => {
    const bytes = await makePdf('Cap Table', ['line one', 'line two'])

    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    const parsed = await PDFDocument.load(bytes)
    expect(parsed.getPageCount()).toBe(1)
  })

  /**
   * The standard 14 fonts cannot encode an em dash, and pdf-lib throws rather than
   * substituting — so a seeded document named "NDA — Acquirer.pdf" would abort the
   * whole seed if the title were drawn verbatim.
   */
  it('survives characters the standard fonts cannot encode', async () => {
    await expect(
      makePdf('Reseller Agreement — EMEA', ['“quoted” — ok']),
    ).resolves.toBeInstanceOf(Buffer)
  })
})
