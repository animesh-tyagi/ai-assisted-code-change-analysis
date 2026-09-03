/**
 * HTTP client for the parser service (ARCHITECTURE §8). Native `fetch` — Node 22
 * ships it, so no HTTP client dependency is needed.
 */

import type {
  ParseRequestWire,
  ParseResponseWire,
  VersionResponseWire,
} from '@impact/shared';

export class ParserRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'ParserRequestError';
  }
}

export async function getVersion(parserUrl: string): Promise<VersionResponseWire> {
  const res = await fetch(`${parserUrl}/v1/version`);
  if (!res.ok) {
    throw new ParserRequestError(
      `GET /v1/version failed: ${String(res.status)}`,
      res.status,
      await safeJson(res),
    );
  }
  return (await res.json()) as VersionResponseWire;
}

export async function postParse(
  parserUrl: string,
  request: ParseRequestWire,
): Promise<ParseResponseWire> {
  const res = await fetch(`${parserUrl}/v1/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    throw new ParserRequestError(
      `POST /v1/parse failed: ${String(res.status)}`,
      res.status,
      await safeJson(res),
    );
  }
  return (await res.json()) as ParseResponseWire;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
