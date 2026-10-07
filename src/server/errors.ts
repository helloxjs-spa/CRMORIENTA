/**
 * Erros de domínio. Serviços lançam estes erros; a camada de entrega (Server
 * Actions / páginas) os converte em respostas para a interface.
 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code: "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "VALIDATION" | "CONFLICT",
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = "Sessão expirada. Faça login novamente.") {
    super(message, "UNAUTHENTICATED");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Você não tem permissão para executar esta ação.") {
    super(message, "FORBIDDEN");
  }
}

/**
 * Usado também quando o recurso existe mas está fora do escopo do usuário,
 * para não revelar a existência de registros de outras equipes/vendedores.
 */
export class NotFoundError extends AppError {
  constructor(message = "Registro não encontrado.") {
    super(message, "NOT_FOUND");
  }
}

export class ValidationError extends AppError {
  constructor(
    message: string,
    readonly fieldErrors: Record<string, string[]> = {},
  ) {
    super(message, "VALIDATION");
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, "CONFLICT");
  }
}
