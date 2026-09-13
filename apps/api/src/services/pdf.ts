import PDFDocument from 'pdfkit';

/**
 * Geração de PDF com pdfkit a partir de uma estrutura simples de blocos.
 * Usada em contratos, recibos e relatórios, sem dependência de navegador.
 */
export type Block =
  | { type: 'title'; text: string }
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'small'; text: string }
  | { type: 'kv'; rows: Array<[string, string]> }
  | { type: 'table'; columns: Array<{ label: string; width?: number; align?: 'left' | 'right' }>; rows: string[][] }
  | { type: 'spacer'; size?: number }
  | { type: 'signature'; lines: string[] };

export interface PdfOptions { title?: string; header?: string; footer?: string; landscape?: boolean }

export function renderPdf(blocks: Block[], opts: PdfOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, layout: opts.landscape ? 'landscape' : 'portrait', info: { Title: opts.title ?? 'Documento' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const width = doc.page.width - 100;

    const drawHeader = () => {
      if (opts.header) {
        doc.fontSize(9).fillColor('#5b6776').text(opts.header, 50, 30, { width, align: 'right' });
        doc.fillColor('#000');
      }
    };
    drawHeader();
    doc.on('pageAdded', drawHeader);
    doc.y = 60;

    const ensure = (h: number) => { if (doc.y + h > doc.page.height - 60) doc.addPage(); };

    for (const b of blocks) {
      switch (b.type) {
        case 'title': ensure(40); doc.font('Helvetica-Bold').fontSize(15).text(b.text, { align: 'center' }); doc.moveDown(0.8); break;
        case 'heading': ensure(30); doc.font('Helvetica-Bold').fontSize(11).text(b.text); doc.moveDown(0.3); break;
        case 'paragraph': ensure(20); doc.font('Helvetica').fontSize(10).text(b.text, { align: 'justify', lineGap: 2 }); doc.moveDown(0.5); break;
        case 'small': ensure(15); doc.font('Helvetica').fontSize(8).fillColor('#5b6776').text(b.text, { lineGap: 1 }); doc.fillColor('#000'); doc.moveDown(0.4); break;
        case 'spacer': doc.moveDown(b.size ?? 1); break;
        case 'kv': {
          for (const [k, v] of b.rows) {
            ensure(16);
            const y = doc.y;
            doc.font('Helvetica-Bold').fontSize(9.5).text(k, 50, y, { width: 180 });
            doc.font('Helvetica').fontSize(9.5).text(v, 235, y, { width: width - 185 });
            doc.y = Math.max(doc.y, y + 14);
          }
          doc.moveDown(0.5);
          break;
        }
        case 'table': {
          const total = b.columns.reduce((a, c) => a + (c.width ?? 1), 0);
          const widths = b.columns.map((c) => ((c.width ?? 1) / total) * width);
          const row = (cells: string[], bold: boolean, fill?: string) => {
            ensure(18);
            const y = doc.y;
            if (fill) doc.rect(50, y - 2, width, 16).fill(fill).fillColor('#000');
            let x = 50;
            cells.forEach((cell, i) => {
              doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor('#000').text(cell, x + 3, y + 1, { width: widths[i] - 6, align: b.columns[i].align ?? 'left', lineBreak: false });
              x += widths[i];
            });
            doc.y = y + 16;
            doc.moveTo(50, doc.y - 1).lineTo(50 + width, doc.y - 1).strokeColor('#dfe4ea').lineWidth(0.5).stroke();
          };
          row(b.columns.map((c) => c.label), true, '#e3ebf4');
          for (const r of b.rows) row(r, false);
          doc.moveDown(0.8);
          break;
        }
        case 'signature': {
          ensure(90);
          doc.moveDown(2);
          for (const line of b.lines) {
            ensure(50);
            doc.moveTo(120, doc.y).lineTo(doc.page.width - 120, doc.y).strokeColor('#000').lineWidth(0.8).stroke();
            doc.moveDown(0.3);
            doc.font('Helvetica').fontSize(9).text(line, { align: 'center' });
            doc.moveDown(2);
          }
          break;
        }
      }
    }
    if (opts.footer) {
      doc.fontSize(8).fillColor('#5b6776').text(opts.footer, 50, doc.page.height - 45, { width, align: 'center' });
    }
    doc.end();
  });
}
