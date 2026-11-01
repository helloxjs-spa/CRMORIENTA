"use client";

import { FileText, ImageIcon, Loader2, Paperclip, Trash2, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useId, useRef, useState, useTransition } from "react";
import { ActionModal } from "@/components/ui/action-modal";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { IDLE } from "@/lib/action-state";
import { formatDateTime } from "@/lib/format";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import { SALE_ATTACHMENT_TYPES } from "@/lib/sale-attachments";
import { addSaleAttachmentsAction, removeSaleAttachmentAction } from "./actions";

const MAX_MB = BUSINESS_RULES.saleAttachmentMaxBytes / (1024 * 1024);
export const RECEIPTS_HINT = `Imagem (JPG, PNG, WEBP) ou PDF, até ${MAX_MB} MB cada.`;

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

/** Conferência rápida no navegador (o serviço confere de novo, pelo conteúdo). */
function problemOf(file: File): string | null {
  if (!(SALE_ATTACHMENT_TYPES as readonly string[]).includes(file.type)) return "tipo não aceito";
  if (file.size > BUSINESS_RULES.saleAttachmentMaxBytes) return `maior que ${MAX_MB} MB`;
  return null;
}

/**
 * Envia os comprovantes à venda, um arquivo por chamada (limite do corpo da
 * Server Action). Devolve as mensagens dos que falharam.
 */
export function useUploadReceipts() {
  return async (saleId: string, files: File[]): Promise<string[]> => {
    const failed: string[] = [];
    for (const file of files) {
      const data = new FormData();
      data.append("saleId", saleId);
      data.append("receipts", file);
      try {
        const result = await addSaleAttachmentsAction(IDLE, data);
        if (result.status === "error") failed.push(`${file.name}: ${result.message}`);
      } catch {
        failed.push(`${file.name}: falha de conexão.`);
      }
    }
    return failed;
  };
}

/**
 * Seleção de comprovantes. O input NÃO tem `name`: os arquivos não seguem no
 * formulário em que o componente estiver; quem usa envia com useUploadReceipts.
 */
export function ReceiptPicker({ files, onChange, disabled }: { files: File[]; onChange: (files: File[]) => void; disabled?: boolean }) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [rejected, setRejected] = useState<string[]>([]);

  const add = (list: FileList | null) => {
    const picked = Array.from(list ?? []);
    setRejected(picked.flatMap((file) => (problemOf(file) ? [`${file.name}: ${problemOf(file)}`] : [])));
    onChange([...files, ...picked.filter((file) => !problemOf(file))]);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        multiple
        accept={SALE_ATTACHMENT_TYPES.join(",")}
        className="sr-only"
        disabled={disabled}
        onChange={(e) => add(e.target.files)}
      />
      <label
        htmlFor={inputId}
        className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-center text-sm text-slate-600 hover:border-brand-400 hover:bg-brand-50 has-disabled:cursor-not-allowed has-disabled:opacity-60"
      >
        <Upload className="size-5 text-slate-400" aria-hidden />
        <span className="font-medium text-brand-700">Escolher arquivos</span>
        <span className="text-xs text-slate-500">{RECEIPTS_HINT}</span>
      </label>
      {rejected.length > 0 && (
        <ul role="alert" className="space-y-0.5 text-xs font-medium text-red-600">
          {rejected.map((message) => (
            <li key={message}>Não adicionado — {message}</li>
          ))}
        </ul>
      )}
      {files.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-lg ring-1 ring-slate-200">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`} className="flex items-center gap-2 px-3 py-2 text-sm">
              <Paperclip className="size-4 shrink-0 text-slate-400" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-slate-800">{file.name}</span>
              <span className="shrink-0 text-xs tabular-nums text-slate-500">{formatBytes(file.size)}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(files.filter((_, i) => i !== index))}
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label={`Tirar ${file.name}`}
              >
                <X className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export type ReceiptItem = { id: string; fileName: string; contentType: string; sizeBytes: number; createdAt: Date; uploadedByName: string };

/** Comprovantes da venda (detalhe): lista para abrir e, para quem pode, anexar mais. */
export function SaleReceipts({ saleId, receipts, canAttach }: { saleId: string; receipts: ReceiptItem[]; canAttach: boolean }) {
  const [files, setFiles] = useState<File[]>([]);
  const [pending, startTransition] = useTransition();
  const upload = useUploadReceipts();
  const toast = useToast();
  const router = useRouter();
  const [removing, setRemoving] = useState<ReceiptItem | null>(null);
  const closeRemoval = useCallback(() => setRemoving(null), []);

  const send = () =>
    startTransition(async () => {
      const failed = await upload(saleId, files);
      const sent = files.length - failed.length;
      if (sent > 0) toast(sent === 1 ? "Comprovante anexado." : `${sent} comprovantes anexados.`);
      for (const message of failed) toast(message, "error");
      setFiles([]);
      router.refresh();
    });

  return (
    <div className="space-y-4 p-5">
      {receipts.length === 0 ? (
        <p className="text-sm text-slate-500">Nenhum comprovante anexado.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg ring-1 ring-slate-200">
          {receipts.map((receipt) => {
            const Icon = receipt.contentType === "application/pdf" ? FileText : ImageIcon;
            return (
              <li key={receipt.id} className="flex items-center gap-1 pr-2 hover:bg-slate-50">
                <a
                  href={`/vendas/${saleId}/comprovantes/${receipt.id}`}
                  target="_blank"
                  rel="noopener"
                  className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5"
                >
                  <Icon className="size-5 shrink-0 text-slate-400" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-brand-700">{receipt.fileName}</span>
                    <span className="block text-xs text-slate-500">
                      {formatBytes(receipt.sizeBytes)} · {receipt.uploadedByName} · {formatDateTime(receipt.createdAt)}
                    </span>
                  </span>
                </a>
                {canAttach && (
                  <button
                    type="button"
                    onClick={() => setRemoving(receipt)}
                    className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline-2 focus-visible:outline-brand-600"
                    aria-label={`Remover ${receipt.fileName}`}
                    title="Remover comprovante"
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <ActionModal
        open={!!removing}
        onClose={closeRemoval}
        title="Remover comprovante?"
        description="Ele sai da venda e não pode mais ser aberto aqui. O registro fica guardado na Auditoria, com quem removeu e quando."
        action={removeSaleAttachmentAction}
        submitLabel="Remover"
        submitVariant="danger"
      >
        {() =>
          removing && (
            <>
              <input type="hidden" name="saleId" value={saleId} />
              <input type="hidden" name="attachmentId" value={removing.id} />
              <p className="truncate rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-800 ring-1 ring-slate-200">{removing.fileName}</p>
            </>
          )
        }
      </ActionModal>
      {canAttach && (
        <div className="space-y-2">
          <ReceiptPicker files={files} onChange={setFiles} disabled={pending} />
          {files.length > 0 && (
            <div className="flex justify-end">
              <Button size="sm" onClick={send} disabled={pending}>
                {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Upload className="size-4" aria-hidden />}
                {files.length === 1 ? "Anexar comprovante" : `Anexar ${files.length} comprovantes`}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
