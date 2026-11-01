/** Tipos de comprovante aceitos (o serviço confere pelo conteúdo do arquivo; o 007 tem o mesmo CHECK). */
export const SALE_ATTACHMENT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export type SaleAttachmentType = (typeof SALE_ATTACHMENT_TYPES)[number];
