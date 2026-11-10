import { INestApplication } from '@nestjs/common';
import { json, raw } from 'express';
/** Called before routes; exact bytes are hashed, never JSON reserialization. */
export function configureRecoveryBodyParser(app: INestApplication) {
  app.use('/recovery/sessions', (req, res, next) => {
    if (req.method === 'POST' && (req.path === '/' || req.path === ''))
      return raw({ type: 'application/json', limit: '16mb', inflate: false })(
        req,
        res,
        next,
      );
    if (req.method === 'PUT' && /^\/[^/]+\/chunks\/[^/]+\/?$/.test(req.path))
      return raw({
        type: 'application/x-ndjson',
        limit: '4mb',
        inflate: false,
      })(req, res, next);
    return next();
  });
  app.use(json({ limit: '100kb', inflate: false }));
  app.use((error, _req, res, _next) => {
    res.status(error.status ?? 400).json({
      code: error.status === 413 ? 'body_too_large' : 'invalid_request_body',
    });
  });
}
