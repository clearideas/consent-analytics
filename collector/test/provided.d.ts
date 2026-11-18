// Values provided by the shared services setup (../server/test/support/services.ts).
import 'vitest'

declare module 'vitest' {
  export interface ProvidedContext {
    mongodbUrl: string
    mongodbFastTtl: boolean
    redisUrl: string
    postgresUrl: string
    mysqlUrl: string
    awsEndpoint: string
  }
}
