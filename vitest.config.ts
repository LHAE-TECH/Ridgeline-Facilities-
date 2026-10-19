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
    },
    hookTimeout: 60000,
  },
});
