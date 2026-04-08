const express = require('express');
const { v4: uuidv4 } = require('uuid');
const client = require('prom-client');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const activeRequests = new client.Gauge({
  name: 'active_requests',
  help: 'Number of requests currently being processed',
  registers: [register],
});

const inferenceCounter = new client.Counter({
  name: 'inference_requests_total',
  help: 'Total number of inference requests',
  labelNames: ['status'],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || uuidv4();
  res.setHeader('X-Request-Id', req.requestId);
  next();
});

// ---------------------------------------------------------------------------
// Health & readiness probes
// ---------------------------------------------------------------------------
app.get('/healthz', (_req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/readyz', (_req, res) => {
  // In production this would verify downstream dependencies (model loaded, GPU available, etc.)
  res.json({ status: 'ready', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Metrics endpoint for Prometheus scraping
// ---------------------------------------------------------------------------
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ---------------------------------------------------------------------------
// Main inference endpoint
// ---------------------------------------------------------------------------
app.post('/api/v1/inference', async (req, res) => {
  const end = httpRequestDuration.startTimer({ method: 'POST', route: '/api/v1/inference' });
  activeRequests.inc();

  try {
    const { document, options } = req.body;

    if (!document) {
      inferenceCounter.inc({ status: 'error' });
      end({ status: 400 });
      activeRequests.dec();
      return res.status(400).json({
        error: 'Missing required field: document',
        requestId: req.requestId,
      });
    }

    // Simulate ML inference processing (placeholder for actual model call)
    const processingTime = 100 + Math.random() * 200; // 100-300ms
    await new Promise((resolve) => setTimeout(resolve, processingTime));

    const result = {
      requestId: req.requestId,
      status: 'completed',
      processingTimeMs: Math.round(processingTime),
      output: {
        summary: `Processed document (${document.length || 0} chars)`,
        entities: [
          { type: 'PERSON', value: 'Sample Entity', confidence: 0.95 },
          { type: 'ORG', value: 'Virallens', confidence: 0.99 },
        ],
        classification: {
          category: options?.category || 'general',
          confidence: 0.92,
        },
        metadata: {
          modelVersion: process.env.MODEL_VERSION || 'v1.0.0',
          timestamp: new Date().toISOString(),
        },
      },
    };

    inferenceCounter.inc({ status: 'success' });
    end({ status: 200 });
    activeRequests.dec();
    res.json(result);
  } catch (err) {
    inferenceCounter.inc({ status: 'error' });
    end({ status: 500 });
    activeRequests.dec();
    console.error(`[${req.requestId}] Inference error:`, err.message);
    res.status(500).json({
      error: 'Internal inference error',
      requestId: req.requestId,
    });
  }
});

// ---------------------------------------------------------------------------
// Batch inference endpoint
// ---------------------------------------------------------------------------
app.post('/api/v1/inference/batch', async (req, res) => {
  const { documents } = req.body;

  if (!Array.isArray(documents) || documents.length === 0) {
    return res.status(400).json({ error: 'documents must be a non-empty array' });
  }

  const results = await Promise.all(
    documents.map(async (doc, i) => {
      const processingTime = 50 + Math.random() * 150;
      await new Promise((resolve) => setTimeout(resolve, processingTime));
      return {
        index: i,
        status: 'completed',
        processingTimeMs: Math.round(processingTime),
        summary: `Processed document ${i + 1}`,
      };
    })
  );

  res.json({ requestId: req.requestId, results });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Virallens Inference Service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
