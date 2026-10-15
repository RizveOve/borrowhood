// Sends return reminders and overdue alerts every hour.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const borrowhood = require('../../src/netlify.js');

export default async () => {
  await borrowhood.runScheduledReminders();
};

export const config = { schedule: '@hourly' };
