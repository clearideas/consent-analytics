// Test-only modules without their own type declarations.
declare module 'express4' {
  // Express 4 (installed as the "express4" alias); its API is close enough to 5 for these tests.
  import express from 'express'
  export default express
}

declare module 'cors' {
  import type { RequestHandler } from 'express'
  export default function cors(options?: Record<string, unknown>): RequestHandler
}
