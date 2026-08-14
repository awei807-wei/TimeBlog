export class AdminRequestError extends Error {
  status: number;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = 'AdminRequestError';
    this.status = status;
  }
}

export async function responseError(response: Response, fallback: string): Promise<AdminRequestError> {
  const body = await response.json().catch(() => ({})) as { detail?: string; title?: string };
  const detail = typeof body.detail === 'string' && body.detail.trim() ? body.detail.trim() : fallback;
  return new AdminRequestError(response.status, detail);
}
