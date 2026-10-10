import { api } from './api';

/** Número no formato do WhatsApp (55 + DDD + número). */
export function waPhone(phone: string | null | undefined): string {
  const d = (phone ?? '').replace(/\D/g, '');
  if (!d) return '';
  return d.length <= 11 ? `55${d}` : d;
}

export function openWhatsApp(text: string, phone?: string | null) {
  const p = waPhone(phone);
  window.open(`https://wa.me/${p}?text=${encodeURIComponent(text)}`, '_blank');
}

/**
 * Compartilha um PDF pelo WhatsApp. No celular usa o compartilhamento nativo (o arquivo vai junto);
 * no computador baixa o PDF e abre o WhatsApp com a mensagem para anexar o arquivo.
 */
export async function sharePdf(path: string, filename: string, text: string, phone?: string | null): Promise<'shared' | 'fallback'> {
  const blob = await api<Blob>(path, { raw: true });
  const file = new File([blob], filename, { type: 'application/pdf' });
  const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], text, title: filename });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'shared';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  openWhatsApp(`${text}\n\n(O PDF "${filename}" foi baixado; anexe-o nesta conversa.)`, phone);
  return 'fallback';
}
