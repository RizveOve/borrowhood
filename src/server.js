// Runs BorrowHood as a normal long-running server (local development and EC2).
const { app, init } = require('./app');
const { startJobs } = require('./jobs');

if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
  console.error('SESSION_SECRET must be set in production');
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 3000;
(async () => {
  await init();
  app.listen(PORT, () => console.log(`BorrowHood running on http://localhost:${PORT}`));
  startJobs();
})();
