import type { IncomingHttpHeaders } from 'node:http'

export function makeHeaders(headerName: string, value: string | string[] | undefined): IncomingHttpHeaders {
  return { [headerName]: value }
}
