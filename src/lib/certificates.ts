/**
 * Certificados (§18): constantes puras usadas pelo serviço e pela tela.
 */

export const CERTIFICATE_PAGE_SIZES = [25, 50, 100] as const;
export type CertificatePageSize = (typeof CERTIFICATE_PAGE_SIZES)[number];

/** Data usada no filtro de período: conclusão do curso ou entrega do certificado. */
export const CERTIFICATE_DATE_FIELDS = ["completed", "delivered"] as const;
export type CertificateDateField = (typeof CERTIFICATE_DATE_FIELDS)[number];

export const CERTIFICATE_DATE_FIELD_LABELS: Record<CertificateDateField, string> = {
  completed: "Data de conclusão",
  delivered: "Data de entrega",
};

/** Limite da certificadora (texto livre), igual ao CHECK do banco. */
export const CERTIFIER_MAX_LENGTH = 200;
