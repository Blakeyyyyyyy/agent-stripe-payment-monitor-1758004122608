const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const OpenAI = require('openai');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.raw({ type: 'application/json' }));
app.use(express.json());

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Email transporter (using Gmail SMTP)
const transporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.ALERT_EMAIL || 'your-email@gmail.com',
    pass: process.env.EMAIL_PASSWORD || 'your-app-password'
  }
});

// In-memory logs
const logs = [];

function addLog(level, message, data = null) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    data
  };
  logs.push(logEntry);
  console.log(`[${level}] ${message}`, data || '');
  
  if (logs.length > 100) {
    logs.shift();
  }
}

// Generate intelligent email content using OpenAI
async function generateEmailContent(failedPayment) {
  try {
    const prompt = `Generate a professional email alert for a failed payment with the following details:
    
Customer: ${failedPayment.customer?.name || 'Unknown'}
Email: ${failedPayment.customer?.email || 'Not provided'}
Amount: $${(failedPayment.amount / 100).toFixed(2)}
Currency: ${failedPayment.currency?.toUpperCase() || 'USD'}
Failure Code: ${failedPayment.failure_code || 'Unknown'}
Failure Message: ${failedPayment.failure_message || 'No details provided'}
Payment Method: ${failedPayment.payment_method_details?.type || 'Unknown'}

Please create:
1. A clear subject line
2. A professional email body that includes next steps
3. Keep it concise but informative

Format as JSON with "subject" and "body" fields.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 500
    });

    return JSON.parse(completion.choices[0].message.content);
  } catch (error) {
    addLog('error', 'Failed to generate email content with OpenAI', error.message);
    
    return {
      subject: `🚨 Payment Failed - $${(failedPayment.amount / 100).toFixed(2)} from ${failedPayment.customer?.email || 'Unknown Customer'}`,
      body: `A payment has failed in your Stripe account.

Details:
- Customer: ${failedPayment.customer?.name || 'Unknown'} (${failedPayment.customer?.email || 'Not provided'})
- Amount: $${(failedPayment.amount / 100).toFixed(2)} ${failedPayment.currency?.toUpperCase() || 'USD'}
- Failure Reason: ${failedPayment.failure_message || 'No details provided'}
- Failure Code: ${failedPayment.failure_code || 'Unknown'}
- Payment Method: ${failedPayment.payment_method_details?.type || 'Unknown'}

Next Steps:
1. Review the failure reason above
2. Contact the customer if needed
3. Check your Stripe dashboard for more details

This is an automated alert from your Stripe monitoring system.`
    };
  }
}

// Send email alert
async function sendEmailAlert(failedPayment) {
  try {
    const emailContent = await generateEmailContent(failedPayment);
    
    const mailOptions = {
      from: process.env.ALERT_EMAIL || 'stripe-monitor@yourdomain.com',
      to: process.env.ALERT_EMAIL || 'admin@yourdomain.com',
      subject: emailContent.subject,
      text: emailContent.body,
      html: emailContent.body.replace(/\n/g, '<br>')
    };

    const info = await transporter.sendMail(mailOptions);
    addLog('info', 'Email alert sent successfully', { messageId: info.messageId });
    return true;
  } catch (error) {
    addLog('error', 'Failed to send email alert', error.message);
    return false;
  }
}

// Standard endpoints
app.get('/', (req, res) => {
  res.json({
    status: 'active',
    service: 'Stripe Failed Payment Monitor',
    endpoints: [
      'GET / - This status page',
      'GET /health - Health check',
      'GET /logs - View recent logs',
      'POST /test - Test email alerts',
      'POST /webhook - Stripe webhook endpoint'
    ],
    lastActivity: logs.length > 0 ? logs[logs.length - 1].timestamp : 'No activity yet'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: {
      stripe_configured: !!process.env.STRIPE_SECRET_KEY,
      openai_configured: !!process.env.OPENAI_API_KEY,
      email_configured: !!process.env.ALERT_EMAIL
    }
  });
});

app.get('/logs', (req, res) => {
  const recentLogs = logs.slice(-50);
  res.json({
    total: logs.length,
    logs: recentLogs
  });
});

app.post('/test', async (req, res) => {
  addLog('info', 'Manual test triggered');
  
  const testPayment = {
    amount: 2999,
    currency: 'usd',
    failure_code: 'card_declined',
    failure_message: 'Your card was declined.',
    customer: {
      name: 'Test Customer',
      email: 'test@example.com'
    },
    payment_method_details: {
      type: 'card'
    }
  };

  try {
    const success = await sendEmailAlert(testPayment);
    res.json({
      success,
      message: success ? 'Test email sent successfully!' : 'Test email failed to send',
      testPayment
    });
  } catch (error) {
    addLog('error', 'Test failed', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Stripe webhook endpoint
app.post('/webhook', async (req, res) => {
  try {
    const event = JSON.parse(req.body);
    addLog('info', `Received Stripe event: ${event.type}`);

    if (event.type === 'payment_intent.payment_failed' || 
        event.type === 'invoice.payment_failed' ||
        event.type === 'charge.failed') {
      
      const paymentData = event.data.object;
      addLog('warning', 'Payment failure detected', {
        amount: paymentData.amount,
        customer: paymentData.customer,
        failure_code: paymentData.failure_code
      });

      await sendEmailAlert(paymentData);
    }

    res.json({ received: true });
  } catch (error) {
    addLog('error', 'Webhook processing failed', error.message);
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

app.listen(port, () => {
  addLog('info', `Stripe Failed Payment Monitor started on port ${port}`);
});

module.exports = app;