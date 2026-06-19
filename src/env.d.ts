declare global {
  interface Env extends CloudflareBindings {
    CLOUDFLARE_ACCOUNT_ID: string;
    CLOUDFLARE_API_TOKEN: string;
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;

    GITHUB_TOKEN?: string;
    GITHUB_WEBHOOK_SECRET: string;
  }
}

export {};
