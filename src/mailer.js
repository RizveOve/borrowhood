// Mail worker for the AWS deployment: reads queued emails from SQS (fed by the SNS topic) and
// sends them through SES. A message is deleted only after it was sent; otherwise SQS hands it out
// again later, and after a few failed attempts moves it to the dead-letter queue.
const { deliverMail } = require('./notify');

function startMailer() {
  const QueueUrl = process.env.MAIL_QUEUE_URL;
  if (!QueueUrl) return;
  const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
  const sqs = new SQSClient({});

  async function poll() {
    try {
      // Long polling: waits up to 20 s for mail, so an idle site makes ~130k requests a month (free tier: 1M).
      const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20 }));
      for (const m of Messages) {
        try {
          const { to, subject, text } = JSON.parse(m.Body);
          await deliverMail(to, subject, text);
          await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: m.ReceiptHandle }));
        } catch (e) {
          console.error('[mailer] will retry message', m.MessageId, e.message);
        }
      }
      setImmediate(poll);
    } catch (e) {
      console.error('[mailer] queue error', e.message);
      setTimeout(poll, 30_000);
    }
  }
  poll();
  console.log('[mailer] sending queued emails');
}

module.exports = { startMailer };
