import "server-only";
import { notFound } from "next/navigation";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";

/**
 * Para páginas: sem permissão, fora do escopo ou ID inválido resultam todos em
 * 404, sem revelar se o registro existe.
 */
export async function orNotFound<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError || error instanceof ValidationError) notFound();
    throw error;
  }
}
