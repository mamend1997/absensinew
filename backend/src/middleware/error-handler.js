import { ZodError } from 'zod';
import { config } from '../config/env.js';
import { HttpError } from '../utils/http-error.js';

export function notFoundHandler(_request, _response, next) {
  next(new HttpError(404, 'Endpoint tidak ditemukan'));
}

export function errorHandler(error, _request, response, _next) {
  if (error instanceof ZodError) {
    return response.status(400).json({
      error: 'Data permintaan tidak valid',
      details: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  if (error instanceof HttpError) {
    return response.status(error.status).json({
      error: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
  }

  if (
    error?.code === 'ER_DUP_ENTRY' ||
    error?.errcode === 2067 ||
    error?.errcode === 1555
  ) {
    return response.status(409).json({ error: 'Data dengan nilai unik tersebut sudah ada' });
  }
  if (error?.code === 'ER_NO_REFERENCED_ROW_2' || error?.errcode === 787) {
    return response.status(400).json({ error: 'Referensi unit atau kelas tidak ditemukan' });
  }

  console.error(error);
  return response.status(500).json({
    error: 'Terjadi kesalahan internal',
    ...(config.nodeEnv === 'development' ? { details: error.message } : {}),
  });
}
