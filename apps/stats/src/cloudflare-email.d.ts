// The one Workers runtime module the entry point uses (`@cloudflare/workers-types` is not a dependency).
declare module 'cloudflare:email' {
  export class EmailMessage {
    constructor(from: string, to: string, raw: string);
    readonly from: string;
    readonly to: string;
  }
}
