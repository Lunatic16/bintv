import { Request } from 'express';

/**
 * Builds the public base URL ("http://192.168.1.20:3010") from the incoming
 * request, honouring X-Forwarded-Host / X-Forwarded-Proto so the same
 * generated playlist works unchanged from localhost, a LAN IP or a reverse proxy.
 */
export function baseUrlFrom(req: Request): string {
  const protoHeader = req.headers['x-forwarded-proto'];
  const proto = typeof protoHeader === 'string' && protoHeader
    ? protoHeader.split(',')[0].trim()
    : req.protocol;
  const hostHeader = req.headers['x-forwarded-host'];
  const host = typeof hostHeader === 'string' && hostHeader
    ? hostHeader.split(',')[0].trim()
    : (req.headers.host || `localhost:${process.env.PORT || 3010}`);
  return `${proto}://${host}`;
}
