import 'dotenv/config';

function bool(v: string | undefined, dflt = false): boolean {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const env = process.env;

export const config = {
  env: env.NODE_ENV ?? 'development',
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: Number(env.PORT ?? 3000),
  baseUrl: (env.APP_BASE_URL ?? `http://localhost:${env.PORT ?? 3000}`).replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL ?? 'postgres://ridgeline:ridgeline@localhost:5432/ridgeline_dev',
  databaseSsl: bool(env.DATABASE_SSL),
  sessionSecret: env.SESSION_SECRET ?? 'dev-only-session-secret',
  runWorkerInProcess: bool(env.RUN_WORKER_IN_PROCESS, true),
  storage: {
    driver: (env.STORAGE_DRIVER ?? 'local') as 'local' | 's3',
    uploadDir: env.UPLOAD_DIR ?? './data/uploads',
    maxUploadBytes: Number(env.MAX_UPLOAD_MB ?? 15) * 1024 * 1024,
    s3: {
      bucket: env.S3_BUCKET ?? '',
      region: env.S3_REGION ?? 'auto',
      endpoint: env.S3_ENDPOINT || undefined,
      accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
    },
  },
  smtp: {
    host: env.SMTP_HOST ?? '',
    port: Number(env.SMTP_PORT ?? 587),
    user: env.SMTP_USER ?? '',
    pass: env.SMTP_PASS ?? '',
    secure: bool(env.SMTP_SECURE),
    from: env.EMAIL_FROM ?? 'Ridgeline Facilities <no-reply@ridgelinefacilities.com>',
  },
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY ?? '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? '',
  },
  xero: {
    clientId: env.XERO_CLIENT_ID ?? '',
    clientSecret: env.XERO_CLIENT_SECRET ?? '',
    salesAccountCode: env.XERO_SALES_ACCOUNT_CODE ?? '200',
    costAccountCode: env.XERO_COST_ACCOUNT_CODE ?? '310',
    bankAccountCode: env.XERO_BANK_ACCOUNT_CODE ?? '090',
  },
  seedAdmin: {
    email: env.SEED_ADMIN_EMAIL ?? '',
    password: env.SEED_ADMIN_PASSWORD ?? '',
    name: env.SEED_ADMIN_NAME ?? 'Ridgeline Administrator',
  },
};

if (config.isProduction && config.sessionSecret === 'dev-only-session-secret') {
  throw new Error('SESSION_SECRET must be set in production');
}

export type IntegrationMode = 'live' | 'test' | 'unconfigured';

/** Reports the true state of each external integration (used on the admin integrations page). */
export function integrationStatus(): Record<string, { mode: IntegrationMode; detail: string }> {
  const stripeMode: IntegrationMode = !config.stripe.secretKey
    ? 'unconfigured'
    : config.stripe.secretKey.startsWith('sk_live_') ? 'live' : 'test';
  return {
    email: config.smtp.host
      ? { mode: 'live', detail: `SMTP via ${config.smtp.host}:${config.smtp.port}` }
      : { mode: 'unconfigured', detail: 'SMTP_HOST not set: notifications are recorded but not sent' },
    stripe: {
      mode: stripeMode,
      detail: stripeMode === 'unconfigured'
        ? 'Card top-ups disabled; bank transfer top-ups confirmed manually'
        : `Stripe ${stripeMode} mode${config.stripe.webhookSecret ? '' : ' (WARNING: STRIPE_WEBHOOK_SECRET missing, payments cannot be confirmed)'}`,
    },
    xero: config.xero.clientId && config.xero.clientSecret
      ? { mode: 'live', detail: 'Xero Custom Connection credentials configured' }
      : { mode: 'unconfigured', detail: 'Xero credentials not set: accounting sync is queued but skipped' },
    storage: config.storage.driver === 's3'
      ? { mode: 'live', detail: `S3-compatible bucket ${config.storage.s3.bucket}` }
      : { mode: 'live', detail: `Local private disk at ${config.storage.uploadDir}` },
    sms: { mode: 'unconfigured', detail: 'SMS not yet integrated (email only)' },
    contractorPayouts: { mode: 'unconfigured', detail: 'No payout provider: payments are made by bank batch export and confirmed manually' },
  };
}
