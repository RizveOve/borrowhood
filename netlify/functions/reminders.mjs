// Sends return reminders and overdue alerts every hour.
import borrowhood from '../../src/netlify.js';

export default async () => {
  await borrowhood.runScheduledReminders();
};

export const config = { schedule: '@hourly' };
