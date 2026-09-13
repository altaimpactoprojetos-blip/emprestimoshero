export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string = 'APP_ERROR',
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (msg = 'Registro não encontrado') => new AppError(404, msg, 'NOT_FOUND');
export const badRequest = (msg: string, details?: unknown) => new AppError(400, msg, 'BAD_REQUEST', details);
export const unauthorized = (msg = 'Não autenticado') => new AppError(401, msg, 'UNAUTHORIZED');
export const forbidden = (msg = 'Sem permissão para esta operação') => new AppError(403, msg, 'FORBIDDEN');
export const conflict = (msg: string) => new AppError(409, msg, 'CONFLICT');
