import type { HttpClient } from '../http/client.js';
import { ensureOk } from '../http/translate-error.js';

export interface AttachmentMetadata {
  name: string;
  content_type: string;
  size_bytes: number;
  table: string;
  record_sys_id: string;
}

export interface Attachment {
  metadata: AttachmentMetadata;
  content_base64: string;
}

export interface AttachmentApi {
  getAttachment(sysId: string): Promise<Attachment>;
}

export function createAttachmentApi(http: HttpClient): AttachmentApi {
  return {
    async getAttachment(sysId) {
      const metaRes = await http.request(`/api/now/attachment/${encodeURIComponent(sysId)}`);
      const metaOk = await ensureOk(metaRes);
      const metaBody = (await metaOk.json()) as { result: Record<string, string> };
      const r = metaBody.result;
      const metadata: AttachmentMetadata = {
        name: r.file_name ?? '',
        content_type: r.content_type ?? 'application/octet-stream',
        size_bytes: Number(r.size_bytes ?? 0),
        table: r.table_name ?? '',
        record_sys_id: r.table_sys_id ?? '',
      };
      const fileRes = await http.request(`/api/now/attachment/${encodeURIComponent(sysId)}/file`);
      const fileOk = await ensureOk(fileRes);
      const bytes = new Uint8Array(await fileOk.arrayBuffer());
      return { metadata, content_base64: Buffer.from(bytes).toString('base64') };
    },
  };
}
