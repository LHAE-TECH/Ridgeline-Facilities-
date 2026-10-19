import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    // All tests share one Postgres database, so run files sequentially.
    fileParallelism: false,
    testTimeout: 30000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://ridgeline:ridgeline@localhost:5432/ridgeline_test',
      UPLOAD_DIR: process.env.TEST_UPLOAD_DIR ?? '/tmp/ridgeline-test-uploads',
      SESSION_SECRET: 'test-secret',
      APP_BASE_URL: 'http://localhost:3999',
      SMTP_HOST: '',
      STRIPE_SECRET_KEY: 'sk_test_dummy',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
      XERO_CLIENT_ID: '',
      XERO_CLIENT_SECRET: '',
      // Never let ordinary tests reach Twilio (fixture numbers could belong to real people). Only the live SMS test
      // uses real credentials, passed under LIVE_* names.
      TWILIO_ACCOUNT_SID: '',
      TWILIO_AUTH_TOKEN: '',
      TWILIO_FROM_NUMBER: '',
      TWILIO_MESSAGING_SERVICE_SID: '',
      LIVE_TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ?? '',
      LIVE_TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ?? '',
      LIVE_TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER ?? '',
      LIVE_TWILIO_MESSAGING_SERVICE_SID: process.env.TWILIO_MESSAGING_SERVICE_SID ?? '',
    },
    hookTimeout: 60000,
  },
});
