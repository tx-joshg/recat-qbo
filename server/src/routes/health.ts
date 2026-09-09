import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { requireRole, requireUser } from '../middleware/auth.js';
import { withCompany } from '../middleware/company.js';
import { classificationEmbeddingRuntimeConfig } from '../services/classification/embedding/client.js';
import { classificationSemanticHealth } from '../services/classification/embedding/health.js';
import { classificationEmbeddingGeneration } from '../services/classification/embedding/recipe.js';
import { PgClassificationVectorStore } from '../services/classification/embedding/vectorStore.js';

/** Authenticated, company-scoped diagnostics. Credentials and provider bodies
 * are deliberately absent from this response. */
export const healthRouter = Router({ mergeParams: true });
healthRouter.use(requireUser, withCompany({ allowDisconnected: true }), requireRole('viewer'));

healthRouter.get(
  '/classification-search',
  asyncHandler(async (req, res) => {
    const companyId = req.company?.id;
    if (companyId === undefined) {
      res.status(404).json({ error: 'Company not found' });
      return;
    }
    let generation = null;
    let invalidConfiguration = false;
    try {
      const config = classificationEmbeddingRuntimeConfig();
      generation = config === null ? null : classificationEmbeddingGeneration({
        baseUrl: config.baseUrl, fingerprintSalt: config.fingerprintSalt,
      });
    } catch {
      invalidConfiguration = true;
    }
    const health = await classificationSemanticHealth(companyId, {
      generation, store: new PgClassificationVectorStore(prisma),
    });
    res.json(invalidConfiguration ? { ...health, lastError: 'invalid_configuration' } : health);
  }),
);
