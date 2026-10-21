export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
  }
}

export function badRequest(code: string, message: string): ServiceError {
  return new ServiceError(400, code, message);
}

export function notFound(message = '未找到请求的资源。'): ServiceError {
  return new ServiceError(404, 'not_found', message);
}

export function conflict(code: string, message: string): ServiceError {
  return new ServiceError(409, code, message);
}
