import 'dotenv/config';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return v;
}

export const config = {
  env: env('NODE_ENV', 'development'),
  isProd: process.env.NODE_ENV === 'production',
  port: Number(env('PORT', '4000')),
  appUrl: env('APP_URL', 'http://localhost:5173'),
  apiUrl: env('API_URL', 'http://localhost:4000'),
  corsOrigins: env('CORS_ORIGINS', 'http://localhost:5173').split(',').map((s) => s.trim()),
  jwtSecret: env('JWT_SECRET', process.env.NODE_ENV === 'production' ? undefined : 'dev-secret'),
  jwtAccessTtl: env('JWT_ACCESS_TTL', '15m'),
  jwtRefreshDays: Number(env('JWT_REFRESH_DAYS', '30')),
  encryptionKey: env('ENCRYPTION_KEY', '0'.repeat(64)),
  cookieSecure: env('COOKIE_SECURE', 'false') === 'true',
  storage: {
    driver: env('STORAGE_DRIVER', 'local'),
    localPath: env('STORAGE_LOCAL_PATH', './storage'),
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'no-reply@localhost',
  },
  sms: {
    provider: env('SMS_PROVIDER', 'console'),
    twilioSid: process.env.SMS_TWILIO_ACCOUNT_SID || '',
    twilioToken: process.env.SMS_TWILIO_AUTH_TOKEN || '',
    twilioFrom: process.env.SMS_TWILIO_FROM || '',
  },
  payments: {
    provider: env('PAYMENTS_PROVIDER', 'mock'),
    webhookSecret: env('PAYMENTS_WEBHOOK_SECRET', 'dev-webhook-secret'),
    apiKey: process.env.PAYMENTS_API_KEY || '',
  },
  signature: {
    provider: env('SIGNATURE_PROVIDER', 'mock'),
    webhookSecret: env('SIGNATURE_WEBHOOK_SECRET', 'dev-signature-secret'),
    apiKey: process.env.SIGNATURE_API_KEY || '',
  },
  backup: {
    path: env('BACKUP_PATH', './backups'),
    retentionDays: Number(env('BACKUP_RETENTION_DAYS', '30')),
  },
  worker: {
    collectionsCron: env('WORKER_CRON_COLLECTIONS', '*/5 * * * *'),
    monthlyCloseCron: env('WORKER_CRON_MONTHLY_CLOSE', '10 0 * * *'),
  },
  defaultTimezone: env('DEFAULT_TIMEZONE', 'America/Sao_Paulo'),
};
