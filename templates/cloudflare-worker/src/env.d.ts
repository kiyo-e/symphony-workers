declare global {
  interface Env extends CloudflareBindings {
    CLOUDFLARE_ACCOUNT_ID: string;
    CLOUDFLARE_API_TOKEN: string;

    GITHUB_TOKEN?: string;
    GITHUB_WEBHOOK_SECRET: string;
  }
}

export {};

